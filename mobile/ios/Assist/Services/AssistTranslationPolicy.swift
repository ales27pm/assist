import Foundation

/// Bounded, closed contracts for local Apple Translation. Text is always data,
/// including when it came from Gemma, OCR, a web page or a translated result.
enum AssistTranslationPolicy {
    static let maximumTextBytes = 8_192
    static let maximumRequestBytes = 12_288
    static let maximumResponseBytes = 24_576

    enum Action: String, Sendable { case availability, translate }
    enum PairStatus: String, Sendable { case notChecked = "not_checked", installed, supported, unsupported }
    struct Request: Sendable {
        let requestId: String
        let action: Action
        let text: String
        let sourceLanguage: String
        let targetLanguage: String
        let allowDownload: Bool
    }
    struct Epoch: Sendable {
        private(set) var active: UUID?
        mutating func begin() -> UUID { let id = UUID(); active = id; return id }
        mutating func cancel() { active = nil }
        func accepts(_ id: UUID, foreground: Bool) -> Bool { active == id && foreground }
    }

    static func request(_ json: String) throws -> Request {
        guard json.utf8.count <= maximumRequestBytes,
              let row = try AssistToolValue.decodeJSON(json).objectDictionary,
              row["schemaVersion"] == .number(1),
              let requestId = row["requestId"]?.stringValue, validRequestId(requestId),
              let actionText = row["action"]?.stringValue, let action = Action(rawValue: actionText),
              let source = row["source_language"]?.stringValue,
              source.isEmpty || validLanguage(source),
              let target = row["target_language"]?.stringValue, validLanguage(target),
              let download = row["allow_download"]?.boolValue else { throw failure(.invalid) }
        let keys: Set<String> = ["schemaVersion", "requestId", "action", "source_language", "target_language", "allow_download"]
        switch action {
        case .availability:
            guard Set(row.keys) == keys, !download else { throw failure(.invalid) }
            return Request(requestId: requestId, action: action, text: "", sourceLanguage: source,
                           targetLanguage: target, allowDownload: false)
        case .translate:
            guard Set(row.keys) == keys.union(["text"]), let text = row["text"]?.stringValue,
                  validText(text) else { throw failure(.invalid) }
            return Request(requestId: requestId, action: action, text: text, sourceLanguage: source,
                           targetLanguage: target, allowDownload: download)
        }
    }

    static func validLanguage(_ value: String) -> Bool {
        value.utf8.count <= 35 && value.range(of: "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$", options: .regularExpression) == value.startIndex..<value.endIndex
    }
    static func validRequestId(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", options: .regularExpression) == value.startIndex..<value.endIndex
    }
    static func validText(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.utf8.count <= maximumTextBytes &&
            !text.contains("<|") && !text.contains("|>") && !text.unicodeScalars.contains {
                ($0.value < 32 && ![9, 10, 13].contains($0.value)) || $0.value == 127
            }
    }
    static func permits(_ status: PairStatus, allowDownload: Bool) throws {
        switch status {
        case .installed: return
        case .supported: if !allowDownload { throw failure(.downloadRequired) }
        case .unsupported: throw failure(.unsupported)
        case .notChecked: throw failure(.unavailable)
        }
    }
    static func response(_ row: [String: AssistToolValue]) throws -> String {
        let result = try AssistJSON.encode(AssistToolValue.object(row).validated())
        guard result.utf8.count <= maximumResponseBytes else { throw failure(.unavailable) }
        return result
    }

    /// Validate native output before it can reach a tool receipt or Gemma.
    /// Schema identity, pair, local-only proof and text bounds are rechecked.
    static func result(_ raw: String, request: Request) throws -> AssistToolValue {
        guard raw.utf8.count <= maximumResponseBytes else { throw failure(.unavailable) }
        let value = try AssistToolValue.decodeJSON(raw)
        guard let row = value.objectDictionary,
              row["schemaVersion"] == .number(1), row["requestId"] == .string(request.requestId),
              row["action"] == .string(request.action.rawValue), row["targetLanguage"] == .string(request.targetLanguage),
              row["localOnly"] == .bool(true), row["untrusted"] == .bool(true) else { throw failure(.unavailable) }
        switch request.action {
        case .availability:
            guard Set(row.keys) == ["schemaVersion", "requestId", "action", "languages", "sourceLanguage", "targetLanguage", "status", "localOnly", "untrusted"],
                  row["sourceLanguage"] == .string(request.sourceLanguage),
                  let rawStatus = row["status"]?.stringValue, let status = PairStatus(rawValue: rawStatus),
                  request.sourceLanguage.isEmpty == (status == .notChecked),
                  case .array(let languages) = row["languages"], languages.count <= 64 else { throw failure(.unavailable) }
            var identifiers: Set<String> = []
            for value in languages {
                guard let language = value.objectDictionary, Set(language.keys) == ["identifier", "label"],
                      let identifier = language["identifier"]?.stringValue, validLanguage(identifier),
                      identifiers.insert(identifier).inserted,
                      let label = language["label"]?.stringValue, validText(label), label.utf8.count <= 128 else { throw failure(.unavailable) }
            }
        case .translate:
            guard Set(row.keys) == ["schemaVersion", "requestId", "action", "sourceLanguage", "targetLanguage", "sourceDetected", "translatedText", "status", "localOnly", "untrusted"],
                  row["status"] == .string("installed"), row["sourceDetected"] == .bool(request.sourceLanguage.isEmpty),
                  let source = row["sourceLanguage"]?.stringValue, validLanguage(source),
                  request.sourceLanguage.isEmpty || source == request.sourceLanguage,
                  let text = row["translatedText"]?.stringValue, validText(text) else { throw failure(.unavailable) }
        }
        return value
    }

    enum Failure: Int, Sendable { case invalid = 1, busy, cancelled, languageUndetermined, unsupported, downloadRequired, unavailable }
    static func failure(_ value: Failure) -> NSError {
        let message: String
        switch value {
        case .invalid: message = "Le texte ou les langues ne respectent pas le contrat de traduction."
        case .busy: message = "Une traduction est déjà en cours."
        case .cancelled: message = "La traduction a été interrompue; aucun résultat tardif n’a été conservé."
        case .languageUndetermined: message = "La langue source est incertaine. Choisis une langue source pour continuer."
        case .unsupported: message = "Cette paire de langues n’est pas prise en charge par Apple Traduction."
        case .downloadRequired: message = "Ces langues ne sont pas installées. Autorise leur téléchargement pour continuer."
        case .unavailable: message = "La traduction locale est indisponible. Aucun service distant n’a été utilisé."
        }
        return NSError(domain: "AssistTranslation", code: value.rawValue, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
