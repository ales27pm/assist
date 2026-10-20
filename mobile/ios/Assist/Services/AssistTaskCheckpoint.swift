import Foundation

enum AssistTaskCheckpointError: Error, LocalizedError {
    case invalidRequest, staleRevision, busy, invalidTransition, unavailable, capacity

    var errorDescription: String? {
        switch self {
        case .invalidRequest: "Métadonnées de tâche invalides. Aucun travail repris."
        case .staleRevision: "Cette tâche a changé. Actualise son état avant de continuer."
        case .busy: "Une autre tâche est déjà active. Mets-la en pause avant de continuer."
        case .invalidTransition: "Cette tâche ne peut pas reprendre. Aucune action n’a été relancée."
        case .unavailable: "Le checkpoint est indisponible ou provient d’une autre version. Son fichier est conservé."
        case .capacity: "Le checkpoint est plein. Les tâches à vérifier ont été conservées."
        }
    }
}

/// UI-owned recovery metadata, serialized on main with lifecycle notifications.
/// These synchronous, bounded transactions have no suspension/reentrancy point.
/// A resume records user intent only: this store NEVER executes tools, a model,
/// writes, network calls or a saved prompt. The caller owns real cancellation.
@MainActor
final class AssistTaskCheckpoint {
    static let shared = AssistTaskCheckpoint()
    private static let maximumBytes = 24 * 1_024
    private static let maximumTasks = 20
    private static let maximumRevision = 1_000_000_000

    private enum Kind: String, Codable { case research, document }
    private enum State: String, Codable { case running, paused, completed, cancelled, outcome_unknown }
    private enum PauseReason: String, Codable { case user, interrupted }
    private struct Entry: Codable {
        let taskId: String
        let kind: Kind
        var state: State
        var epoch: Int
        var revision: Int
        var updatedAt: String
        var pauseReason: PauseReason?
    }
    private struct Snapshot: Codable {
        let schemaVersion: Int
        var revision: Int
        var tasks: [Entry]
    }

    private let url: URL?
    private let now: () -> Date
    private var loaded = false
    private var blocked = false
    private var lastDiskData: Data?
    private var snapshot = Snapshot(schemaVersion: 1, revision: 0, tasks: [])

    /// The URL override is for native contract tests, never a bridge argument.
    init(url: URL? = nil, now: @escaping () -> Date = { Date() }) {
        self.url = url ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?.appendingPathComponent("Assist/task-checkpoints-v1.json", isDirectory: false)
        self.now = now
    }

    func snapshotJSON() throws -> String {
        try load()
        try checkDiskUnchanged()
        return try encoded(snapshot)
    }

    /// Closed metadata contract. UUIDs contain no queries, URLs or user text.
    /// All changes are fenced by a per-task revision; resume advances the epoch
    /// so work started before pause cannot complete the resumed task.
    func apply(_ requestJSON: String) throws -> String {
        let request = try object(requestJSON)
        guard let action = request["action"]?.stringValue else { throw AssistTaskCheckpointError.invalidRequest }
        let required: Set<String> = ["schemaVersion", "action", "taskId", "expectedRevision"]
        let optional: Set<String> = action == "start" ? ["kind"] : (action == "complete" ? ["outcome"] : [])
        guard Set(request.keys).isSuperset(of: required), Set(request.keys).isSubset(of: required.union(optional)),
              request["schemaVersion"]?.integerValue == 1,
              let taskId = canonicalUUID(request["taskId"]?.stringValue),
              let expected = request["expectedRevision"]?.integerValue,
              (0..<Self.maximumRevision).contains(expected),
              ["start", "pause", "resume", "complete", "cancel"].contains(action) else {
            throw AssistTaskCheckpointError.invalidRequest
        }
        try load()
        try checkDiskUnchanged()
        var next = snapshot
        guard next.revision < Self.maximumRevision else { throw AssistTaskCheckpointError.capacity }

        if action == "start" {
            guard let rawKind = request["kind"]?.stringValue, let kind = Kind(rawValue: rawKind),
                  expected == 0 else { throw AssistTaskCheckpointError.invalidRequest }
            guard !next.tasks.contains(where: { $0.taskId == taskId }) else { throw AssistTaskCheckpointError.staleRevision }
            guard !next.tasks.contains(where: { $0.state == .running }) else { throw AssistTaskCheckpointError.busy }
            if next.tasks.count == Self.maximumTasks {
                // Never evict an uncertain or paused task to make room.
                guard let old = next.tasks.firstIndex(where: { $0.state == .completed || $0.state == .cancelled }) else {
                    throw AssistTaskCheckpointError.capacity
                }
                next.tasks.remove(at: old)
            }
            next.tasks.append(Entry(taskId: taskId, kind: kind, state: .running, epoch: 1, revision: 1,
                                    updatedAt: timestamp(), pauseReason: nil))
        } else {
            guard let index = next.tasks.firstIndex(where: { $0.taskId == taskId }),
                  next.tasks[index].revision == expected else { throw AssistTaskCheckpointError.staleRevision }
            var entry = next.tasks[index]
            guard entry.revision < Self.maximumRevision else { throw AssistTaskCheckpointError.capacity }
            switch action {
            case "pause":
                guard entry.state == .running else { throw AssistTaskCheckpointError.invalidTransition }
                entry.state = .paused
                entry.pauseReason = .user
            case "resume":
                guard entry.state == .paused else { throw AssistTaskCheckpointError.invalidTransition }
                guard !next.tasks.contains(where: { $0.state == .running }) else { throw AssistTaskCheckpointError.busy }
                entry.state = .running
                entry.epoch += 1
                entry.pauseReason = nil
            case "complete":
                guard entry.state == .running else { throw AssistTaskCheckpointError.invalidTransition }
                if let value = request["outcome"], value.stringValue == nil { throw AssistTaskCheckpointError.invalidRequest }
                let outcome = request["outcome"]?.stringValue ?? "completed"
                guard outcome == "completed" || outcome == "outcome_unknown" else { throw AssistTaskCheckpointError.invalidRequest }
                entry.state = outcome == "completed" ? .completed : .outcome_unknown
            case "cancel":
                guard entry.state == .running || entry.state == .paused else { throw AssistTaskCheckpointError.invalidTransition }
                entry.state = .cancelled
                entry.pauseReason = nil
            default: throw AssistTaskCheckpointError.invalidRequest
            }
            entry.revision += 1
            entry.updatedAt = timestamp()
            next.tasks[index] = entry
        }
        next.revision += 1
        try persist(next)
        return try encoded(snapshot)
    }

    /// Called on background after the caller cancels actual work. If storage
    /// fails, fail closed for this process; never pretend a resume was durable.
    func pauseActive() {
        do {
            try load()
            try checkDiskUnchanged()
            var next = snapshot
            guard interruptRunning(&next) else { return }
            try persist(next)
        } catch { blocked = true }
    }

    private func load() throws {
        guard !blocked else { throw AssistTaskCheckpointError.unavailable }
        guard !loaded else { return }
        do {
            let data = try readDisk()
            let original: Snapshot
            if let data {
                guard let json = String(data: data, encoding: .utf8) else { throw AssistTaskCheckpointError.unavailable }
                original = try decodeSnapshot(json)
            } else { original = Snapshot(schemaVersion: 1, revision: 0, tasks: []) }
            lastDiskData = data
            snapshot = original
            loaded = true
            var interrupted = original
            if interruptRunning(&interrupted) { try persist(interrupted) }
        } catch {
            blocked = true
            throw AssistTaskCheckpointError.unavailable
        }
    }

    private func interruptRunning(_ value: inout Snapshot) -> Bool {
        guard let index = value.tasks.firstIndex(where: { $0.state == .running }) else { return false }
        guard value.revision < Self.maximumRevision, value.tasks[index].revision < Self.maximumRevision else {
            blocked = true
            return false
        }
        value.tasks[index].state = .paused
        value.tasks[index].pauseReason = .interrupted
        value.tasks[index].revision += 1
        value.tasks[index].updatedAt = timestamp()
        value.revision += 1
        return true
    }

    private func readDisk() throws -> Data? {
        guard let url, url.isFileURL else { throw AssistTaskCheckpointError.unavailable }
        let attributes: [FileAttributeKey: Any]
        do { attributes = try FileManager.default.attributesOfItem(atPath: url.path) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue <= Self.maximumBytes else {
            throw AssistTaskCheckpointError.unavailable
        }
        let data = try Data(contentsOf: url)
        guard data.count <= Self.maximumBytes else { throw AssistTaskCheckpointError.unavailable }
        return data
    }

    private func checkDiskUnchanged() throws {
        do {
            guard !blocked, try readDisk() == lastDiskData else { throw AssistTaskCheckpointError.unavailable }
        } catch {
            blocked = true
            throw AssistTaskCheckpointError.unavailable
        }
    }

    private func persist(_ next: Snapshot) throws {
        do {
            try checkDiskUnchanged()
            guard let url else { throw AssistTaskCheckpointError.unavailable }
            let json = try encoded(next)
            let data = Data(json.utf8)
            let directory = url.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                     attributes: [.posixPermissions: 0o700])
            var options: Data.WritingOptions = [.atomic]
            #if os(iOS)
            options.insert(.completeFileProtection)
            #endif
            try data.write(to: url, options: options)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            snapshot = next
            lastDiskData = data
        } catch {
            blocked = true
            throw AssistTaskCheckpointError.unavailable
        }
    }

    private func encoded(_ value: Snapshot) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        guard data.count <= Self.maximumBytes, value.tasks.count <= Self.maximumTasks,
              let json = String(data: data, encoding: .utf8) else { throw AssistTaskCheckpointError.capacity }
        return json
    }

    private func decodeSnapshot(_ json: String) throws -> Snapshot {
        let value = try object(json)
        guard Set(value.keys) == ["schemaVersion", "revision", "tasks"],
              value["schemaVersion"]?.integerValue == 1,
              let revision = value["revision"]?.integerValue, (0...Self.maximumRevision).contains(revision),
              case .array(let rows) = value["tasks"], rows.count <= Self.maximumTasks else {
            throw AssistTaskCheckpointError.unavailable
        }
        var ids: Set<String> = []
        let tasks: [Entry] = try rows.map { raw in
            guard let row = raw.objectDictionary,
                  Set(row.keys).isSuperset(of: ["taskId", "kind", "state", "epoch", "revision", "updatedAt"]),
                  Set(row.keys).isSubset(of: ["taskId", "kind", "state", "epoch", "revision", "updatedAt", "pauseReason"]),
                  let id = canonicalUUID(row["taskId"]?.stringValue), ids.insert(id).inserted,
                  let rawKind = row["kind"]?.stringValue, let kind = Kind(rawValue: rawKind),
                  let rawState = row["state"]?.stringValue, let state = State(rawValue: rawState),
                  let epoch = row["epoch"]?.integerValue, (1...Self.maximumRevision).contains(epoch),
                  let entryRevision = row["revision"]?.integerValue, (epoch...Self.maximumRevision).contains(entryRevision),
                  entryRevision <= revision,
                  let date = row["updatedAt"]?.stringValue else { throw AssistTaskCheckpointError.unavailable }
            _ = try AssistToolContent.timestamp(date)
            let reason: PauseReason?
            if let field = row["pauseReason"] {
                guard let rawReason = field.stringValue, let parsed = PauseReason(rawValue: rawReason) else {
                    throw AssistTaskCheckpointError.unavailable
                }
                reason = parsed
            } else { reason = nil }
            guard (state == .paused) == (reason != nil) else { throw AssistTaskCheckpointError.unavailable }
            return Entry(taskId: id, kind: kind, state: state, epoch: epoch, revision: entryRevision,
                         updatedAt: date, pauseReason: reason)
        }
        guard tasks.filter({ $0.state == .running }).count <= 1 else { throw AssistTaskCheckpointError.unavailable }
        return Snapshot(schemaVersion: 1, revision: revision, tasks: tasks)
    }

    private func object(_ json: String) throws -> [String: AssistToolValue] {
        do {
            guard let result = try AssistToolValue.decodeJSON(json).objectDictionary else {
                throw AssistTaskCheckpointError.invalidRequest
            }
            return result
        } catch { throw AssistTaskCheckpointError.invalidRequest }
    }

    private func canonicalUUID(_ text: String?) -> String? {
        guard let text, text.utf8.count == 36, let id = UUID(uuidString: text),
              id.uuidString.lowercased() == text.lowercased() else { return nil }
        return id.uuidString.lowercased()
    }

    private func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: now())
    }
}
