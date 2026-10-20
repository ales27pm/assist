import Foundation

/// Closed, path-free contracts shared by the manual UI and the tool broker.
/// Parsing is validation, never a grant of consent or authority to send a message.
enum AssistDocumentActionsPolicy {
    enum Action: String, Sendable { case scan, export_pdf, preview, read, search, index, unindex, compose }
    struct Request: Sendable {
        let requestId: String
        let action: Action
        let arguments: [String: AssistToolValue]
        var inboxId: String { arguments["inboxId"]?.stringValue ?? "" }
        func string(_ key: String) -> String { arguments[key]?.stringValue ?? "" }
        func integer(_ key: String) -> Int { arguments[key]?.integerValue ?? 0 }
        var recipients: [String] {
            guard case .array(let rows) = arguments["recipients"] else { return [] }
            return rows.compactMap(\.stringValue)
        }
    }
    static let maximumRequestBytes = 24 * 1024
    static let maximumTextBytes = 8192
    static let maximumPages = 8

    static func request(_ json: String) throws -> Request {
        guard json.utf8.count <= maximumRequestBytes,
              let row = try AssistToolValue.decodeJSON(json).objectDictionary,
              row["schemaVersion"]?.integerValue == 1,
              let requestId = row["requestId"]?.stringValue, UUID(uuidString: requestId) != nil,
              let raw = row["action"]?.stringValue, let action = Action(rawValue: raw) else { throw failure(.invalid) }
        let common: Set<String> = ["schemaVersion", "requestId", "action"]
        let fields: Set<String>
        switch action {
        case .scan: fields = ["maxPages"]
        case .export_pdf: fields = ["inboxId", "filename"]
        case .preview, .read, .unindex: fields = ["inboxId"]
        case .search: fields = ["query", "limit"]
        case .index: fields = ["inboxId", "title", "expirationDays"]
        case .compose: fields = ["channel", "recipients", "subject", "body"]
        }
        let optional: Set<String> = action == .compose ? ["attachmentId"] : []
        guard common.union(fields).isSubset(of: Set(row.keys)),
              Set(row.keys).isSubset(of: common.union(fields).union(optional)) else { throw failure(.invalid) }
        if fields.contains("inboxId") { try identifier(row["inboxId"]) }
        switch action {
        case .scan: try integer(row["maxPages"], 1...maximumPages)
        case .export_pdf:
            guard let name = row["filename"]?.stringValue,
                  !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
                  name.range(of: #"^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}\.pdf$"#, options: .regularExpression) != nil else { throw failure(.invalid) }
        case .preview, .read, .unindex: break
        case .search:
            try text(row["query"], maximum: 128, singleLine: true)
            try integer(row["limit"], 1...10)
        case .index:
            try text(row["title"], maximum: 120, singleLine: true)
            try integer(row["expirationDays"], 1...7)
        case .compose:
            guard let channel = row["channel"]?.stringValue, ["email", "sms"].contains(channel),
                  case .array(let recipients) = row["recipients"], (1...10).contains(recipients.count) else { throw failure(.invalid) }
            var unique: Set<String> = []
            for recipient in recipients {
                guard let value = recipient.stringValue, value.utf8.count <= 254,
                      validRecipient(value, channel: channel), unique.insert(value.lowercased()).inserted else { throw failure(.invalid) }
            }
            try text(row["body"], maximum: maximumTextBytes, allowEmpty: true)
            try text(row["subject"], maximum: 256, allowEmpty: true, singleLine: true)
            guard channel != "sms" || row["subject"] == .string("") else { throw failure(.invalid) }
            if let attachment = row["attachmentId"] { try identifier(attachment) }
        }
        return Request(requestId: requestId, action: action, arguments: row.filter { !common.contains($0.key) })
    }

    /// Human-readable values come from the same exact request that is executed.
    static func preview(_ request: Request) -> [String: String] {
        var result = ["action": request.action.rawValue]
        for (key, value) in request.arguments {
            switch value {
            case .string(let value): result[key] = value
            case .number(let value): result[key] = String(Int(value))
            case .array: result[key] = request.recipients.joined(separator: ", ")
            default: break
            }
        }
        if request.action == .compose { result["effect"] = "Composition Apple à revoir; l’utilisateur décide de l’envoi. Aucune preuve de livraison." }
        if request.action == .index { result["effect"] = "Rend le titre et le texte extrait du document choisi recherchables dans Spotlight sur cet appareil." }
        return result
    }

    static func response(_ request: Request, fields: [String: AssistToolValue]) throws -> String {
        var row = fields
        row["schemaVersion"] = .number(1); row["requestId"] = .string(request.requestId)
        row["action"] = .string(request.action.rawValue)
        let json = try AssistJSON.encode(AssistToolValue.object(row).validated())
        _ = try result(json, request: request)
        return json
    }

    /// Validate all native output before the broker may reinsert it into Gemma.
    @discardableResult
    static func result(_ json: String, request: Request, now: Date = Date()) throws -> AssistToolValue {
        let value = try AssistToolValue.decodeJSON(json)
        guard let row = value.objectDictionary, row["schemaVersion"]?.integerValue == 1,
              row["requestId"] == .string(request.requestId), row["action"] == .string(request.action.rawValue),
              let status = row["status"]?.stringValue else { throw failure(.invalid) }
        let common: Set<String> = ["schemaVersion", "requestId", "action", "status"]
        if status == "cancelled" {
            guard Set(row.keys) == common else { throw failure(.invalid) }
            return value
        }
        var fields: Set<String>
        switch request.action {
        case .scan:
            fields = ["inboxId", "pageCount", "byteCount", "text", "method", "truncated", "untrusted", "documentState"]
            guard status == "scanned", row["method"] == .string("vision_ocr") else { throw failure(.invalid) }
            try identifier(row["inboxId"]); try integer(row["pageCount"], 1...request.integer("maxPages"))
            try integer(row["byteCount"], 1...(8 * 1024 * 1024))
            try extracted(row)
        case .read:
            fields = ["inboxId", "kind", "text", "method", "truncated", "untrusted", "documentState"]
            guard status == "read", row["inboxId"] == .string(request.inboxId),
                  let kind = row["kind"]?.stringValue,
                  let method = ["text": "utf8", "url": "utf8", "image": "vision_ocr", "pdf": "pdf_text"][kind],
                  row["method"] == .string(method) else { throw failure(.invalid) }
            try extracted(row)
        case .preview:
            fields = ["inboxId"]
            guard status == "closed", row["inboxId"] == .string(request.inboxId) else { throw failure(.invalid) }
        case .export_pdf:
            fields = ["inboxId", "filename"]
            guard status == "exported", row["inboxId"] == .string(request.inboxId), row["filename"] == request.arguments["filename"] else { throw failure(.invalid) }
        case .index:
            fields = ["inboxId", "expiresAt"]
            guard status == "indexed", row["inboxId"] == .string(request.inboxId),
                  let raw = row["expiresAt"]?.stringValue, raw.utf8.count == 20,
                  let date = try? AssistToolContent.timestamp(raw), date > now,
                  date <= now.addingTimeInterval(Double(request.integer("expirationDays")) * 86_400) else { throw failure(.invalid) }
        case .unindex:
            fields = ["inboxId"]
            guard status == "unindexed", row["inboxId"] == .string(request.inboxId) else { throw failure(.invalid) }
        case .search:
            fields = ["results", "truncated", "untrusted"]
            guard status == "results", case .array(let results) = row["results"],
                  results.count <= request.integer("limit"), row["truncated"]?.boolValue != nil,
                  row["untrusted"] == .bool(true) else { throw failure(.invalid) }
            var ids: Set<String> = []
            for result in results {
                guard let hit = result.objectDictionary, Set(hit.keys) == ["inboxId", "title"],
                      let id = hit["inboxId"]?.stringValue, ids.insert(id).inserted else { throw failure(.invalid) }
                try identifier(hit["inboxId"]); try text(hit["title"], maximum: 120, singleLine: true)
            }
        case .compose:
            fields = ["channel", "deliveryVerified"]
            guard ["queued_by_user", "saved_draft", "cancelled_by_user", "failed"].contains(status),
                  row["channel"] == request.arguments["channel"], row["deliveryVerified"] == .bool(false) else { throw failure(.invalid) }
        }
        fields.formUnion(common)
        guard Set(row.keys) == fields else { throw failure(.invalid) }
        return value
    }

    static func validateResult(_ json: String, request: Request) -> Bool { (try? result(json, request: request)) != nil }
    private static func extracted(_ row: [String: AssistToolValue]) throws {
        guard row["truncated"]?.boolValue != nil, row["untrusted"] == .bool(true),
              let state = row["documentState"]?.stringValue, ["text", "no_text", "protected_pdf"].contains(state),
              let text = row["text"]?.stringValue, text.utf8.count <= maximumTextBytes,
              state == "text" ? !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : text.isEmpty else { throw failure(.invalid) }
        if state == "protected_pdf" {
            guard row["kind"] == .string("pdf"), row["method"] == .string("pdf_text") else { throw failure(.invalid) }
        }
    }
    private static func integer(_ value: AssistToolValue?, _ range: ClosedRange<Int>) throws {
        guard let number = value?.integerValue, range.contains(number) else { throw failure(.invalid) }
    }
    private static func text(_ value: AssistToolValue?, maximum: Int, allowEmpty: Bool = false, singleLine: Bool = false) throws {
        guard let value = value?.stringValue, value.utf8.count <= maximum,
              allowEmpty || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !value.unicodeScalars.contains(where: { $0.value == 127 || $0.value < 32 && (singleLine || ![9, 10, 13].contains($0.value)) }) else { throw failure(.invalid) }
    }
    private static func identifier(_ value: AssistToolValue?) throws {
        guard let value = value?.stringValue, UUID(uuidString: value)?.uuidString.lowercased() == value else { throw failure(.invalid) }
    }
    private static func validRecipient(_ value: String, channel: String) -> Bool {
        guard !value.unicodeScalars.contains(where: { $0.value < 33 || $0.value == 127 }) else { return false }
        if channel == "sms" { return value.range(of: #"^\+?[0-9]{3,15}$"#, options: .regularExpression) != nil }
        guard value.range(of: #"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$"#, options: .regularExpression) != nil,
              let local = value.split(separator: "@").first, local.count <= 64,
              !local.hasPrefix("."), !local.hasSuffix("."), !local.contains("..") else { return false }
        return true
    }
    enum Failure: Int { case invalid = 1, unavailable, busy, cancelled, protectedPDF, tooManyPages, noText, outcomeUnknown }
    static func failure(_ value: Failure) -> NSError {
        let message: String
        switch value {
        case .invalid: message = "Le document ou les arguments ne respectent pas le contrat attendu."
        case .unavailable: message = "Cette action est indisponible sur cet appareil ou actuellement."
        case .busy: message = "Une opération de document est déjà ouverte."
        case .cancelled: message = "Opération interrompue; les anciens résultats sont ignorés."
        case .protectedPDF: message = "PDF protégé ou chiffré : aucun mot de passe n’est demandé ni contourné."
        case .tooManyPages: message = "Le document dépasse la limite de pages. Recommence avec un document plus court."
        case .noText: message = "Aucun texte extrait. Le document n’a pas été indexé."
        case .outcomeUnknown: message = "L’opération a été soumise sans reçu définitif. Vérifie son état avant de recommencer."
        }
        return NSError(domain: "Assist.DocumentActions", code: value.rawValue, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
