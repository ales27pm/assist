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

        // Apple network readers remain behind the same exact tactile preview.
        // No location permission is requested: coordinates are explicit data.
        let apple = AssistApplePlaces.shared
        for call in [
            AssistDeviceToolCall(name: .maps_search, arguments: ["query": .string("Bibliothèque Québec"), "limit": .number(1)]),
            AssistDeviceToolCall(name: .maps_directions, arguments: ["origin_latitude": .number(46.8139), "origin_longitude": .number(-71.208), "destination_latitude": .number(46.8), "destination_longitude": .number(-71.3), "transport": .string("walking")]),
            AssistDeviceToolCall(name: .weather_forecast, arguments: ["latitude": .number(46.8139), "longitude": .number(-71.208), "unit": .string("celsius"), "hourly_count": .number(0), "daily_count": .number(0)]),
        ] {
            let appleRecorder = ActivityRecorder()
            let countBefore = apple.calls.count
            let appleTask = Task {
                try await broker.perform(call: call, requestId: "apple-consent", admission: AssistAgentAdmission()) { json in
                    Task { await appleRecorder.append(json) }
                }
            }
            let proposed = try transaction(try jsonObject(await appleRecorder.next()))
            try expect(apple.calls.count == countBefore, "no Apple request before tactile consent")
            let fields = proposed["preview"] as? [[String: String]] ?? []
            try expect(fields.contains { $0["label"] == "Envoi à" && ($0["value"]?.contains("Apple") ?? false) }, "preview names external Apple destination")
            if call.name == .maps_directions {
                try expect(fields.contains { $0["label"] == "Départ transmis" && $0["value"] == "46.8139, -71.208" }, "exact origin is previewed")
                try expect(fields.contains { $0["label"] == "Arrivée transmise" && $0["value"] == "46.8, -71.3" }, "exact destination is previewed")
            }
            let accepted = try broker.confirm(transactionId: string(proposed, "id"), token: string(proposed, "confirmationToken"))
            try expect(accepted, "Apple reader requires its one-shot token")
            _ = await appleRecorder.next()
            let result = try await appleTask.value
            let terminal = try transaction(try jsonObject(await appleRecorder.next()))
            try expect(apple.calls.last == call.name.rawValue && apple.calls.count == countBefore + 1, "correct compiled Apple executor invoked once")
            try expect(terminal["status"] as? String == "success", "validated Apple result receives success")
            if call.name == .weather_forecast {
                try expect(terminal["weather"] as? [String: Any] != nil, "weather activity retains its native forecast")
                try expect(result.objectDictionary?["requestId"]?.stringValue == proposed["id"] as? String, "weather operation identity bound to receipt")
            }
        }
        let cancelAppleRecorder = ActivityRecorder()
        apple.deferResult = true
        let cancelAppleTask = Task {
            try await broker.perform(call: .init(name: .maps_search, arguments: ["query": .string("Québec"), "limit": .number(1)]),
                                     requestId: "apple-cancel", admission: AssistAgentAdmission()) { json in
                Task { await cancelAppleRecorder.append(json) }
            }
        }
        let cancelApplePreview = try transaction(try jsonObject(await cancelAppleRecorder.next()))
        _ = try broker.confirm(transactionId: string(cancelApplePreview, "id"), token: string(cancelApplePreview, "confirmationToken"))
        _ = await cancelAppleRecorder.next()
        broker.cancelPending()
        try await rejects({ _ = try await cancelAppleTask.value }, "cancelled Apple reader unexpectedly succeeded")
        let cancelAppleTerminal = try transaction(try jsonObject(await cancelAppleRecorder.next()))
        try expect(cancelAppleTerminal["status"] as? String == "cancelled" && apple.cancelCount == 1, "cancellation reaches owned Apple request")
        apple.deferResult = false

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

        // The actual new31 dispatcher, closed leaf policies and coordinator
        // run here. Only AlarmManager/Translation/UIKit owners are scripted.
        try expect(AssistToolName.allCases.count == 31, "all native29 tools compile into the shared closed registry")
        let alarms = AssistAlarms.shared
        let timerCall = AssistDeviceToolCall(name: .alarm_create, arguments: [
            "kind": .string("timer"), "title": .string("Thé à infuser"), "duration_seconds": .number(120),
        ])
        for scenario in [
            (AssistAlarmPolicy.Status.succeeded, AssistAlarmPolicy.Code.ok, "success"),
            (.failed_safe, .permission_denied, "failed_safe"),
            (.outcome_unknown, .outcome_unknown, "outcome_unknown"),
        ] {
            alarms.status = scenario.0; alarms.code = scenario.1
            let scenarioURL = root.appendingPathComponent("alarm-\(scenario.2).json")
            alarms.journalURL = scenarioURL; alarms.sawDurableSubmission = false
            let scenarioBroker = AssistToolTransactionCoordinator(gateway: gateway, journalURL: scenarioURL, foreground: { true })
            let scenarioRecorder = ActivityRecorder()
            let countBefore = alarms.calls.count
            let scenarioTask = Task {
                try await scenarioBroker.perform(call: timerCall, requestId: "alarm-\(scenario.2)", admission: AssistAgentAdmission()) { json in
                    Task { await scenarioRecorder.append(json) }
                }
            }
            let preview = try transaction(try jsonObject(await scenarioRecorder.next()))
            let fields = preview["preview"] as? [[String: String]] ?? []
            try expect(alarms.calls.count == countBefore, "alarm service not admitted before exact tactile consent")
            try expect(fields.contains { $0["label"] == "Titre" && $0["value"] == "Thé à infuser" }, "alarm preview retains exact frozen title")
            try expect(fields.contains { $0["label"] == "Durée (secondes)" && $0["value"] == "120" }, "alarm preview retains exact frozen duration")
            let operationID = try string(preview, "id")
            let accepted = try scenarioBroker.confirm(transactionId: operationID, token: string(preview, "confirmationToken"))
            try expect(accepted, "alarm consumes its exact one-shot consent")
            _ = await scenarioRecorder.next() // executing
            if scenario.0 == .succeeded {
                let value = try await scenarioTask.value
                try expect(value.objectDictionary?["result_status"] == .string("succeeded"), "native ACK reaches bounded model result")
                try expect(value.objectDictionary?["appOwnedOnly"] == .bool(true), "model result preserves Assist ownership boundary")
            } else {
                try await rejects({ _ = try await scenarioTask.value }, "non-success alarm receipt was accepted")
            }
            let terminal = try transaction(try jsonObject(await scenarioRecorder.next()))
            try expect(terminal["status"] as? String == scenario.2, "alarm receipt maps to precise central terminal state")
            try expect(alarms.calls.count == countBefore + 1 && alarms.sawDurableSubmission,
                       "central durable submission exists before the one alarm service invocation")
            let nativePayload = try plainObject(alarms.calls.last!)
            try expect(nativePayload["alarm_id"] as? String == operationID && nativePayload["operationId"] as? String == operationID &&
                       nativePayload["requestId"] as? String == operationID,
                       "host operation identity owns create ID; model never supplies it")
            try expect(nativePayload["title"] as? String == "Thé à infuser" && nativePayload["duration_seconds"] as? Int == 120,
                       "executed alarm payload exactly matches consent preview")
            let journalRows = try rows(try jsonObject(scenarioBroker.snapshotOperations()))
            if scenario.0 == .failed_safe {
                try expect(journalRows.isEmpty && terminal["receipt"] == nil,
                           "validated pre-submission rejection leaves no fabricated uncertain receipt")
                let reloadedRows = try rows(try jsonObject(AssistToolOperationJournal(url: scenarioURL).snapshotJSON()))
                try expect(reloadedRows.isEmpty, "safe rejection is durably removed across restart")
            } else {
                try expect(journalRows.count == 1 && journalRows[0]["operationId"] as? String == operationID &&
                           journalRows[0]["status"] as? String == scenario.2,
                           "success or uncertainty is durably tied to exact host identity")
            }
            let replay = try scenarioBroker.confirm(transactionId: operationID, token: string(preview, "confirmationToken"))
            try expect(!replay && alarms.calls.count == countBefore + 1, "consumed alarm consent cannot repeat a side effect")
        }
        alarms.journalURL = nil; alarms.status = .succeeded; alarms.code = .ok

        // Closing the tactile proposal is a pre-admission cancellation: no
        // service invocation, permission prompt or write metadata may appear.
        let cancelledAlarmURL = root.appendingPathComponent("alarm-cancel-before-consent.json")
        let cancelledAlarmBroker = AssistToolTransactionCoordinator(gateway: gateway, journalURL: cancelledAlarmURL, foreground: { true })
        let cancelledAlarmRecorder = ActivityRecorder()
        let cancelledAlarmCount = alarms.calls.count
        let cancelledAlarmTask = Task {
            try await cancelledAlarmBroker.perform(call: timerCall, requestId: "alarm-no-consent", admission: AssistAgentAdmission()) { json in
                Task { await cancelledAlarmRecorder.append(json) }
            }
        }
        let cancelledProposal = try transaction(try jsonObject(await cancelledAlarmRecorder.next()))
        cancelledAlarmBroker.cancelPending()
        try await rejects({ _ = try await cancelledAlarmTask.value }, "alarm executed after proposal cancellation")
        let cancelledTerminal = try transaction(try jsonObject(await cancelledAlarmRecorder.next()))
        try expect(cancelledTerminal["status"] as? String == "cancelled" && alarms.calls.count == cancelledAlarmCount,
                   "pre-confirmation cancellation admits no alarm service")
        try expect(!FileManager.default.fileExists(atPath: cancelledAlarmURL.path), "unaccepted alarm leaves no write journal file")
        let staleConsent = try cancelledAlarmBroker.confirm(transactionId: string(cancelledProposal, "id"), token: string(cancelledProposal, "confirmationToken"))
        try expect(!staleConsent, "dismissed alarm preview cannot be confirmed later")

        // List remains consented without creating mutation metadata; opening a
        // panel or compiling a capability never invokes this explicit action.
        let listed = try await performConfirmed(.init(name: .alarm_list, arguments: [:]), requestId: "alarm-list", gateway: gateway, journalRoot: root)
        try expect(listed.objectDictionary?["appOwnedOnly"] == .bool(true), "explicit list returns app-owned results only")

        // Replacing an owned ID previews the destructive first half explicitly.
        let ownedID = UUID().uuidString
        let updateFields = AssistCapabilityActions.preview(.init(name: .alarm_update, arguments: [
            "alarm_id": .string(ownedID), "kind": .string("timer"), "title": .string("Thé"), "duration_seconds": .number(60),
        ]))
        try expect(updateFields.contains { $0.label == "Alarme Assist" && $0.value == ownedID }, "update preview includes exact owned identifier")
        try expect(updateFields.contains { $0.label == "Remplacement" && $0.value.contains("annulée") }, "update preview explains cancel-then-replace uncertainty")

        // Capacity cannot silently discard unresolved operations. Known success
        // metadata may expire, while 100 unknowns close admission to new writes.
        let retentionURL = root.appendingPathComponent("retention.json")
        let retention = try AssistToolOperationJournal(url: retentionURL)
        let retainedUnknown = UUID()
        try retention.submit(operationId: retainedUnknown, tool: .alarm_create)
        try retention.markOutcomeUnknown(operationId: retainedUnknown)
        let disposableSuccess = UUID()
        try retention.submit(operationId: disposableSuccess, tool: .alarm_create)
        try retention.completeSuccess(operationId: disposableSuccess)
        for _ in 0..<98 {
            let id = UUID(); try retention.submit(operationId: id, tool: .alarm_create); try retention.completeSuccess(operationId: id)
        }
        let added = UUID(); try retention.submit(operationId: added, tool: .alarm_create); try retention.completeSuccess(operationId: added)
        let retainedRows = try rows(try jsonObject(retention.snapshotJSON()))
        try expect(retainedRows.count == 100 && retainedRows.contains { $0["operationId"] as? String == retainedUnknown.uuidString },
                   "journal capacity retains oldest unresolved alarm outcome")
        try expect(!retainedRows.contains { $0["operationId"] as? String == disposableSuccess.uuidString },
                   "journal capacity evicts known success metadata instead")
        let fullURL = root.appendingPathComponent("full-unknown.json")
        let fullJournal = try AssistToolOperationJournal(url: fullURL)
        for _ in 0..<100 {
            let id = UUID(); try fullJournal.submit(operationId: id, tool: .alarm_create); try fullJournal.markOutcomeUnknown(operationId: id)
        }
        let previousUnknowns = fullJournal.snapshotJSON()
        try await rejects({ try fullJournal.submit(operationId: UUID(), tool: .alarm_create) }, "new write admitted by full unresolved journal")
        try expect(fullJournal.snapshotJSON() == previousUnknowns, "failed capacity admission preserves in-memory unknown metadata")
        let diskUnknowns = try AssistToolOperationJournal(url: fullURL).snapshotJSON()
        try expect(diskUnknowns == previousUnknowns, "failed capacity admission preserves durable unknown metadata")
        let fullBroker = AssistToolTransactionCoordinator(gateway: gateway, journalURL: fullURL, foreground: { true })
        let fullRecorder = ActivityRecorder()
        let fullCount = alarms.calls.count
        let fullTask = Task {
            try await fullBroker.perform(call: timerCall, requestId: "alarm-journal-full", admission: AssistAgentAdmission()) { json in
                Task { await fullRecorder.append(json) }
            }
        }
        let fullPreview = try transaction(try jsonObject(await fullRecorder.next()))
        try await rejects({ _ = try fullBroker.confirm(transactionId: string(fullPreview, "id"), token: string(fullPreview, "confirmationToken")) },
                          "full unknown journal allowed confirmation submission")
        fullBroker.cancelPending()
        try await rejects({ _ = try await fullTask.value }, "full journal proposal executed")
        _ = await fullRecorder.next()
        try expect(alarms.calls.count == fullCount, "journal capacity failure never reaches concrete alarm service")

        // Interactive Apple UIs may create durable effects. Their public
        // effect remains interactive, but lost replies are never safe retries.
        let documents = AssistDocumentActions.shared
        let documentID = "b0123456-1234-4234-8234-123456789012"
        let interactiveCalls: [AssistDeviceToolCall] = [
            .init(name: .document_scan, arguments: ["max_pages": .number(8)]),
            .init(name: .document_export_pdf, arguments: ["inbox_id": .string(documentID), "filename": .string("chosen.pdf")]),
            .init(name: .message_compose, arguments: ["channel": .string("email"), "recipients": .string("alexis@example.com"), "subject": .string("Exact subject"), "body": .string("Exact message")]),
        ]
        let scenarios: [(AssistDocumentActions.Mode, String, Bool)] = [
            (.succeeded, "success", false), (.nativeUnknown, "outcome_unknown", false),
            (.malformed, "outcome_unknown", false), (.deferred, "outcome_unknown", false),
            (.deferred, "outcome_unknown", true), (.userCancelled, "cancelled", false),
            (.preSubmissionError, "failed_safe", false),
        ]
        for call in interactiveCalls {
            try expect(call.name.effect == .interactive, "durable receipt does not mislabel interactive UI as an automatic write")
            for (number, scenario) in scenarios.enumerated() {
                documents.reset(); documents.mode = scenario.0
                let url = root.appendingPathComponent("interactive-\(call.name.rawValue)-\(number).json")
                documents.journalURL = url
                let coordinator = AssistToolTransactionCoordinator(gateway: gateway, journalURL: url, foreground: { true })
                let recorder = ActivityRecorder(); let previousCount = documents.calls.count
                let task = Task {
                    try await coordinator.perform(call: call, requestId: "interactive-fixture", admission: AssistAgentAdmission()) { value in
                        Task { await recorder.append(value) }
                    }
                }
                let proposal = try transaction(try jsonObject(await recorder.next()))
                try expect(documents.calls.count == previousCount, "interactive service receives no call before consent")
                let operationID = try string(proposal, "id")
                let accepted = try coordinator.confirm(transactionId: operationID, token: string(proposal, "confirmationToken"))
                try expect(accepted, "interactive mutation consumes exact broker consent")
                _ = await recorder.next()
                await documents.waitForStart()
                try expect(documents.calls.count == previousCount + 1 && documents.sawDurableSubmission,
                           "interactive durable journal precedes the concrete executor handoff")
                if scenario.0 == .deferred {
                    if scenario.2 { task.cancel() } else { coordinator.cancelPending() }
                }
                if scenario.0 == .succeeded {
                    let result = try await task.value
                    try expect(result.objectDictionary?["result_status"]?.stringValue != nil, "validated interactive receipt reaches the model")
                    if call.name == .message_compose {
                        try expect(result.objectDictionary?["deliveryVerified"] == .bool(false), "user queued compose receipt never verifies delivery")
                    }
                } else {
                    try await rejects({ _ = try await task.value }, "interactive non-success was released as success")
                }
                let terminal = try transaction(try jsonObject(await recorder.next()))
                try expect(terminal["status"] as? String == scenario.1,
                           "interactive native uncertainty, safe rejection and explicit user cancel retain distinct terminal states")
                let recovered = try rows(try jsonObject(AssistToolOperationJournal(url: url).snapshotJSON()))
                if ["failed_safe", "cancelled"].contains(scenario.1) {
                    try expect(recovered.isEmpty && terminal["receipt"] == nil, "only proven safe native rejection/cancel removes interactive admission across restart")
                } else {
                    try expect(recovered.count == 1 && recovered[0]["status"] as? String == scenario.1 && recovered[0]["tool"] as? String == call.name.rawValue,
                               "interactive success or uncertainty survives process recovery under exact tool identity")
                }
                let contents = try String(contentsOf: url, encoding: .utf8)
                try expect(!contents.contains("alexis@example.com") && !contents.contains("Exact message") && !contents.contains(documentID),
                           "interactive journal contains no recipients, body or document identifier")
                if scenario.0 == .deferred {
                    try documents.deliverLateSuccess(); try documents.deliverLateSuccess()
                    let recoveredAgain = try rows(try jsonObject(coordinator.snapshotOperations()))
                    try expect(recoveredAgain.first?["status"] as? String == "outcome_unknown", "late or duplicate callback cannot turn uncertainty into invented success")
                }
                let replay = try coordinator.confirm(transactionId: operationID, token: string(proposal, "confirmationToken"))
                try expect(!replay && documents.calls.count == previousCount + 1, "uncertain interactive effect is never automatically repeated")
            }

            // Deterministically cancel on the same MainActor turn as confirm,
            // before the resumed perform task can enter the native dispatcher.
            documents.reset(); documents.mode = .deferred
            let url = root.appendingPathComponent("interactive-pre-handoff-\(call.name.rawValue).json")
            documents.journalURL = url
            let coordinator = AssistToolTransactionCoordinator(gateway: gateway, journalURL: url, foreground: { true })
            let recorder = ActivityRecorder(); let previousCount = documents.calls.count
            let task = Task {
                try await coordinator.perform(call: call, requestId: "cancel-before-handoff", admission: AssistAgentAdmission()) { value in
                    Task { await recorder.append(value) }
                }
            }
            let proposal = try transaction(try jsonObject(await recorder.next()))
            let accepted = try coordinator.confirm(transactionId: string(proposal, "id"), token: string(proposal, "confirmationToken"))
            try expect(accepted, "pre-handoff cancellation fixture first records consent")
            task.cancel()
            try await rejects({ _ = try await task.value }, "cancelled pre-handoff interactive task executed")
            var terminal = try transaction(try jsonObject(await recorder.next()))
            if terminal["status"] as? String == "executing" { terminal = try transaction(try jsonObject(await recorder.next())) }
            try expect(documents.calls.count == previousCount && terminal["status"] as? String == "cancelled", "cancellation before actual executor invocation is a proven safe cancellation (tool \(call.name.rawValue), calls \(documents.calls.count - previousCount), status \(terminal["status"] ?? "missing"))")
            let recovered = try rows(try jsonObject(AssistToolOperationJournal(url: url).snapshotJSON()))
            try expect(recovered.isEmpty, "provisional admission is safely removed when no executor was invoked")
        }
        documents.journalURL = nil
        let compose = interactiveCalls[2]
        try expect(AssistCapabilityActions.callbackFailure(AssistToolTransactionError.outcomeUnknown as NSError, call: compose) == .outcomeUnknown,
                   "typed NSError uncertainty survives native callback bridging")
        try expect(AssistCapabilityActions.callbackFailure(AssistDocumentActionsPolicy.failure(.outcomeUnknown), call: compose) == .outcomeUnknown,
                   "document-owner uncertainty survives native callback bridging")
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
