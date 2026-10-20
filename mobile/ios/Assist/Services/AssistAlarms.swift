import Foundation
import AlarmKit
import SwiftUI
import UIKit

/// Foreground-only AlarmKit bridge. The central broker owns exact user consent;
/// this owner independently validates it, requests system authorization, journals
/// ownership before side effects, and never resubmits an uncertain operation.
@MainActor
final class AssistAlarms {
    static let shared = AssistAlarms()
    typealias Completion = @Sendable (String?, NSError?) -> Void
    private struct Active {
        let request: AssistAlarmPolicy.Request
        var completion: Completion?
        var submitted = false
        var cancelled = false
    }
    private var active: Active?
    private var task: Task<Void, Never>?
    private var journal: AssistAlarmPolicy.Journal?
    private let manager = AlarmManager.shared
    private init() {}

    func execute(_ requestJSON: String, completion: @escaping Completion) {
        do {
            let request = try AssistAlarmPolicy.request(requestJSON)
            guard active == nil else { throw AssistAlarmPolicy.failure(.operation_conflict) }
            guard UIApplication.shared.applicationState == .active else { throw AssistAlarmPolicy.failure(.cancelled) }
            active = Active(request: request, completion: completion)
            task = Task { @MainActor in await self.run(request) }
        } catch { completion(nil, error as NSError) }
    }

    func cancel() {
        guard var pending = active else { return }
        // Revoke before calling framework cancellation or any consumer callback.
        pending.cancelled = true
        let callback = pending.completion; pending.completion = nil; active = pending
        task?.cancel()
        var status: AssistAlarmPolicy.Status = pending.submitted ? .outcome_unknown : .failed_safe
        var code: AssistAlarmPolicy.Code = pending.submitted ? .outcome_unknown : .cancelled
        var receipt = makeReceipt(pending.request, status: status, code: code)
        if journal?.operations[pending.request.operationId] != nil {
            do { try persistReceipt(receipt) } catch {
                if pending.submitted { status = .outcome_unknown; code = .outcome_unknown }
                receipt = makeReceipt(pending.request, status: status, code: code)
            }
        }
        do { callback?(try AssistAlarmPolicy.encode(receipt), nil) }
        catch { callback?(nil, AssistAlarmPolicy.failure(pending.submitted ? .outcome_unknown : .cancelled)) }
        // Keep the owner occupied until the framework await resolves. A late
        // successful schedule is journalled, never cancelled or retried blindly.
    }

    private func run(_ request: AssistAlarmPolicy.Request) async {
        defer { active = nil; task = nil }
        do {
            try loadJournal()
            if request.action != .list, let previous = try journal!.previous(request) {
                if let receipt = previous.receipt { deliver(receipt); return }
                deliver(makeReceipt(request, status: previous.submitted ? .outcome_unknown : .failed_safe,
                                    code: previous.submitted ? .outcome_unknown : .cancelled)); return
            }
            try checkActive()
            if request.action == .list {
                try reconcile()
                deliver(makeReceipt(request, status: .succeeded, code: .ok)); return
            }
            // No permission request on launch, capability discovery, or list.
            // execute is reached only after a specific user-confirmed mutation.
            if manager.authorizationState == .notDetermined {
                _ = try await Self.requestAuthorization()
            }
            try checkActive()
            guard manager.authorizationState == .authorized else {
                deliver(makeReceipt(request, status: .failed_safe, code: .permission_denied)); return
            }
            if request.kind == .alarm, let date = request.date_iso.flatMap(AssistAlarmPolicy.parseDate), date.timeIntervalSinceNow <= 0 {
                throw AssistAlarmPolicy.failure(.unavailable)
            }
            try reconcile()
            var next = journal!
            try next.reserve(request)
            try save(next); journal = next
            try checkActive()
            if request.action != .create {
                let present = try manager.alarms.contains { $0.id == request.alarmID! }
                if !present {
                    // Explicit cancel is idempotent when authoritative AlarmKit
                    // state already lacks this owned ID (including after restart).
                    let receipt = makeReceipt(request, status: request.action == .cancel ? .succeeded : .failed_safe,
                                              code: request.action == .cancel ? .ok : .not_found)
                    try persistReceipt(receipt); deliver(receipt); return
                }
            }
            // Persist this bit *before* a framework call, including the first
            // cancellation in update. A process loss at any later point is unknown.
            journal!.operations[request.operationId]!.submitted = true
            try save(journal!)
            active?.submitted = true
            switch request.action {
            case .create:
                try await Self.schedule(request)
            case .update:
                // AlarmKit has no general update API. Replacement is explicitly
                // cancel then schedule, under the same durable app-owned ID.
                try manager.cancel(id: request.alarmID!)
                try checkActive()
                try await Self.schedule(request)
            case .stop: try manager.stop(id: request.alarmID!)
            case .cancel: try manager.cancel(id: request.alarmID!)
            case .list: break
            }
            // Capture acknowledged configuration even if caller went away while
            // schedule was awaiting. Cancellation is not rollback of a real alarm.
            if request.action == .create || request.action == .update {
                journal!.items[request.alarm_id!] = AssistAlarmPolicy.Item(request: request, uncertain: false)
            }
            journal!.operations[request.operationId]!.resolved = true
            try reconcile()
            let receipt = makeReceipt(request, status: .succeeded, code: .ok)
            try persistReceipt(receipt)
            deliver(receipt)
        } catch {
            let submitted = active?.submitted == true
            let localCode = (error as NSError).domain == "AssistAlarms"
                ? AssistAlarmPolicy.Code(rawValue: (error as NSError).localizedDescription) : nil
            let code: AssistAlarmPolicy.Code = submitted ? .outcome_unknown :
                (active?.cancelled == true ? .cancelled : (localCode ?? .unavailable))
            let receipt = makeReceipt(request, status: code == .outcome_unknown ? .outcome_unknown : .failed_safe, code: code)
            if journal?.operations[request.operationId] != nil { try? persistReceipt(receipt) }
            deliver(receipt)
        }
    }

    // SDK26.2's AlarmManager and configuration are non-Sendable. Construct
    // them after hopping off MainActor rather than sending an actor-owned
    // instance across the imported framework's nonisolated async boundary.
    // The foreground owner stays occupied until these awaits have resolved.
    @concurrent
    private static func requestAuthorization() async throws -> Bool {
        try await AlarmManager.shared.requestAuthorization() == .authorized
    }
    @concurrent
    private static func schedule(_ request: AssistAlarmPolicy.Request) async throws {
        let configuration = configuration(request)
        _ = try await AlarmManager.shared.schedule(id: request.alarmID!, configuration: configuration)
    }
    nonisolated private static func configuration(_ request: AssistAlarmPolicy.Request) -> AlarmManager.AlarmConfiguration<AssistAlarmMetadata> {
        let title = LocalizedStringResource(stringLiteral: request.title!)
        // The system provides Stop; the stopButton initializer was deprecated
        // in iOS26.1. Our native29 deployment target uses the current API.
        let alert = AlarmPresentation.Alert(title: title)
        let presentation: AlarmPresentation
        if request.kind == .timer {
            presentation = AlarmPresentation(alert: alert,
                countdown: AlarmPresentation.Countdown(title: title,
                    pauseButton: AlarmButton(text: "Pause", textColor: .blue, systemImageName: "pause")),
                paused: AlarmPresentation.Paused(title: "En pause",
                    resumeButton: AlarmButton(text: "Reprendre", textColor: .blue, systemImageName: "play")))
        } else { presentation = AlarmPresentation(alert: alert) }
        let attributes = AlarmAttributes(presentation: presentation,
            metadata: AssistAlarmMetadata(alarmID: request.alarm_id!, title: request.title!, kind: request.kind!.rawValue),
            tintColor: Color.blue)
        if request.kind == .timer {
            // Requires the bundled AssistAlarmLiveActivity countdown widget.
            return .timer(duration: TimeInterval(request.duration_seconds!), attributes: attributes)
        }
        return .alarm(schedule: .fixed(AssistAlarmPolicy.parseDate(request.date_iso!)!), attributes: attributes)
    }
    private func checkActive() throws {
        guard active?.cancelled == false, !Task.isCancelled,
              UIApplication.shared.applicationState == .active else { throw AssistAlarmPolicy.failure(.cancelled) }
    }
    private func deliver(_ receipt: AssistAlarmPolicy.Receipt) {
        guard let callback = active?.completion else { return }
        active?.completion = nil
        do { callback(try AssistAlarmPolicy.encode(receipt), nil) }
        catch { callback(nil, AssistAlarmPolicy.failure(active?.submitted == true ? .outcome_unknown : .unavailable)) }
    }
    private func makeReceipt(_ request: AssistAlarmPolicy.Request, status: AssistAlarmPolicy.Status,
                             code: AssistAlarmPolicy.Code) -> AssistAlarmPolicy.Receipt {
        var items = journal.map { store in
            request.action == .list ? Array(store.items.values) : request.alarm_id.flatMap { store.items[$0] }.map { [$0] } ?? []
        } ?? []
        if status == .outcome_unknown || (status == .succeeded && request.action == .cancel) {
            items = items.map { item in var value = item; value.uncertain = status == .outcome_unknown; return value }
        }
        return AssistAlarmPolicy.receipt(request, status: status, code: code, items: items)
    }
    private func persistReceipt(_ receipt: AssistAlarmPolicy.Receipt) throws {
        var next = journal!
        next.operations[receipt.operationId]?.receipt = receipt
        next.operations[receipt.operationId]?.resolved = receipt.status != .outcome_unknown
        if receipt.status == .outcome_unknown, let id = next.operations[receipt.operationId]?.request.alarm_id {
            next.items[id]?.uncertain = true
        }
        // Successful explicit cancel resolves older uncertain mutation ownership,
        // but preserves their historical outcome_unknown receipts verbatim.
        if receipt.status == .succeeded, receipt.action == .cancel,
           let id = next.operations[receipt.operationId]?.request.alarm_id {
            next.items[id]?.uncertain = false
            for key in Array(next.operations.keys) where next.operations[key]?.request.alarm_id == id {
                next.operations[key]?.resolved = true
            }
        }
        try save(next); journal = next
    }
    private func reconcile() throws {
        let alarms = try manager.alarms
        var states: [String: AssistAlarmPolicy.State] = [:]
        for alarm in alarms where journal!.items[alarm.id.uuidString] != nil {
            let state: AssistAlarmPolicy.State
            switch alarm.state {
            case .scheduled: state = .scheduled
            case .countdown: state = .countdown
            case .paused: state = .paused
            case .alerting: state = .alerting
            @unknown default: state = .unknown
            }
            states[alarm.id.uuidString] = state
        }
        var next = journal!; next.reconcile(states); try save(next); journal = next
    }
    private func storeURL() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                               appropriateFor: nil, create: true)
        let folder = base.appendingPathComponent("AssistAlarmOwnership", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return folder.appendingPathComponent("ownership-v1.json", isDirectory: false)
    }
    private func loadJournal() throws {
        guard journal == nil else { return }
        do {
            let url = try storeURL()
            guard FileManager.default.fileExists(atPath: url.path) else { journal = .init(); return }
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard let size = attributes[.size] as? NSNumber, size.intValue <= 8 * 1_024 * 1_024 else {
                throw AssistAlarmPolicy.failure(.storage_unavailable)
            }
            let decoded = try JSONDecoder().decode(AssistAlarmPolicy.Journal.self, from: Data(contentsOf: url))
            try AssistAlarmPolicy.validate(decoded); journal = decoded
        } catch { throw AssistAlarmPolicy.failure(.storage_unavailable) }
    }
    private func save(_ journal: AssistAlarmPolicy.Journal) throws {
        do {
            try AssistAlarmPolicy.validate(journal)
            let data = try JSONEncoder().encode(journal)
            guard data.count <= 8 * 1_024 * 1_024 else { throw AssistAlarmPolicy.failure(.limit_reached) }
            let url = try storeURL()
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var protected = url
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try protected.setResourceValues(values)
        } catch { throw AssistAlarmPolicy.failure(.storage_unavailable) }
    }
}
