import Foundation

/// Pure, bounded transport contracts. No caller can supply a path, headers,
/// cookie, destination URL, executor or service capability through a search.
enum AssistPrivateServicePolicy {
    static let maximumResponseBytes = 24 * 1_024

    struct Configuration: Codable, Sendable {
        let origin: String
        let secret: String
    }

    struct SearchRequest: Encodable, Sendable {
        let schemaVersion = 1
        let requestId: String
        let query: String
    }

    struct ReadRequest: Encodable, Sendable {
        let schemaVersion = 1
        let requestId: String
        let resultId: String
    }

    struct Ticket: Equatable, Sendable {
        let id: UUID
        let revision: UUID
    }

    /// The UI owner applies this value synchronously before cancelling a task.
    /// A late callback cannot become current again after disconnect or setup.
    struct Epoch: Sendable {
        private(set) var revision = UUID()
        private(set) var active: Ticket?
        mutating func begin() -> Ticket {
            let ticket = Ticket(id: UUID(), revision: revision)
            active = ticket
            return ticket
        }
        mutating func cancel() { active = nil }
        mutating func revoke() { active = nil; revision = UUID() }
        func accepts(_ ticket: Ticket, foreground: Bool) -> Bool {
            foreground && active == ticket && ticket.revision == revision
        }
    }

    static func origin(_ input: String) throws -> URL {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.utf8.count <= 2_048, !text.contains("\\"),
              !text.unicodeScalars.contains(where: { $0.value < 33 || $0.value == 127 }),
              var parts = URLComponents(string: text), parts.scheme == "https",
              let host = parts.host, !host.isEmpty, !host.contains("%"),
              host.unicodeScalars.allSatisfy({ $0.isASCII }),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              ["", "/"].contains(parts.percentEncodedPath),
              parts.port.map({ (1...65_535).contains($0) }) ?? true else {
            throw invalid()
        }
        parts.host = host.lowercased()
        parts.path = ""
        guard let url = parts.url, url.scheme == "https" else { throw invalid() }
        return url
    }

    static func secret(_ input: String) throws -> String {
        // ICU may match $ before a final newline; consume the complete value.
        guard (32...256).contains(input.utf8.count),
              input.range(of: #"^[A-Za-z0-9._~+/-]+={0,2}$"#, options: .regularExpression) == input.startIndex..<input.endIndex else {
            throw invalid()
        }
        return input
    }

    static func configuration(origin input: String, secret credential: String) throws -> Configuration {
        Configuration(origin: try origin(input).absoluteString, secret: try secret(credential))
    }

    static func searchRequest(_ json: String) throws -> SearchRequest {
        let row = try object(Data(json.utf8))
        guard Set(row.keys) == ["schemaVersion", "requestId", "query"], row["schemaVersion"]?.integerValue == 1,
              let id = row["requestId"]?.stringValue, identifier(id),
              let query = row["query"]?.stringValue, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              query.utf8.count <= 512,
              !query.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw invalid() }
        return SearchRequest(requestId: id, query: query.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func validateCapabilities(_ data: Data) throws {
        let row = try object(data)
        guard Set(row.keys) == ["schemaVersion", "service", "protocolVersion", "capabilities"],
              row["schemaVersion"]?.integerValue == 1,
              row["service"]?.stringValue == "assist-private-gateway",
              row["protocolVersion"]?.integerValue == 1,
              row["capabilities"] == .array([.string("search")]) else { throw invalid() }
    }

    static func validateResearchCapabilities(_ data: Data) throws {
        let row = try object(data)
        guard Set(row.keys) == ["schemaVersion", "service", "protocolVersion", "capabilities"],
              row["schemaVersion"]?.integerValue == 1,
              row["service"]?.stringValue == "assist-private-gateway",
              row["protocolVersion"]?.integerValue == 2,
              row["capabilities"] == .array([.string("search"), .string("read")]) else { throw invalid() }
    }

    static func readRequest(requestId: String, resultId: String) throws -> ReadRequest {
        guard identifier(requestId), identifier(resultId) else { throw invalid() }
        return ReadRequest(requestId: requestId, resultId: resultId)
    }

    static func readResponse(_ data: Data, requestId: String, resultId: String, title: String) throws -> AssistToolValue {
        let row = try object(data)
        guard Set(row.keys) == ["schemaVersion", "requestId", "resultId", "title", "url", "text", "truncated", "readAt", "untrusted"],
              row["schemaVersion"]?.integerValue == 1, row["requestId"]?.stringValue == requestId,
              row["resultId"]?.stringValue == resultId, row["title"]?.stringValue == title, title.utf8.count <= 256,
              let url = row["url"]?.stringValue, publicResultURL(url),
              let text = row["text"]?.stringValue, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf8.count <= 8_192, row["truncated"]?.boolValue != nil, row["untrusted"]?.boolValue == true,
              let readAt = row["readAt"]?.stringValue else { throw invalid() }
        _ = try AssistToolContent.timestamp(readAt)
        try AssistToolContent.validate(text)
        return .object(row)
    }

    static func validateResponseHeaders(status: Int, mimeType: String?, contentLength: Int64,
                                        responseURL: URL?, requestURL: URL) throws {
        guard status == 200, mimeType?.lowercased() == "application/json", responseURL == requestURL,
              contentLength >= -1, contentLength <= Int64(maximumResponseBytes) else { throw invalid() }
    }

    static func searchResponse(_ data: Data, requestId: String) throws -> String {
        let row = try object(data)
        guard Set(row.keys) == ["schemaVersion", "requestId", "results", "degraded"],
              row["schemaVersion"]?.integerValue == 1, row["requestId"]?.stringValue == requestId,
              row["degraded"]?.boolValue != nil, case .array(let results) = row["results"], results.count <= 10 else {
            throw invalid()
        }
        var ids: Set<String> = []
        for value in results {
            guard let result = value.objectDictionary, Set(result.keys) == ["id", "title", "url", "snippet"],
                  let id = result["id"]?.stringValue, identifier(id), ids.insert(id).inserted,
                  let title = result["title"]?.stringValue, title.utf8.count <= 256,
                  let snippet = result["snippet"]?.stringValue, snippet.utf8.count <= 1_024,
                  let url = result["url"]?.stringValue, publicResultURL(url) else { throw invalid() }
        }
        // Re-encode only the validated typed object. Framework/server errors,
        // transport headers and credentials never enter bridge output.
        return try AssistJSON.encode(AssistToolValue.object(row))
    }

    /// Search hits are not fetched here. Require HTTPS and public-shaped DNS
    /// names; DNS/IP/redirect validation belongs to a future actual page reader.
    static func publicResultURL(_ text: String) -> Bool {
        guard text.utf8.count <= 2_048, !text.contains("\\"),
              !text.unicodeScalars.contains(where: { $0.value < 33 || $0.value == 127 }),
              let parts = URLComponents(string: text), parts.scheme == "https",
              parts.user == nil, parts.password == nil, parts.fragment == nil,
              parts.port == nil || parts.port == 443, parts.percentEncodedHost?.contains("%") != true,
              let raw = parts.host else { return false }
        let host = raw.lowercased()
        guard host.utf8.count <= 253, host.unicodeScalars.allSatisfy({ $0.isASCII }),
              host.range(of: #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$"#,
                         options: .regularExpression) != nil else { return false }
        let labels = host.split(separator: ".")
        guard labels.allSatisfy({ $0.utf8.count <= 63 }),
              let last = labels.last, last.count >= 2, last.allSatisfy({ $0.isASCII && $0.isLetter }) else { return false }
        let reserved = ["local", "localhost", "internal", "invalid", "test", "example", "home.arpa", "localhost.localdomain",
                        "lan", "home", "ts.net"]
        return !reserved.contains { host == $0 || host.hasSuffix("." + $0) }
    }

    private static func object(_ data: Data) throws -> [String: AssistToolValue] {
        guard data.count <= maximumResponseBytes, let text = String(data: data, encoding: .utf8),
              let row = try AssistToolValue.decodeJSON(text).objectDictionary else { throw invalid() }
        return row
    }

    private static func identifier(_ value: String) -> Bool {
        value.utf8.count <= 128 && value.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]*$"#, options: .regularExpression) == value.startIndex..<value.endIndex
    }

    static func invalid() -> NSError {
        NSError(domain: "Assist.PrivateService", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Le service privé ou sa réponse ne respecte pas le contrat attendu."])
    }
}
