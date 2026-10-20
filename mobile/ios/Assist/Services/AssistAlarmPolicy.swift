import Foundation

/// Closed AlarmKit boundary. Ownership refers only to IDs durably reserved by
/// Assist; never to arbitrary Clock alarms or an ID supplied as an instruction.
enum AssistAlarmPolicy {
    static let maximumRequestBytes = 2_048
    static let maximumResultBytes = 256 * 1_024
    static let maximumItems = 1_024
    static let maximumOperations = 4_096

    enum Action: String, Codable, Sendable { case list, create, update, stop, cancel }
    enum Kind: String, Codable, Sendable { case alarm, timer }
    enum Status: String, Codable, Sendable { case succeeded, failed_safe, outcome_unknown }
    enum State: String, Codable, Sendable { case scheduled, countdown, paused, alerting, not_present, unknown }
    enum Code: String, Codable, Sendable {
        case ok, cancelled, permission_denied, unavailable, storage_unavailable
        case ownership_required, operation_conflict, outcome_unknown, not_found, limit_reached
    }
    struct Request: Codable, Equatable, Sendable {
        let schemaVersion: Int
        let requestId: String
        let operationId: String
        let action: Action
        let alarm_id: String?
        let kind: Kind?
        let title: String?
        let date_iso: String?
        let duration_seconds: Int?
        var id: UUID { UUID(uuidString: operationId)! }
        var alarmID: UUID? { alarm_id.flatMap(UUID.init(uuidString:)) }
    }
    struct Item: Codable, Equatable, Sendable {
        let alarm_id: String
        let kind: Kind
        let title: String
        let date_iso: String?
        let duration_seconds: Int?
        var state: State
        var uncertain: Bool
        init(request: Request, state: State = .unknown, uncertain: Bool = true) {
            alarm_id = request.alarm_id!; kind = request.kind!; title = request.title!
            date_iso = request.date_iso; duration_seconds = request.duration_seconds
            self.state = state; self.uncertain = uncertain
        }
    }
    struct Receipt: Codable, Equatable, Sendable {
        let schemaVersion: Int
        let requestId: String
        let operationId: String
        let action: Action
        let status: Status
        let code: Code
        let items: [Item]
    }
    /// pending is persisted *before* the first framework mutation. Retrying an
    /// interrupted operation returns uncertainty rather than resubmitting it.
    struct Operation: Codable, Equatable, Sendable {
        let request: Request
        var submitted: Bool
        var resolved = false
        var receipt: Receipt?
    }
    struct Journal: Codable, Equatable, Sendable {
        var schemaVersion = 1
        var items: [String: Item] = [:]
        var operations: [String: Operation] = [:]

        mutating func reserve(_ request: Request) throws {
            guard request.action != .list, operations[request.operationId] == nil else { throw failure(.operation_conflict) }
            guard operations.count < maximumOperations else { throw failure(.limit_reached) }
            if request.action == .create {
                guard request.alarm_id == request.operationId, items[request.alarm_id!] == nil,
                      items.count < maximumItems else { throw failure(.ownership_required) }
                items[request.alarm_id!] = Item(request: request)
            } else {
                guard let id = request.alarm_id, items[id] != nil else { throw failure(.ownership_required) }
                // Explicit cancellation may reconcile an uncertain submission.
                if request.action != .cancel {
                    guard !operations.values.contains(where: {
                        $0.request.alarm_id == id && $0.submitted && !$0.resolved &&
                        ($0.receipt == nil || $0.receipt?.status == .outcome_unknown)
                    }) else { throw failure(.outcome_unknown) }
                }
            }
            operations[request.operationId] = Operation(request: request, submitted: false, receipt: nil)
        }
        func previous(_ request: Request) throws -> Operation? {
            guard let operation = operations[request.operationId] else { return nil }
            guard operation.request == request else { throw failure(.operation_conflict) }
            return operation
        }
        mutating func reconcile(_ states: [String: State]) {
            for (id, var item) in items {
                item.state = states[id] ?? .not_present
                item.uncertain = operations.values.contains {
                    $0.request.alarm_id == id && $0.submitted && !$0.resolved && ($0.receipt == nil || $0.receipt?.status == .outcome_unknown)
                }
                items[id] = item
            }
        }
    }

    /// nil is reserved for validating an already-admitted request while checking
    /// its receipt; time passing after scheduling must not invalidate a real ACK.
    static func request(_ raw: String, now: Date? = Date()) throws -> Request {
        guard let data = raw.data(using: .utf8), data.count <= maximumRequestBytes,
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let request = try? JSONDecoder().decode(Request.self, from: data),
              request.schemaVersion == 1, canonicalUUID(request.requestId),
              request.requestId == request.operationId else { throw failure(.unavailable) }
        let base: Set<String> = ["schemaVersion", "requestId", "operationId", "action"]
        let expected: Set<String>
        switch request.action {
        case .list: expected = base
        case .stop, .cancel: expected = base.union(["alarm_id"])
        case .create, .update:
            expected = base.union(["alarm_id", "kind", "title", request.kind == .alarm ? "date_iso" : "duration_seconds"])
            guard let title = request.title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  title.utf8.count <= 120,
                  !title.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
                  let kind = request.kind else { throw failure(.unavailable) }
            if kind == .alarm {
                guard let rawDate = request.date_iso, let date = parseDate(rawDate) else { throw failure(.unavailable) }
                if let now {
                    guard date.timeIntervalSince(now) >= 1, date.timeIntervalSince(now) <= 366 * 86_400 else { throw failure(.unavailable) }
                }
            } else {
                guard let duration = request.duration_seconds, (1...86_400).contains(duration) else { throw failure(.unavailable) }
            }
        }
        guard Set(row.keys) == expected,
              request.action == .list || (request.alarm_id.map(canonicalUUID) == true),
              request.action != .create || request.alarm_id == request.operationId else { throw failure(.unavailable) }
        return request
    }
    static func receipt(_ request: Request, status: Status, code: Code, items: [Item]) -> Receipt {
        Receipt(schemaVersion: 1, requestId: request.requestId, operationId: request.operationId,
                action: request.action, status: status, code: code, items: items.sorted { $0.alarm_id < $1.alarm_id })
    }
    static func encode(_ receipt: Receipt) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(receipt)
        guard data.count <= maximumResultBytes, let raw = String(data: data, encoding: .utf8) else { throw failure(.unavailable) }
        return raw
    }
    static func result(_ raw: String, request: Request) throws -> Receipt {
        guard let data = raw.data(using: .utf8), data.count <= maximumResultBytes,
              let value = try? JSONDecoder().decode(Receipt.self, from: data),
              value.schemaVersion == 1, value.requestId == request.requestId, value.operationId == request.operationId,
              value.action == request.action, value.items.count <= maximumItems,
              Set(value.items.map(\.alarm_id)).count == value.items.count,
              (value.status == .succeeded ? value.code == .ok : value.code != .ok),
              value.status != .outcome_unknown || value.code == .outcome_unknown else { throw failure(.unavailable) }
        for item in value.items { try validate(item) }
        // JSONDecoder ignores extra fields; exact re-encoding comparison rejects
        // unknown fields and null optionals without duplicating the wire schema.
        guard let decoded = try JSONSerialization.jsonObject(with: data) as? NSDictionary,
              let canonical = try JSONSerialization.jsonObject(with: Data(encode(value).utf8)) as? NSDictionary,
              decoded == canonical else { throw failure(.unavailable) }
        return value
    }
    static func validate(_ item: Item) throws {
        guard canonicalUUID(item.alarm_id), !item.title.isEmpty, item.title.utf8.count <= 120,
              !item.title.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw failure(.unavailable) }
        switch item.kind {
        case .alarm: guard item.duration_seconds == nil, let date = item.date_iso, parseDate(date) != nil else { throw failure(.unavailable) }
        case .timer: guard item.date_iso == nil, let duration = item.duration_seconds, (1...86_400).contains(duration) else { throw failure(.unavailable) }
        }
    }
    static func validate(_ journal: Journal) throws {
        guard journal.schemaVersion == 1, journal.items.count <= maximumItems,
              journal.operations.count <= maximumOperations else { throw failure(.storage_unavailable) }
        for (id, item) in journal.items { guard id == item.alarm_id else { throw failure(.storage_unavailable) }; try validate(item) }
        for (id, operation) in journal.operations {
            guard id == operation.request.operationId, canonicalUUID(id), operation.request.action != .list,
                  let alarmID = operation.request.alarm_id, journal.items[alarmID] != nil else { throw failure(.storage_unavailable) }
            if let receipt = operation.receipt { _ = try result(encode(receipt), request: operation.request) }
        }
    }
    static func canonicalUUID(_ raw: String) -> Bool { UUID(uuidString: raw)?.uuidString == raw }
    static func parseDate(_ raw: String) -> Date? {
        guard raw.utf8.count <= 40, raw.contains("T"), raw.hasSuffix("Z") || raw.range(of: #"[+-]\d\d:\d\d$"#, options: .regularExpression) != nil else { return nil }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: raw) { return date }
        formatter.formatOptions = [.withInternetDateTime]; return formatter.date(from: raw)
    }
    static func failure(_ code: Code) -> NSError {
        NSError(domain: "AssistAlarms", code: 1, userInfo: [NSLocalizedDescriptionKey: code.rawValue])
    }
}
