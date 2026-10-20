import CoreFoundation
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Stable, user-safe failures from the native transaction broker. Underlying
/// framework errors are deliberately not forwarded to a model or activity log.
enum AssistToolTransactionError: Error, LocalizedError, Sendable {
    case cancelled
    case confirmationExpired
    case confirmationUnavailable
    case inactive
    case busy
    case journalUnavailable
    case outcomeUnknown
    case executionFailed
    case invalidNativeResult
    case rejectedBeforeSubmission
    case cancelledBeforeSubmission

    var errorDescription: String? {
        switch self {
        case .cancelled: "L’action a été annulée avant son exécution."
        case .confirmationExpired: "La confirmation a expiré. Lance une nouvelle action."
        case .confirmationUnavailable: "Cette confirmation n’est plus disponible."
        case .inactive: "L’action exige que l’app soit ouverte au premier plan."
        case .busy: "Une autre action native attend déjà une confirmation."
        case .journalUnavailable: "La protection des opérations ne peut pas être enregistrée. Aucune écriture n’a été lancée."
        case .outcomeUnknown: "L’opération a peut-être été effectuée. Vérifie-la manuellement avant de recommencer."
        case .executionFailed: "L’action native n’a pas pu être confirmée en toute sécurité."
        case .invalidNativeResult: "Le résultat natif ne respecte pas le contrat attendu."
        case .rejectedBeforeSubmission: "L’action a été refusée avant toute modification. Vérifie l’autorisation et les données, puis décide d’une nouvelle demande."
        case .cancelledBeforeSubmission: "Le service natif a confirmé l’annulation sans modification."
        }
    }
}

struct AssistToolPreviewField: Encodable, Equatable, Sendable {
    let label: String
    let value: String
}

private enum AssistToolTransactionStatus: String, Sendable {
    case awaitingConfirmation = "awaiting_confirmation"
    case awaitingPermission = "awaiting_permission"
    case executing
    case success
    case failedSafe = "failed_safe"
    case outcomeUnknown = "outcome_unknown"
    case cancelled
}

private struct AssistToolReceipt: Encodable, Equatable, Sendable {
    let operationId: String
    let tool: String
    let status: String
    let completedAt: String
    let summary: [AssistToolPreviewField]
}

/// This envelope is the only activity data emitted by the broker. It never
/// includes raw gateway output, framework errors, paths, or journal contents.
private struct AssistToolActivityEnvelope: Encodable, Sendable {
    let schemaVersion = 1
    let requestId: String
    let transaction: Transaction

    struct Transaction: Encodable, Sendable {
        let id: String
        let revision: Int
        let tool: String
        let effect: String
        let title: String
        let status: String
        let preview: [AssistToolPreviewField]
        let confirmationToken: String?
        let capability: String?
        let receipt: AssistToolReceipt?
        let weather: AssistToolValue?
    }
}

private struct AssistToolJournalEntry: Codable, Equatable, Sendable {
    enum State: String, Codable, Sendable { case submitted, success, outcomeUnknown = "outcome_unknown" }
    let operationId: String
    let tool: String
    var state: State
    let submittedAt: String
    var completedAt: String?
}

private struct AssistToolJournalFile: Codable, Sendable {
    let schemaVersion: Int
    var operations: [AssistToolJournalEntry]
}

/// Main-actor one-shot bridge for legacy native callbacks. Cancellation and a
/// late framework callback race through this gate, so exactly one resumes the
/// async caller. The callback itself is already declared @MainActor.
@MainActor
private final class AssistToolCallbackGate {
    private var continuation: CheckedContinuation<String, Error>?
    private var finished = false

    func install(_ continuation: CheckedContinuation<String, Error>) -> Bool {
        guard !finished else {
            continuation.resume(throwing: AssistToolTransactionError.cancelled)
            return false
        }
        self.continuation = continuation
        return true
    }

    func succeed(_ value: String) { resolve(.success(value)) }
    func fail(_ error: Error) { resolve(.failure(error)) }
    @discardableResult
    func cancel() -> Bool { resolve(.failure(AssistToolTransactionError.cancelled)) }

    @discardableResult
    private func resolve(_ result: Result<String, Error>) -> Bool {
        guard !finished else { return false }
        finished = true
        let continuation = continuation
        self.continuation = nil
        continuation?.resume(with: result)
        return true
    }
}

/// Pure permission policy shared by the coordinator and its contract checks.
/// It intentionally makes no Framework call and never initiates a request.
enum AssistToolTransactionPermit {
    static func isGranted(capability: String, status: String) -> Bool {
        switch capability {
        case "contacts": return status == "authorized" || status == "limited"
        case "calendar", "reminders", "camera": return status == "authorized"
        case "location": return status == "authorizedAlways" || status == "authorizedWhenInUse"
        case "notifications": return status == "authorized" || status == "provisional" || status == "ephemeral"
        case "biometrics": return status == "available"
        case "none": return true
        default: return false
        }
    }

    static func needsPermission(capability: String, status: String) -> Bool {
        !isGranted(capability: capability, status: status)
    }
}

/// Durable write-operation metadata only. It never receives arguments,
/// previews, user text, contacts, coordinates, attachment URLs, or receipts.
/// A submission is written atomically before the native side effect starts.
final class AssistToolOperationJournal {
    private static let schemaVersion = 1
    private static let maximumOperations = 100
    private let url: URL
    private var operations: [AssistToolJournalEntry]

    init(url: URL) throws {
        self.url = url
        if FileManager.default.fileExists(atPath: url.path) {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode(AssistToolJournalFile.self, from: data)
            guard decoded.schemaVersion == Self.schemaVersion,
                  decoded.operations.count <= Self.maximumOperations else {
                throw AssistToolTransactionError.journalUnavailable
            }
            operations = decoded.operations
        } else {
            operations = []
        }

        // A process death after durable submission is never treated as a safe
        // failure. The effect may have reached EventKit/notifications already.
        var reconciled = false
        for index in operations.indices where operations[index].state == .submitted {
            operations[index].state = .outcomeUnknown
            operations[index].completedAt = Self.timestamp()
            reconciled = true
        }
        if reconciled { try persist() }
    }

    static func defaultURL() throws -> URL {
        guard let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw AssistToolTransactionError.journalUnavailable
        }
        let directory = root.appendingPathComponent("Assist", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("tool-operation-journal.json", isDirectory: false)
    }

    func submit(operationId: UUID, tool: AssistToolName) throws {
        let previous = operations
        operations.append(AssistToolJournalEntry(
            operationId: operationId.uuidString,
            tool: tool.rawValue,
            state: .submitted,
            submittedAt: Self.timestamp(),
            completedAt: nil
        ))
        if operations.count > Self.maximumOperations {
            // Never erase unresolved submissions to make space for new work.
            // Successful metadata can expire; uncertain outcomes require review.
            guard let disposable = operations.firstIndex(where: { $0.state == .success }) else {
                operations = previous
                throw AssistToolTransactionError.journalUnavailable
            }
            operations.remove(at: disposable)
        }
        do {
            try persist()
        } catch {
            // A failed pre-effect write must not leave an in-memory record that
            // could make a later confirmation appear durably submitted.
            operations = previous
            throw error
        }
    }

    func completeSuccess(operationId: UUID) throws {
        guard let index = operations.lastIndex(where: { $0.operationId == operationId.uuidString }) else {
            throw AssistToolTransactionError.journalUnavailable
        }
        operations[index].state = .success
        operations[index].completedAt = Self.timestamp()
        try persist()
    }

    /// Cancellation may clear the pending continuation after confirm() has
    /// journaled admission. Inspect durable ownership instead of that UI state.
    func hasSubmission(operationId: UUID) -> Bool {
        operations.contains { $0.operationId == operationId.uuidString }
    }

    /// Only a validated executor receipt proving no native submission may use this.
    func completeSafeRejection(operationId: UUID) throws {
        let previous = operations
        operations.removeAll { $0.operationId == operationId.uuidString }
        do { try persist() } catch { operations = previous; throw error }
    }

    func markOutcomeUnknown(operationId: UUID) throws {
        guard let index = operations.lastIndex(where: { $0.operationId == operationId.uuidString }) else {
            throw AssistToolTransactionError.journalUnavailable
        }
        operations[index].state = .outcomeUnknown
        operations[index].completedAt = Self.timestamp()
        try persist()
    }

    /// Serializes already-loaded metadata only. It never calls a device API or
    /// performs filesystem I/O, which keeps status inspection non-invasive.
    func snapshotJSON() -> String {
        let rows: [[String: Any]] = operations.compactMap { operation in
            guard operation.state == .success || operation.state == .outcomeUnknown,
                  let completedAt = operation.completedAt else { return nil }
            let state = operation.state == .success ? "success" : "outcome_unknown"
            return [
                "operationId": operation.operationId,
                "tool": operation.tool,
                "status": state,
                "completedAt": completedAt,
                // Deliberately static: a journal summary must never become a
                // second store for titles, locations, contacts, or coordinates.
                "summary": [["label": "Résultat", "value": state]],
            ]
        }
        let object: [String: Any] = ["schemaVersion": Self.schemaVersion, "operations": rows]
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else {
            return "{\"schemaVersion\":1,\"operations\":[]}"
        }
        return json
    }

    private func persist() throws {
        let data = try JSONEncoder().encode(AssistToolJournalFile(
            schemaVersion: Self.schemaVersion, operations: operations
        ))
        try data.write(to: url, options: .atomic)
    }

    private static func timestamp(_ date: Date = Date()) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}

@MainActor
final class AssistToolTransactionCoordinator {
    private static let confirmationTTL: TimeInterval = 120
    private static let maximumGatewayJSONBytes = 256 * 1_024

    private struct Pending {
        let id: UUID
        let token: UUID
        let requestId: String
        let call: AssistDeviceToolCall
        let preview: [AssistToolPreviewField]
        let capability: String?
        let destination: AssistDeviceCalendarDestination?
        let onActivity: @Sendable (String) -> Void
        var confirmationAccepted = false
        var continuation: CheckedContinuation<Void, Error>?
        var expiryTask: Task<Void, Never>?
    }

    private let gateway: AssistDeviceCapabilities
    private let applePlaces: AssistApplePlaces
    private let foreground: @MainActor () -> Bool
    private let journal: AssistToolOperationJournal?
    private var journalUnavailable = false
    private var pending: Pending?
    private var activeToolInteraction = false
    private var activeApplePlaces = false
    private var activeExtended = false
    private var activeCallbackGate: AssistToolCallbackGate?
    private(set) var allowsTransientInactivity = false

    init(gateway: AssistDeviceCapabilities, journalURL: URL? = nil, applePlaces: AssistApplePlaces? = nil,
         foreground: @escaping @MainActor () -> Bool = { AssistToolTransactionCoordinator.defaultForeground }) {
        self.gateway = gateway
        self.applePlaces = applePlaces ?? .shared
        self.foreground = foreground
        do {
            let resolvedURL: URL
            if let journalURL {
                resolvedURL = journalURL
            } else {
                resolvedURL = try AssistToolOperationJournal.defaultURL()
            }
            journal = try AssistToolOperationJournal(url: resolvedURL)
        } catch {
            journal = nil
            journalUnavailable = true
        }
    }

    func snapshotOperations() -> String {
        journal?.snapshotJSON() ?? "{\"schemaVersion\":1,\"operations\":[]}"
    }

    /// Every closed tool (including reads) receives a broker-owned tactile
    /// preview and a single-use token. A missing OS permission is the only
    /// pre-confirmation return: it never starts a native operation or prompt.
    func perform(
        call: AssistDeviceToolCall,
        requestId: String,
        admission: AssistAgentAdmission,
        onActivity: @escaping @Sendable (String) -> Void
    ) async throws -> AssistToolValue {
        try Task.checkCancellation()
        try admission.check()
        guard foreground() else { throw AssistToolTransactionError.inactive }
        guard pending == nil else { throw AssistToolTransactionError.busy }

        let normalized: AssistDeviceToolCall
        do {
            normalized = try AssistDeviceToolRegistry.validate(call: call)
        } catch {
            throw AssistToolTransactionError.invalidNativeResult
        }

        if let capability = Self.capability(for: normalized.name) {
            let permission = await gateway.toolPermissionStatus(for: capability)
            try Task.checkCancellation()
            try admission.check()
            guard foreground() else { throw AssistToolTransactionError.inactive }
            guard AssistToolTransactionPermit.isGranted(capability: capability, status: permission) else {
                let id = UUID()
                Self.emit(
                    requestId: requestId, id: id, call: normalized, status: .awaitingPermission,
                    preview: [], token: nil, capability: capability, receipt: nil, revision: 1, to: onActivity
                )
                return try Self.output([
                    "status": .string("permission_required"),
                    "capability": .string(capability),
                ])
            }
        }

        let destination: AssistDeviceCalendarDestination?
        do {
            switch normalized.name {
            case .calendar_create:
                destination = try gateway.captureCalendarDestination(calendarIdentifier: nil, forReminders: false)
            case .reminder_create:
                destination = try gateway.captureCalendarDestination(calendarIdentifier: nil, forReminders: true)
            default:
                destination = nil
            }
        } catch {
            let id = UUID()
            Self.emit(
                requestId: requestId, id: id, call: normalized, status: .failedSafe,
                preview: [], token: nil, capability: Self.capability(for: normalized.name), receipt: nil, revision: 1, to: onActivity
            )
            throw AssistToolTransactionError.executionFailed
        }

        let preview: [AssistToolPreviewField]
        do {
            preview = try Self.preview(for: normalized, destination: destination)
        } catch {
            throw AssistToolTransactionError.invalidNativeResult
        }
        let id = UUID()
        let token = UUID()
        var current = Pending(
            id: id, token: token, requestId: requestId, call: normalized, preview: preview,
            capability: Self.capability(for: normalized.name), destination: destination, onActivity: onActivity
        )
        current.expiryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(120))
            guard !Task.isCancelled else { return }
            self?.expirePending(id: id)
        }
        pending = current
        Self.emit(
            requestId: requestId, id: id, call: normalized, status: .awaitingConfirmation,
            preview: preview, token: token, capability: current.capability, receipt: nil, revision: 1, to: onActivity
        )

        let needsDurableReceipt = Self.requiresDurableReceipt(normalized.name)
        var writeSubmitted = false
        var nativeHandedOff = false
        do {
            try await waitForConfirmation(id: id)
            try Task.checkCancellation()
            guard let accepted = pending, accepted.id == id, accepted.confirmationAccepted else {
                throw AssistToolTransactionError.confirmationUnavailable
            }
            writeSubmitted = needsDurableReceipt
            // The token has served its sole purpose. It can no longer be used
            // after execution begins, even if the callback returns late.
            pending = nil
            try Task.checkCancellation()
            try admission.check()
            guard foreground() else { throw AssistToolTransactionError.inactive }

            Self.emit(
                requestId: requestId, id: id, call: normalized, status: .executing,
                preview: preview, token: nil, capability: Self.capability(for: normalized.name), receipt: nil, revision: 2, to: onActivity
            )
            let result = try await execute(normalized, id: id, destination: destination) {
                nativeHandedOff = true
            }
            try Task.checkCancellation()
            try admission.check()

            if writeSubmitted {
                do {
                    try journal?.completeSuccess(operationId: id)
                } catch {
                    try? journal?.markOutcomeUnknown(operationId: id)
                    throw AssistToolTransactionError.outcomeUnknown
                }
            }
            let receipt = Self.receipt(id: id, call: normalized, status: "success")
            Self.emit(
                requestId: requestId, id: id, call: normalized, status: .success,
                preview: preview, token: nil, capability: Self.capability(for: normalized.name), receipt: receipt,
                weather: normalized.name == .weather_forecast ? result : nil, revision: 3, to: onActivity
            )
            return result
        } catch {
            // confirm() journals before waking this task. A simultaneous
            // cancellation may remove pending before the local flag is set.
            if needsDurableReceipt, journal?.hasSubmission(operationId: id) == true { writeSubmitted = true }
            if pending?.id == id { clearPending(id: id, error: error) }
            allowsTransientInactivity = false
            let provenSafe: Bool
            switch error {
            case AssistToolTransactionError.rejectedBeforeSubmission, AssistToolTransactionError.cancelledBeforeSubmission:
                provenSafe = true
            default: provenSafe = !nativeHandedOff
            }
            if provenSafe, writeSubmitted {
                do { try journal?.completeSafeRejection(operationId: id); writeSubmitted = false }
                catch { /* Preserve uncertainty if the safe rejection cannot be persisted. */ }
            }
            if writeSubmitted {
                try? journal?.markOutcomeUnknown(operationId: id)
                let receipt = Self.receipt(id: id, call: normalized, status: "outcome_unknown")
                Self.emit(
                    requestId: requestId, id: id, call: normalized, status: .outcomeUnknown,
                    preview: preview, token: nil, capability: Self.capability(for: normalized.name), receipt: receipt, revision: 3, to: onActivity
                )
                throw AssistToolTransactionError.outcomeUnknown
            }
            let status: AssistToolTransactionStatus = Self.isCancellation(error) ? .cancelled : .failedSafe
            Self.emit(
                requestId: requestId, id: id, call: normalized, status: status,
                preview: preview, token: nil, capability: Self.capability(for: normalized.name), receipt: nil, revision: 3, to: onActivity
            )
            if Self.isCancellation(error) { throw AssistToolTransactionError.cancelled }
            if let error = error as? AssistToolTransactionError { throw error }
            throw AssistToolTransactionError.executionFailed
        }
    }

    /// Returns false for stale, invalid, backgrounded, or already-consumed
    /// confirmations. For a write, durable submission happens before the
    /// waiting perform task is resumed toward the native side effect.
    func confirm(transactionId: String, token: String) throws -> Bool {
        guard foreground(), let current = pending,
              current.id.uuidString == transactionId,
              current.token.uuidString == token else {
            return false
        }
        guard !current.confirmationAccepted else { return false }

        // Recheck the native trigger's own one-second future requirement
        // immediately before durable submission. An expired notification is
        // rejected before any journaled side effect, not misreported unknown.
        guard Self.notificationStillFuture(current.call) else {
            clearPending(id: current.id, error: AssistToolTransactionError.executionFailed)
            return false
        }

        if Self.requiresDurableReceipt(current.call.name) {
            guard let journal, !journalUnavailable else {
                throw AssistToolTransactionError.journalUnavailable
            }
            try journal.submit(operationId: current.id, tool: current.call.name)
        }

        var accepted = current
        accepted.confirmationAccepted = true
        accepted.expiryTask?.cancel()
        accepted.expiryTask = nil
        let continuation = accepted.continuation
        accepted.continuation = nil
        pending = accepted
        continuation?.resume()
        return true
    }

    /// Cancels the broker-owned confirmation wait only. It never retries a
    /// callback operation and it cannot roll back a side effect already marked
    /// submitted in the durable write journal.
    func cancelPending() {
        guard var current = pending else {
            if activeExtended, activeCallbackGate?.cancel() == true { AssistCapabilityActions.cancel() }
            if activeApplePlaces, activeCallbackGate?.cancel() == true { applePlaces.cancel() }
            if activeToolInteraction {
                if activeCallbackGate?.cancel() == true {
                    gateway.cancelToolInteraction()
                }
                allowsTransientInactivity = false
            }
            return
        }
        current.expiryTask?.cancel()
        current.expiryTask = nil
        let continuation = current.continuation
        current.continuation = nil
        pending = nil
        continuation?.resume(throwing: AssistToolTransactionError.cancelled)
        allowsTransientInactivity = false
    }

    private static var defaultForeground: Bool {
        #if canImport(UIKit)
        UIApplication.shared.applicationState == .active
        #else
        true
        #endif
    }

    private func waitForConfirmation(id: UUID) async throws {
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                guard var current = pending, current.id == id else {
                    continuation.resume(throwing: AssistToolTransactionError.confirmationUnavailable)
                    return
                }
                if current.confirmationAccepted {
                    continuation.resume()
                    return
                }
                current.continuation = continuation
                pending = current
            }
        }, onCancel: { [weak self] in
            Task { @MainActor [weak self] in self?.cancelPending() }
        })
    }

    private func expirePending(id: UUID) {
        guard var current = pending, current.id == id, !current.confirmationAccepted else { return }
        current.expiryTask = nil
        let continuation = current.continuation
        current.continuation = nil
        pending = nil
        continuation?.resume(throwing: AssistToolTransactionError.confirmationExpired)
    }

    private func clearPending(id: UUID, error: Error) {
        guard var current = pending, current.id == id else { return }
        current.expiryTask?.cancel()
        current.expiryTask = nil
        let continuation = current.continuation
        current.continuation = nil
        pending = nil
        continuation?.resume(throwing: error)
    }

    private func execute(
        _ call: AssistDeviceToolCall, id: UUID, destination: AssistDeviceCalendarDestination?,
        onHandoff: @MainActor () -> Void
    ) async throws -> AssistToolValue {
        let interaction = call.name == .photo_select || call.name == .camera_capture || call.name == .biometrics_authenticate || (call.name.isExtended && call.name.effect != .read)
        if interaction {
            activeToolInteraction = true
            allowsTransientInactivity = true
        }
        defer {
            if interaction {
                activeToolInteraction = false
                allowsTransientInactivity = false
            }
        }
        try Task.checkCancellation()

        let raw: String
        switch call.name {
        case .alarm_list, .alarm_create, .alarm_update, .alarm_stop, .alarm_cancel, .translation_languages, .text_translate, .document_scan, .document_export_pdf, .document_preview, .document_read, .document_search, .document_index, .document_unindex, .message_compose:
            activeExtended = true
            defer { activeExtended = false }
            raw = try await invoke(onCancel: { AssistCapabilityActions.cancel() },
                                   classifyError: { AssistCapabilityActions.callbackFailure($0, call: call) },
                                   onHandoff: onHandoff) { completion in
                AssistCapabilityActions.execute(call, operationId: id, completion: completion)
            }
        case .maps_search, .maps_directions, .weather_forecast:
            // No Apple framework request exists before the broker consumes the
            // one-shot token. Both exact locations and the provider are previewed.
            let payload = try AssistApplePlacesPolicy.toolRequest(call, operationId: id)
            activeApplePlaces = true
            defer { activeApplePlaces = false }
            raw = try await invoke(onCancel: { self.applePlaces.cancel() }) { completion in
                let callback: AssistApplePlaces.Completion = { result in
                    switch result {
                    case .success(let json): completion(json, nil)
                    case .failure(let error): completion(nil, error as NSError)
                    }
                }
                switch call.name {
                case .maps_search: self.applePlaces.searchPlaces(payload, completion: callback)
                case .maps_directions: self.applePlaces.directions(payload, completion: callback)
                case .weather_forecast: self.applePlaces.forecast(payload, completion: callback)
                default: completion(nil, AssistApplePlacesPolicy.failure(.invalid))
                }
            }
        case .contacts_search:
            raw = try await invoke { completion in
                self.gateway.searchContacts(call.arguments["query"]!.stringValue!,
                                            limit: String(call.arguments["limit"]!.integerValue!), completion: completion)
            }
        case .calendar_list:
            raw = try await invoke { completion in
                self.gateway.listCalendarEvents("", startISO: call.arguments["start_iso"]!.stringValue!,
                                                endISO: call.arguments["end_iso"]!.stringValue!,
                                                limit: String(call.arguments["limit"]!.integerValue!), completion: completion)
            }
        case .calendar_create:
            guard let destination else { throw AssistToolTransactionError.invalidNativeResult }
            let payload = try Self.legacyPayload(for: call, destination: destination, operationId: id)
            raw = try await invoke(onHandoff: onHandoff) { completion in self.gateway.createCalendarEvent(payload, completion: completion) }
        case .reminders_list:
            raw = try await invoke { completion in
                self.gateway.listReminders(call.arguments["include_completed"]!.boolValue!,
                                            startISO: call.arguments["start_iso"]!.stringValue!,
                                            endISO: call.arguments["end_iso"]!.stringValue!,
                                            limit: String(call.arguments["limit"]!.integerValue!), completion: completion)
            }
        case .reminder_create:
            guard let destination else { throw AssistToolTransactionError.invalidNativeResult }
            let payload = try Self.legacyPayload(for: call, destination: destination, operationId: id)
            raw = try await invoke(onHandoff: onHandoff) { completion in self.gateway.createReminder(payload, completion: completion) }
        case .location_current:
            raw = try await invoke { completion in self.gateway.currentLocation(completion) }
        case .photo_select:
            raw = try await invoke(onCancel: { self.gateway.cancelToolInteraction() }) { completion in
                self.gateway.selectPhotoForToolOCR(completion)
            }
        case .camera_capture:
            raw = try await invoke(onCancel: { self.gateway.cancelToolInteraction() }) { completion in
                self.gateway.capturePhotoForToolOCR(completion)
            }
        case .notification_schedule:
            guard let fireAt = call.arguments["fire_at"]?.stringValue,
                  try AssistToolContent.timestamp(fireAt).timeIntervalSinceNow >= 1 else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            let payload = try Self.legacyPayload(for: call, destination: nil, operationId: id)
            raw = try await invoke(onHandoff: onHandoff) { completion in self.gateway.scheduleLocalNotification(payload, completion: completion) }
        case .biometrics_status:
            raw = try await invoke { completion in self.gateway.biometricStatus(completion) }
        case .biometrics_authenticate:
            raw = try await invoke(onCancel: { self.gateway.cancelToolInteraction() }) { completion in
                self.gateway.authenticateWithBiometrics(call.arguments["reason"]!.stringValue!, completion: completion)
            }
        case .device_capabilities:
            raw = try await invoke { completion in self.gateway.capabilityStatus(completion) }
        case .native_boundary:
            raw = try await invoke { completion in
                self.gateway.nativeCapabilityBoundary(call.arguments["feature"]!.stringValue!, completion: completion)
            }
        }
        try Task.checkCancellation()
        return try Self.project(call: call, raw: raw, operationId: id, destination: destination)
    }

    private func invoke(
        onCancel: @escaping @MainActor @Sendable () -> Void = {},
        classifyError: @escaping @MainActor @Sendable (NSError) -> AssistToolTransactionError = { _ in .executionFailed },
        onHandoff: @MainActor () -> Void = {},
        _ operation: (@escaping AssistDeviceCapabilities.Completion) -> Void
    ) async throws -> String {
        try Task.checkCancellation()
        let gate = AssistToolCallbackGate()
        activeCallbackGate = gate
        defer { if activeCallbackGate === gate { activeCallbackGate = nil } }
        let output = try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
                guard gate.install(continuation) else { return }
                guard !Task.isCancelled else { gate.cancel(); return }
                // No await separates this marker from the concrete executor.
                // A validated native reply may later prove a safe cancellation;
                // absent such a reply, every durable handoff remains uncertain.
                onHandoff()
                operation { value, error in
                    if let error { gate.fail(classifyError(error)) }
                    else if let value { gate.succeed(value) }
                    else { gate.fail(AssistToolTransactionError.invalidNativeResult) }
                }
            }
        }, onCancel: { [weak self, weak gate] in
            Task { @MainActor [weak self, weak gate] in
                guard let self, let gate, self.activeCallbackGate === gate,
                      gate.cancel() else { return }
                onCancel()
            }
        })
        try Task.checkCancellation()
        return output
    }

    /// Converts only the closed model arguments into the legacy native method
    /// schema. Model-facing snake_case is never forwarded as ambient authority:
    /// calendar destinations and notification IDs are host-captured values.
    private static func legacyPayload(
        for call: AssistDeviceToolCall,
        destination: AssistDeviceCalendarDestination?,
        operationId: UUID
    ) throws -> String {
        let object: [String: Any]
        switch call.name {
        case .calendar_create:
            guard let destination,
                  let title = call.arguments["title"]?.stringValue,
                  let start = call.arguments["start_iso"]?.stringValue,
                  let end = call.arguments["end_iso"]?.stringValue else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            var payload: [String: Any] = [
                "title": title, "startISO": start, "endISO": end,
                "calendarId": destination.identifier,
            ]
            if let notes = call.arguments["notes"]?.stringValue { payload["notes"] = notes }
            if let location = call.arguments["location"]?.stringValue { payload["location"] = location }
            object = payload
        case .reminder_create:
            guard let destination, let title = call.arguments["title"]?.stringValue else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            var payload: [String: Any] = ["title": title, "calendarId": destination.identifier]
            if let due = call.arguments["due_iso"]?.stringValue { payload["dueISO"] = due }
            if let notes = call.arguments["notes"]?.stringValue { payload["notes"] = notes }
            object = payload
        case .notification_schedule:
            guard let title = call.arguments["title"]?.stringValue,
                  let body = call.arguments["body"]?.stringValue,
                  let date = call.arguments["fire_at"]?.stringValue else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            object = ["title": title, "body": body, "dateISO": date, "id": operationId.uuidString]
        default:
            throw AssistToolTransactionError.invalidNativeResult
        }
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8), json.utf8.count <= 16 * 1_024 else {
            throw AssistToolTransactionError.invalidNativeResult
        }
        return json
    }

    private static func project(
        call: AssistDeviceToolCall, raw: String, operationId: UUID, destination: AssistDeviceCalendarDestination?
    ) throws -> AssistToolValue {
        if call.name.isExtended { return try AssistCapabilityActions.project(raw, call: call, operationId: operationId) }
        if call.name.execution == "apple_network" {
            return try AssistApplePlacesPolicy.toolResult(raw, call: call, operationId: operationId)
        }
        guard raw.utf8.count <= maximumGatewayJSONBytes,
              let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else {
            throw AssistToolTransactionError.invalidNativeResult
        }
        switch call.name {
        case .alarm_list, .alarm_create, .alarm_update, .alarm_stop, .alarm_cancel, .translation_languages, .text_translate, .document_scan, .document_export_pdf, .document_preview, .document_read, .document_search, .document_index, .document_unindex, .message_compose:
            throw AssistToolTransactionError.invalidNativeResult
        case .maps_search, .maps_directions, .weather_forecast:
            throw AssistToolTransactionError.invalidNativeResult // handled by the closed Apple validator above
        case .contacts_search:
            guard let source = dictionary["contacts"] as? [[String: Any]] else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            let rows = try source.prefix(call.arguments["limit"]!.integerValue!).map(projectContact)
            return try output([
                "contacts": .array(rows), "count": .number(Double(rows.count)),
                "possibly_truncated": .bool(source.count >= call.arguments["limit"]!.integerValue!),
                "caveat": .string("Résultats limités; la recherche n’est pas exhaustive."),
            ])
        case .calendar_list:
            guard let source = dictionary["events"] as? [[String: Any]] else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            let rows = try source.prefix(call.arguments["limit"]!.integerValue!).map(projectEvent)
            return try output([
                "events": .array(rows), "count": .number(Double(rows.count)),
                "possibly_truncated": .bool(source.count >= call.arguments["limit"]!.integerValue!),
                "caveat": .string("Résultats limités; l’ordre et l’exhaustivité ne sont pas garantis."),
            ])
        case .calendar_create:
            guard let eventId = boundedString(dictionary["id"], maximum: 256),
                  !eventId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  dictionary["calendarId"] as? String == destination?.identifier else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            return try output(["created": .bool(true), "destination": .string("calendar")])
        case .reminders_list:
            guard let source = dictionary["reminders"] as? [[String: Any]] else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            let rows = try source.prefix(call.arguments["limit"]!.integerValue!).map(projectReminder)
            return try output([
                "reminders": .array(rows), "count": .number(Double(rows.count)),
                "possibly_truncated": .bool(source.count >= call.arguments["limit"]!.integerValue!),
                "caveat": .string("Résultats limités; incomplets par échéance, terminés par date d’achèvement."),
            ])
        case .reminder_create:
            guard let reminderId = boundedString(dictionary["id"], maximum: 256),
                  !reminderId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  dictionary["calendarId"] as? String == destination?.identifier else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            return try output(["created": .bool(true), "destination": .string("reminders")])
        case .location_current:
            guard let latitude = number(dictionary["latitude"]), let longitude = number(dictionary["longitude"]),
                  let accuracy = number(dictionary["horizontalAccuracy"]), accuracy >= 0,
                  let timestamp = boundedString(dictionary["timestampISO"], maximum: 64) else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            return try output(["latitude": .number(latitude), "longitude": .number(longitude),
                               "horizontal_accuracy": .number(accuracy), "timestamp": .string(timestamp)])
        case .photo_select, .camera_capture:
            let expectedSource = call.name == .photo_select ? "photoLibrary" : "camera"
            guard dictionary["source"] as? String == expectedSource,
                  let count = number(dictionary["byteCount"]), count > 0,
                  dictionary["visionAvailable"] as? Bool == true,
                  let status = dictionary["ocrStatus"] as? String,
                  ["text", "no_text", "failed"].contains(status),
                  let lines = integer(dictionary["ocrLines"]), (0...40).contains(lines),
                  let truncated = dictionary["ocrTruncated"] as? Bool,
                  dictionary["ocrReliable"] as? Bool == false else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            var image: [String: AssistToolValue] = [
                "selected": .bool(true), "source": .string(expectedSource), "byte_count": .number(count),
                "vision_available": .bool(true), "ocr_status": .string(status),
                "ocr_lines": .number(Double(lines)), "ocr_truncated": .bool(truncated), "ocr_reliable": .bool(false),
            ]
            if status == "text" {
                guard let text = boundedString(dictionary["ocrText"], maximum: 8 * 1_024), !text.isEmpty, lines > 0 else {
                    throw AssistToolTransactionError.invalidNativeResult
                }
                image["ocr_text"] = .string(text)
            } else if dictionary["ocrText"] != nil || lines != 0 || truncated {
                throw AssistToolTransactionError.invalidNativeResult
            }
            return try output(image)
        case .notification_schedule:
            guard dictionary["id"] as? String == operationId.uuidString,
                  dictionary["scheduled"] as? Bool == true else { throw AssistToolTransactionError.invalidNativeResult }
            return try output(["scheduled": .bool(true), "presentation": .string("scheduled_not_presented")])
        case .biometrics_status:
            guard let available = dictionary["available"] as? Bool,
                  let type = boundedString(dictionary["type"], maximum: 32),
                  ["faceId", "touchId", "opticId", "none", "unknown"].contains(type) else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            return try output(["available": .bool(available), "type": .string(type)])
        case .biometrics_authenticate:
            guard dictionary["authenticated"] as? Bool == true else { throw AssistToolTransactionError.executionFailed }
            return try output(["authenticated": .bool(true)])
        case .device_capabilities:
            guard let source = dictionary["capabilities"] as? [String: Any] else { throw AssistToolTransactionError.invalidNativeResult }
            let known = ["contacts", "calendar", "reminders", "location", "camera", "notifications"]
            var capabilities: [String: AssistToolValue] = [:]
            for name in known {
                if let value = boundedString(source[name], maximum: 32) { capabilities[name] = .string(value) }
            }
            return try output(["capabilities": .object(capabilities)])
        case .native_boundary:
            let feature = call.arguments["feature"]!.stringValue!
            guard let boundary = dictionary["boundary"] as? [String: Any], boundary["supported"] as? Bool == false else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            return try output(["feature": .string(feature), "supported": .bool(false)])
        }
    }

    private static func projectContact(_ row: [String: Any]) throws -> AssistToolValue {
        guard let given = boundedString(row["givenName"], maximum: 512),
              let family = boundedString(row["familyName"], maximum: 512),
              let organization = boundedString(row["organizationName"], maximum: 512),
              let rawPhones = row["phoneNumbers"] as? [[String: Any]],
              let rawEmails = row["emailAddresses"] as? [[String: Any]] else {
            throw AssistToolTransactionError.invalidNativeResult
        }
        return .object([
            "given_name": .string(given), "family_name": .string(family), "organization": .string(organization),
            "phone_numbers": .array(try projectChannels(rawPhones)), "emails": .array(try projectChannels(rawEmails)),
        ])
    }

    private static func projectChannels(_ rows: [[String: Any]]) throws -> [AssistToolValue] {
        try rows.prefix(3).map { row in
            guard let channel = boundedString(row["value"], maximum: 512), !channel.isEmpty,
                  let label = boundedString(row["label"], maximum: 128) else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            return .object(["value": .string(channel), "label": .string(label)])
        }
    }

    private static func projectEvent(_ row: [String: Any]) throws -> AssistToolValue {
        guard let title = boundedString(row["title"], maximum: 512),
              let start = boundedString(row["startISO"], maximum: 64),
              let end = boundedString(row["endISO"], maximum: 64),
              let allDay = row["allDay"] as? Bool else { throw AssistToolTransactionError.invalidNativeResult }
        return .object(["title": .string(title), "start": .string(start), "end": .string(end), "all_day": .bool(allDay)])
    }

    private static func projectReminder(_ row: [String: Any]) throws -> AssistToolValue {
        guard let title = boundedString(row["title"], maximum: 512), let completed = row["completed"] as? Bool else {
            throw AssistToolTransactionError.invalidNativeResult
        }
        var reminder: [String: AssistToolValue] = ["title": .string(title), "completed": .bool(completed)]
        if let rawDue = row["dueISO"] {
            guard let due = boundedString(rawDue, maximum: 64) else { throw AssistToolTransactionError.invalidNativeResult }
            reminder["due"] = .string(due)
        }
        return .object(reminder)
    }

    private static func output(_ object: [String: AssistToolValue]) throws -> AssistToolValue {
        try AssistToolValue.object(object).validated()
    }

    private static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
        return number.doubleValue
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = number(value), number.rounded(.towardZero) == number,
              number >= 0, number <= Double(Int.max) else { return nil }
        return Int(number)
    }

    private static func boundedString(_ value: Any?, maximum: Int) -> String? {
        guard let text = value as? String, text.utf8.count <= maximum else { return nil }
        return text
    }

    private static func capability(for name: AssistToolName) -> String? {
        switch name {
        case .contacts_search: "contacts"
        case .calendar_list, .calendar_create: "calendar"
        case .reminders_list, .reminder_create: "reminders"
        case .location_current: "location"
        case .camera_capture: "camera"
        case .notification_schedule: "notifications"
        case .biometrics_authenticate: "biometrics"
        case .photo_select, .biometrics_status, .device_capabilities, .native_boundary, .maps_search, .maps_directions, .weather_forecast, .alarm_list, .alarm_create, .alarm_update, .alarm_stop, .alarm_cancel, .translation_languages, .text_translate, .document_scan, .document_export_pdf, .document_preview, .document_read, .document_search, .document_index, .document_unindex, .message_compose: nil
        }
    }

    private static func notificationStillFuture(_ call: AssistDeviceToolCall) -> Bool {
        guard call.name == .notification_schedule,
              let fireAt = call.arguments["fire_at"]?.stringValue,
              let fire = try? AssistToolContent.timestamp(fireAt) else {
            return call.name != .notification_schedule
        }
        return fire.timeIntervalSinceNow >= 1
    }

    private static func preview(
        for call: AssistDeviceToolCall, destination: AssistDeviceCalendarDestination?
    ) throws -> [AssistToolPreviewField] {
        func value(_ key: String) throws -> String {
            guard let value = call.arguments[key]?.stringValue else { throw AssistToolTransactionError.invalidNativeResult }
            return value
        }
        func optional(_ key: String, label: String) -> AssistToolPreviewField? {
            guard let value = call.arguments[key]?.stringValue, !value.isEmpty else { return nil }
            return AssistToolPreviewField(label: label, value: value)
        }
        func coordinate(_ latitude: String, _ longitude: String) throws -> String {
            guard case .number(let lat) = call.arguments[latitude], case .number(let lon) = call.arguments[longitude] else {
                throw AssistToolTransactionError.invalidNativeResult
            }
            return "\(lat), \(lon)"
        }
        if call.name.isExtended {
            return AssistCapabilityActions.preview(call)
        }
        let fields: [AssistToolPreviewField?]
        switch call.name {
        case .alarm_list, .alarm_create, .alarm_update, .alarm_stop, .alarm_cancel, .translation_languages, .text_translate, .document_scan, .document_export_pdf, .document_preview, .document_read, .document_search, .document_index, .document_unindex, .message_compose:
            return AssistCapabilityActions.preview(call)
        case .maps_search:
            fields = [.init(label: "Envoi à", value: "Apple Maps, service en ligne"),
                      .init(label: "Recherche transmise", value: try value("query")),
                      .init(label: "Résultats max.", value: String(call.arguments["limit"]!.integerValue!))]
        case .maps_directions:
            fields = [.init(label: "Envoi à", value: "Apple Maps, service en ligne"),
                      .init(label: "Départ transmis", value: try coordinate("origin_latitude", "origin_longitude")),
                      .init(label: "Arrivée transmise", value: try coordinate("destination_latitude", "destination_longitude")),
                      .init(label: "Transport", value: try value("transport")),
                      .init(label: "Résultat", value: "Estimation seulement; aucune navigation démarrée")]
        case .weather_forecast:
            fields = [.init(label: "Envoi à", value: "Apple Weather, service en ligne"),
                      .init(label: "Lieu transmis", value: try coordinate("latitude", "longitude")),
                      .init(label: "Unité", value: try value("unit")),
                      .init(label: "Heures max.", value: String(call.arguments["hourly_count"]!.integerValue!)),
                      .init(label: "Jours max.", value: String(call.arguments["daily_count"]!.integerValue!))]
        case .contacts_search:
            fields = [.init(label: "Recherche", value: try value("query")), .init(label: "Résultats max.", value: String(call.arguments["limit"]!.integerValue!))]
        case .calendar_list:
            fields = [.init(label: "Du", value: try value("start_iso")), .init(label: "Au", value: try value("end_iso")), .init(label: "Résultats max.", value: String(call.arguments["limit"]!.integerValue!))]
        case .calendar_create:
            guard let destination else { throw AssistToolTransactionError.invalidNativeResult }
            fields = [.init(label: "Titre", value: try value("title")), .init(label: "Début", value: try value("start_iso")), .init(label: "Fin", value: try value("end_iso")), .init(label: "Calendrier", value: destination.title), optional("location", label: "Lieu"), optional("notes", label: "Notes")]
        case .reminders_list:
            fields = [.init(label: "Du", value: try value("start_iso")), .init(label: "Au", value: try value("end_iso")), .init(label: "Inclure terminés", value: call.arguments["include_completed"]!.boolValue! ? "Oui" : "Non"), .init(label: "Résultats max.", value: String(call.arguments["limit"]!.integerValue!))]
        case .reminder_create:
            guard let destination else { throw AssistToolTransactionError.invalidNativeResult }
            fields = [.init(label: "Titre", value: try value("title")), .init(label: "Liste", value: destination.title), optional("due_iso", label: "Échéance"), optional("notes", label: "Notes")]
        case .location_current:
            fields = [.init(label: "Position", value: "Position ponctuelle au premier plan")]
        case .photo_select:
            fields = [.init(label: "Photo", value: "Sélectionner une photo et lire son texte sur l’appareil")]
        case .camera_capture:
            fields = [.init(label: "Caméra", value: "Prendre une photo et lire son texte sur l’appareil")]
        case .notification_schedule:
            fields = [.init(label: "Titre", value: try value("title")), .init(label: "Message", value: try value("body")), .init(label: "Date", value: try value("fire_at"))]
        case .biometrics_status:
            fields = [.init(label: "Biométrie", value: "Vérifier la disponibilité")]
        case .biometrics_authenticate:
            fields = [.init(label: "Motif", value: try value("reason"))]
        case .device_capabilities:
            fields = [.init(label: "Appareil", value: "Lire les états des capacités")]
        case .native_boundary:
            fields = [.init(label: "Fonction", value: try value("feature"))]
        }
        let compact = fields.compactMap { $0 }
        guard compact.count <= 10 else { throw AssistToolTransactionError.invalidNativeResult }
        return compact
    }

    private static func receipt(id: UUID, call: AssistDeviceToolCall, status: String) -> AssistToolReceipt {
        AssistToolReceipt(
            operationId: id.uuidString, tool: call.name.rawValue, status: status, completedAt: Self.timestamp(),
            summary: [AssistToolPreviewField(label: "Résultat", value: status == "success" ? "Opération enregistrée" : "Vérification manuelle requise")]
        )
    }

    private static func emit(
        requestId: String, id: UUID, call: AssistDeviceToolCall, status: AssistToolTransactionStatus,
        preview: [AssistToolPreviewField], token: UUID?, capability: String?, receipt: AssistToolReceipt?,
        weather: AssistToolValue? = nil, revision: Int, to onActivity: @Sendable (String) -> Void
    ) {
        let envelope = AssistToolActivityEnvelope(
            requestId: requestId,
            transaction: .init(
                id: id.uuidString, revision: revision, tool: call.name.rawValue, effect: call.name.effect.rawValue,
                title: title(for: call.name), status: status.rawValue, preview: Array(preview.prefix(10)),
                confirmationToken: status == .awaitingConfirmation ? token?.uuidString : nil,
                capability: capability, receipt: receipt, weather: weather
            )
        )
        guard let data = try? JSONEncoder().encode(envelope), let json = String(data: data, encoding: .utf8) else { return }
        onActivity(json)
    }

    private static func title(for name: AssistToolName) -> String {
        switch name {
        case .alarm_list, .alarm_create, .alarm_update, .alarm_stop, .alarm_cancel, .translation_languages, .text_translate, .document_scan, .document_export_pdf, .document_preview, .document_read, .document_search, .document_index, .document_unindex, .message_compose:
            AssistExtendedToolsPolicy.title(name)
        case .contacts_search: "Rechercher des contacts"
        case .calendar_list: "Consulter le calendrier"
        case .calendar_create: "Créer un événement"
        case .reminders_list: "Consulter les rappels"
        case .reminder_create: "Créer un rappel"
        case .location_current: "Obtenir la position actuelle"
        case .photo_select: "Choisir une photo"
        case .camera_capture: "Prendre une photo"
        case .notification_schedule: "Programmer une notification"
        case .biometrics_status: "Vérifier la biométrie"
        case .biometrics_authenticate: "Confirmer par biométrie"
        case .device_capabilities: "Consulter les capacités de l’appareil"
        case .native_boundary: "Vérifier une limite native"
        case .maps_search: "Rechercher un lieu"
        case .maps_directions: "Estimer un trajet"
        case .weather_forecast: "Consulter la météo"
        }
    }

    private static func timestamp(_ date: Date = Date()) -> String { ISO8601DateFormatter().string(from: date) }

    private static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        guard let transaction = error as? AssistToolTransactionError else { return false }
        switch transaction {
        case .cancelled, .cancelledBeforeSubmission, .confirmationExpired: return true
        default: return false
        }
    }

    /// These tools expose interactive Apple UI but can create durable effects.
    /// Their public effect remains interactive; it is not a retry guarantee.
    private static func requiresDurableReceipt(_ name: AssistToolName) -> Bool {
        name.effect == .write || [.message_compose, .document_scan, .document_export_pdf].contains(name)
    }
}
