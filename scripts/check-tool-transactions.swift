import Foundation

private actor ActivityRecorder {
    private var values: [String] = []
    private var waiter: CheckedContinuation<String, Never>?

    func append(_ value: String) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: value)
        } else {
            values.append(value)
        }
    }

    func next() async -> String {
        if !values.isEmpty { return values.removeFirst() }
        return await withCheckedContinuation { waiter = $0 }
    }

    func count() -> Int { values.count }
}

@main
struct ToolTransactionChecks {
    @MainActor
    static func main() async throws {
        var checks = 0
        func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
            guard condition() else { throw NSError(domain: "Assist.ToolTransactionChecks", code: 1,
                                                    userInfo: [NSLocalizedDescriptionKey: "FAIL: \(message)"]) }
            checks += 1
        }
        func rejects(_ operation: () async throws -> Void, _ message: String) async throws {
            do { try await operation() }
            catch { checks += 1; return }
            throw NSError(domain: "Assist.ToolTransactionChecks", code: 6,
                          userInfo: [NSLocalizedDescriptionKey: "FAIL: \(message)"])
        }

        /// Drives the public broker API through preview, one confirmation,
        /// execution and terminal receipt. The fake gateway records the native
        /// call, so this exercises dispatch rather than a private helper.
        func performConfirmed(
            _ call: AssistDeviceToolCall, requestId: String, gateway: AssistDeviceCapabilities, journalRoot: URL
        ) async throws -> AssistToolValue {
            let recorder = ActivityRecorder()
            let journalURL = journalRoot.appendingPathComponent("dispatch-\(UUID().uuidString).json")
            let broker = AssistToolTransactionCoordinator(gateway: gateway, journalURL: journalURL, foreground: { true })
            let task = Task {
                try await broker.perform(call: call, requestId: requestId, admission: AssistAgentAdmission()) { json in
                    Task { await recorder.append(json) }
                }
            }
            let preview = try transaction(try jsonObject(await recorder.next()))
            guard try broker.confirm(transactionId: string(preview, "id"), token: string(preview, "confirmationToken")) else {
                throw NSError(domain: "Assist.ToolTransactionChecks", code: 7,
                              userInfo: [NSLocalizedDescriptionKey: "FAIL: dispatch confirmation was refused"])
            }
            let executing = try transaction(try jsonObject(await recorder.next()))
            guard executing["status"] as? String == "executing", executing["revision"] as? Int == 2 else {
                throw NSError(domain: "Assist.ToolTransactionChecks", code: 8,
                              userInfo: [NSLocalizedDescriptionKey: "FAIL: dispatch did not execute"])
            }
            let result = try await task.value
            let terminal = try transaction(try jsonObject(await recorder.next()))
            guard terminal["status"] as? String == "success", terminal["revision"] as? Int == 3 else {
                throw NSError(domain: "Assist.ToolTransactionChecks", code: 9,
                              userInfo: [NSLocalizedDescriptionKey: "FAIL: dispatch did not finish"])
            }
            return result
        }

        /// A post-submission write with a malformed native receipt must become
        /// outcome_unknown. It is intentionally not retried or downgraded to a
        /// safe failure because the native side effect may already exist.
        func partialWriteOutcome(
            _ call: AssistDeviceToolCall, requestId: String, gateway: AssistDeviceCapabilities, journalRoot: URL
        ) async throws -> [String: Any] {
            let recorder = ActivityRecorder()
            let journalURL = journalRoot.appendingPathComponent("partial-\(UUID().uuidString).json")
            let broker = AssistToolTransactionCoordinator(gateway: gateway, journalURL: journalURL, foreground: { true })
            let task = Task {
                try await broker.perform(call: call, requestId: requestId, admission: AssistAgentAdmission()) { json in
                    Task { await recorder.append(json) }
                }
            }
            let preview = try transaction(try jsonObject(await recorder.next()))
            guard try broker.confirm(transactionId: string(preview, "id"), token: string(preview, "confirmationToken")) else {
                throw NSError(domain: "Assist.ToolTransactionChecks", code: 11,
                              userInfo: [NSLocalizedDescriptionKey: "FAIL: partial receipt confirmation was refused"])
            }
            _ = try transaction(try jsonObject(await recorder.next()))
            try await rejects({ _ = try await task.value }, "partial native receipt unexpectedly succeeded")
            return try transaction(try jsonObject(await recorder.next()))
        }

        // Permission decisions are pure: checking a state cannot prompt iOS.
        try expect(AssistToolTransactionPermit.isGranted(capability: "contacts", status: "limited"),
                   "limited contacts are usable")
        try expect(AssistToolTransactionPermit.isGranted(capability: "location", status: "authorizedWhenInUse"),
                   "foreground location is usable")
        try expect(!AssistToolTransactionPermit.isGranted(capability: "location", status: "denied"),
                   "denied location is never usable")
        try expect(AssistToolTransactionPermit.needsPermission(capability: "notifications", status: "notDetermined"),
                   "notifications need an explicit OS request")
        try expect(!AssistToolTransactionPermit.needsPermission(capability: "none", status: "notRequired"),
                   "permission-free tools do not fabricate a prompt")

        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("assist-tool-transactions-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let journalURL = root.appendingPathComponent("journal.json", isDirectory: false)

        // A submitted write is intentionally invisible as success. After a
        // process restart it becomes outcome_unknown, never a retry candidate.
        let submittedID = UUID()
        let submitted = try AssistToolOperationJournal(url: journalURL)
        try submitted.submit(operationId: submittedID, tool: .calendar_create)
        let beforeRestart = submitted.snapshotJSON()
        try expect(!beforeRestart.contains(submittedID.uuidString), "submitted operation has no receipt before reconciliation")

        let reconciled = try AssistToolOperationJournal(url: journalURL)
        let reconciledJSON = reconciled.snapshotJSON()
        let reconciledObject = try jsonObject(reconciledJSON)
        let reconciledRows = try rows(reconciledObject)
        try expect(reconciledRows.count == 1, "restart yields one reconciled receipt")
        try expect(reconciledRows[0]["operationId"] as? String == submittedID.uuidString,
                   "reconciliation keeps only the opaque operation ID")
        try expect(reconciledRows[0]["tool"] as? String == "calendar_create", "tool identity is retained")
        try expect(reconciledRows[0]["status"] as? String == "outcome_unknown", "submitted is never reported as failed or success")
        try expect((reconciledRows[0]["summary"] as? [[String: Any]])?.first?["value"] as? String == "outcome_unknown",
                   "unknown journal summary is static metadata")
        try expect(!reconciledJSON.contains("title") && !reconciledJSON.contains("location") && !reconciledJSON.contains("contact"),
                   "journal JSON has no user content fields")

        let successID = UUID()
        try reconciled.submit(operationId: successID, tool: .notification_schedule)
        try reconciled.completeSuccess(operationId: successID)
        let successJSON = reconciled.snapshotJSON()
        let successRows = try rows(try jsonObject(successJSON))
        try expect(successRows.count == 2, "known and unknown receipts coexist")
        try expect(successRows.contains(where: { ($0["operationId"] as? String) == successID.uuidString &&
            ($0["status"] as? String) == "success" }), "success receipt is explicit")

        // Snapshot is memory-only: deleting the backing file after initialization
        // must not alter the already-loaded receipt or trigger a new file read.
        try FileManager.default.removeItem(at: journalURL)
        let detachedRows = try rows(try jsonObject(reconciled.snapshotJSON()))
        try expect(detachedRows.count == 2, "snapshot needs neither phone access nor journal I/O")

        // The broker asks for a fresh token even for a read, then accepts it
        // once only before a bounded, projected native result is released.
        let gateway = AssistDeviceCapabilities()
        let brokerJournal = root.appendingPathComponent("broker-journal.json", isDirectory: false)
        let broker = AssistToolTransactionCoordinator(gateway: gateway, journalURL: brokerJournal, foreground: { true })
        let recorder = ActivityRecorder()
        let deviceCall = AssistDeviceToolCall(name: .device_capabilities, arguments: [:])
        let readTask = Task {
            try await broker.perform(call: deviceCall, requestId: "read-fixture", admission: AssistAgentAdmission()) { json in
                Task { await recorder.append(json) }
            }
        }
        let preview = try jsonObject(await recorder.next())
        let previewTransaction = try transaction(preview)
        let previewID = try string(previewTransaction, "id")
        let token = try string(previewTransaction, "confirmationToken")
        try expect(previewTransaction["status"] as? String == "awaiting_confirmation" &&
                   previewTransaction["revision"] as? Int == 1, "read waits for tactile confirmation at revision one")
        let accepted = try broker.confirm(transactionId: previewID, token: token)
        let replay = try broker.confirm(transactionId: previewID, token: token)
        try expect(accepted, "valid token is accepted once")
        try expect(!replay, "token cannot be replayed")
        let deviceResult = try await readTask.value
        try expect(deviceResult.objectDictionary?["capabilities"]?.objectDictionary?["contacts"]?.stringValue == "authorized",
                   "native result is projected through the closed value contract")
        let executing = try transaction(try jsonObject(await recorder.next()))
        let completed = try transaction(try jsonObject(await recorder.next()))
        try expect(executing["status"] as? String == "executing" && executing["confirmationToken"] == nil &&
                   executing["revision"] as? Int == 2, "execution activity advances revision and has no reusable token")
        try expect(completed["status"] as? String == "success" && completed["receipt"] != nil &&
                   completed["revision"] as? Int == 3, "success activity advances revision with a native receipt")

        // A permission check returns a terminal bounded result without a token,
        // confirmation wait, callback invocation, or implicit system prompt.
        gateway.permission = "denied"
        let deniedRecorder = ActivityRecorder()
        let denied = try await broker.perform(
            call: .init(name: .contacts_search, arguments: ["query": .string("Alice"), "limit": .number(1)]),
            requestId: "permission-fixture", admission: AssistAgentAdmission()
        ) { json in
            Task { await deniedRecorder.append(json) }
        }
        try expect(denied.objectDictionary?["status"]?.stringValue == "permission_required" &&
                   denied.objectDictionary?["capability"]?.stringValue == "contacts", "permission is a terminal native status")
        let permissionActivity = try transaction(try jsonObject(await deniedRecorder.next()))
        try expect(permissionActivity["status"] as? String == "awaiting_permission" &&
                   permissionActivity["confirmationToken"] == nil, "missing permission has no confirmation token")
        try expect(!gateway.contactsWasInvoked, "permission denial never reaches the contacts gateway")

        // An interaction whose native callback never arrives is released by the
        // broker cancellation path. A deliberately late callback is ignored by
        // the one-shot gate rather than resuming the continuation twice.
        gateway.permission = "authorized"
        let interactionRecorder = ActivityRecorder()
        let interactionTask = Task {
            try await broker.perform(call: .init(name: .photo_select, arguments: [:]), requestId: "cancel-fixture",
                                     admission: AssistAgentAdmission()) { json in
                Task { await interactionRecorder.append(json) }
            }
        }
        let interactionPreview = try transaction(try jsonObject(await interactionRecorder.next()))
        try expect(interactionPreview["revision"] as? Int == 1, "interaction preview starts at revision one")
        let interactionAccepted = try broker.confirm(transactionId: try string(interactionPreview, "id"),
                                                     token: try string(interactionPreview, "confirmationToken"))
        try expect(interactionAccepted, "interaction confirmation succeeds")
        let interactionExecuting = try transaction(try jsonObject(await interactionRecorder.next()))
        try expect(interactionExecuting["status"] as? String == "executing" && interactionExecuting["revision"] as? Int == 2,
                   "interaction execution advances revision")
        broker.cancelPending()
        try await rejects({ _ = try await interactionTask.value }, "cancelled interaction unexpectedly succeeded")
        let interactionCancelled = try transaction(try jsonObject(await interactionRecorder.next()))
        try expect(interactionCancelled["status"] as? String == "cancelled" && interactionCancelled["revision"] as? Int == 3,
                   "cancelled interaction produces the terminal third revision")
        try expect(gateway.interactionCancelCount == 1, "broker cancellation reaches the owned native interaction")
        gateway.deliverLatePhotoResult()
        try expect(gateway.interactionCancelCount == 1, "late callback does not reopen or double-resume the interaction")

        // A cancellation while permission status is suspended must be observed
        // immediately after the await, before any preview/token or contacts I/O.
        gateway.deferPermission = true
        let suspendedRecorder = ActivityRecorder()
        let suspendedTask = Task {
            try await broker.perform(
                call: .init(name: .contacts_search, arguments: ["query": .string("Alice"), "limit": .number(1)]),
                requestId: "permission-cancel-fixture", admission: AssistAgentAdmission()
            ) { json in
                Task { await suspendedRecorder.append(json) }
            }
        }
        await gateway.waitForPermissionCheck()
        suspendedTask.cancel()
        gateway.releasePermissionCheck()
        try await rejects({ _ = try await suspendedTask.value }, "cancelled permission preflight unexpectedly succeeded")
        let suspendedActivityCount = await suspendedRecorder.count()
        try expect(suspendedActivityCount == 0, "cancelled permission preflight emits no preview or token")
        try expect(!gateway.contactsWasInvoked, "cancelled permission preflight makes no contacts call")

        // Every one of the 13 closed tool names reaches its intended gateway
        // path. The three legacy JSON writers are then inspected below: model
        // snake_case never leaks into EventKit/notification payloads.
        gateway.permission = "authorized"
        gateway.deferPermission = false
        let formatter = ISO8601DateFormatter()
        let start = formatter.string(from: Date().addingTimeInterval(120))
        let end = formatter.string(from: Date().addingTimeInterval(3_720))
        let due = formatter.string(from: Date().addingTimeInterval(7_200))
        let fireAt = formatter.string(from: Date().addingTimeInterval(10_800))
        _ = try await performConfirmed(
            .init(name: .contacts_search, arguments: ["query": .string("Alice"), "limit": .number(1)]),
            requestId: "dispatch-contacts", gateway: gateway, journalRoot: root
        )
        _ = try await performConfirmed(
            .init(name: .calendar_list, arguments: ["start_iso": .string(start), "end_iso": .string(end), "limit": .number(1)]),
            requestId: "dispatch-calendar-list", gateway: gateway, journalRoot: root
        )
        _ = try await performConfirmed(
            .init(name: .calendar_create, arguments: [
                "title": .string("Réunion"), "start_iso": .string(start), "end_iso": .string(end),
                "notes": .string("Préparer"), "location": .string("Bureau"),
            ]), requestId: "dispatch-calendar-create", gateway: gateway, journalRoot: root
        )
        _ = try await performConfirmed(
            .init(name: .reminders_list, arguments: [
                "start_iso": .string(start), "end_iso": .string(end), "include_completed": .bool(true), "limit": .number(1),
            ]), requestId: "dispatch-reminders-list", gateway: gateway, journalRoot: root
        )
        _ = try await performConfirmed(
            .init(name: .reminder_create, arguments: ["title": .string("Appeler"), "due_iso": .string(due), "notes": .string("Avant midi")]),
            requestId: "dispatch-reminder-create", gateway: gateway, journalRoot: root
        )
        _ = try await performConfirmed(.init(name: .location_current, arguments: [:]), requestId: "dispatch-location", gateway: gateway, journalRoot: root)
        _ = try await performConfirmed(.init(name: .camera_capture, arguments: [:]), requestId: "dispatch-camera", gateway: gateway, journalRoot: root)
        _ = try await performConfirmed(
            .init(name: .notification_schedule, arguments: ["title": .string("Titre"), "body": .string("Corps"), "fire_at": .string(fireAt)]),
            requestId: "dispatch-notification", gateway: gateway, journalRoot: root
        )
        _ = try await performConfirmed(.init(name: .biometrics_status, arguments: [:]), requestId: "dispatch-biometric-status", gateway: gateway, journalRoot: root)
        _ = try await performConfirmed(
            .init(name: .biometrics_authenticate, arguments: ["reason": .string("Confirmer l’action")]),
            requestId: "dispatch-biometric-auth", gateway: gateway, journalRoot: root
        )
        _ = try await performConfirmed(.init(name: .device_capabilities, arguments: [:]), requestId: "dispatch-capabilities", gateway: gateway, journalRoot: root)
        _ = try await performConfirmed(
            .init(name: .native_boundary, arguments: ["feature": .string("sms")]),
            requestId: "dispatch-boundary", gateway: gateway, journalRoot: root
        )
        let expectedCalls: Set<String> = [
            "contacts", "calendar_list", "calendar_create", "reminders_list", "reminder_create", "location",
            "photo_select", "camera_capture", "notification", "biometric_status", "biometric_auth", "capabilities", "boundary",
        ]
        try expect(expectedCalls.isSubset(of: Set(gateway.calls)), "all 13 closed tools dispatch to their intended native methods")

        let calendarPayload = try plainObject(try string(gateway.payloads, "calendar_create"))
        try expect(calendarPayload["startISO"] as? String == start && calendarPayload["endISO"] as? String == end &&
                   calendarPayload["calendarId"] as? String == "fixture", "calendar writer receives its explicit destination and legacy dates")
        try expect(calendarPayload["start_iso"] == nil && calendarPayload["end_iso"] == nil,
                   "calendar writer never receives model-facing date keys")
        let reminderPayload = try plainObject(try string(gateway.payloads, "reminder_create"))
        try expect(reminderPayload["dueISO"] as? String == due && reminderPayload["calendarId"] as? String == "fixture" &&
                   reminderPayload["due_iso"] == nil, "reminder due date is mapped into the native effect payload")
        let notificationPayload = try plainObject(try string(gateway.payloads, "notification"))
        try expect(notificationPayload["dateISO"] as? String == fireAt && notificationPayload["fire_at"] == nil &&
                   notificationPayload["id"] as? String != nil, "notification uses the host ID and legacy trigger key only")

        // A destination alone is not a native receipt. Both EventKit writes
        // require a bounded nonblank item ID before the broker can report
        // success; after journal submission, malformed receipts stay unknown.
        gateway.partialCalendarReceipt = true
        let partialCalendar = try await partialWriteOutcome(
            .init(name: .calendar_create, arguments: ["title": .string("Partiel"), "start_iso": .string(start), "end_iso": .string(end)]),
            requestId: "partial-calendar", gateway: gateway, journalRoot: root
        )
        try expect(partialCalendar["status"] as? String == "outcome_unknown" && partialCalendar["receipt"] != nil,
                   "calendar receipt without event ID is outcome_unknown")
        gateway.partialCalendarReceipt = false
        gateway.partialReminderReceipt = true
        let partialReminder = try await partialWriteOutcome(
            .init(name: .reminder_create, arguments: ["title": .string("Partiel"), "due_iso": .string(due)]),
            requestId: "partial-reminder", gateway: gateway, journalRoot: root
        )
        try expect(partialReminder["status"] as? String == "outcome_unknown" && partialReminder["receipt"] != nil,
                   "reminder receipt without reminder ID is outcome_unknown")
        gateway.partialReminderReceipt = false

        print("PASS: \(checks) tool-transaction journal and permit checks")
    }

    private static func jsonObject(_ json: String) throws -> [String: Any] {
        guard let object = try? plainObject(json),
              object["schemaVersion"] as? Int == 1 else {
            throw NSError(domain: "Assist.ToolTransactionChecks", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "invalid operation snapshot"])
        }
        return object
    }

    private static func plainObject(_ json: String) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else {
            throw NSError(domain: "Assist.ToolTransactionChecks", code: 10,
                          userInfo: [NSLocalizedDescriptionKey: "invalid JSON object"])
        }
        return object
    }

    private static func rows(_ object: [String: Any]) throws -> [[String: Any]] {
        guard let values = object["operations"] as? [[String: Any]] else {
            throw NSError(domain: "Assist.ToolTransactionChecks", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "missing operation rows"])
        }
        return values
    }

    private static func transaction(_ object: [String: Any]) throws -> [String: Any] {
        guard let transaction = object["transaction"] as? [String: Any],
              let revision = transaction["revision"] as? Int, revision >= 1 else {
            throw NSError(domain: "Assist.ToolTransactionChecks", code: 4,
                          userInfo: [NSLocalizedDescriptionKey: "invalid transaction activity"])
        }
        return transaction
    }

    private static func string(_ object: [String: Any], _ key: String) throws -> String {
        guard let value = object[key] as? String, !value.isEmpty else {
            throw NSError(domain: "Assist.ToolTransactionChecks", code: 5,
                          userInfo: [NSLocalizedDescriptionKey: "missing \(key)"])
        }
        return value
    }
}
