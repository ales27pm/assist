import Foundation

/// An image loader, not a URL reader: current official WeatherKit branding PNGs
/// only. Unsupported future formats fail closed rather than becoming web input.
enum AssistWeatherAttributionPolicy {
    static let maximumAssetBytes = 32 * 1_024
    static let maximumJSONBytes = 48 * 1_024
    static let maximumWidth = 768
    static let maximumHeight = 128
    static let maximumPixels = 65_536
    struct Request: Sendable {
        let requestId: String
        let markURL: URL
        let appearance: String
    }
    struct Asset: Codable, Sendable {
        let schemaVersion: Int
        let requestId: String
        let sourceURL: String
        let pngDataURI: String
        let width: Int
        let height: Int
        let rendered: Bool
    }
    struct Epoch: Sendable {
        private var active: [String: UUID] = [:]
        mutating func begin(_ id: String) throws -> UUID {
            guard active[id] == nil, active.count < 2 else { throw failure() }
            let ticket = UUID(); active[id] = ticket; return ticket
        }
        func accepts(_ id: String, ticket: UUID, foreground: Bool) -> Bool { foreground && active[id] == ticket }
        mutating func cancel(_ id: String) { active.removeValue(forKey: id) }
        mutating func cancelAll() { active.removeAll() }
    }
    static func identifier(_ id: String) -> Bool {
        id.utf8.count <= 128 && id.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]*$"#, options: .regularExpression) != nil
    }
    static func request(_ json: String) throws -> Request {
        guard json.utf8.count <= 2_048, let row = try AssistToolValue.decodeJSON(json).objectDictionary,
              Set(row.keys) == ["schemaVersion", "requestId", "markURL", "appearance"],
              row["schemaVersion"]?.integerValue == 1, let id = row["requestId"]?.stringValue, identifier(id),
              let raw = row["markURL"]?.stringValue, let appearance = row["appearance"]?.stringValue else { throw failure() }
        return Request(requestId: id, markURL: try markURL(raw, appearance: appearance), appearance: appearance)
    }
    static func markURL(_ raw: String, appearance: String) throws -> URL {
        guard ["light", "dark"].contains(appearance), raw.utf8.count <= 1_024,
              let parts = URLComponents(string: raw), parts.scheme == "https",
              parts.host == "weatherkit.apple.com", parts.port == nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              !raw.contains("%"), !raw.contains("\\"), !raw.contains(" "),
              parts.percentEncodedPath.range(of: #"^/assets/branding/[A-Za-z0-9-]{2,32}/Apple_Weather_(blk|wht)_[A-Za-z0-9-]{2,32}_[1-3]X_[0-9]{6}\.png$"#,
                                           options: .regularExpression) != nil,
              parts.percentEncodedPath.contains(appearance == "dark" ? "_wht_" : "_blk_"),
              let url = parts.url, url.absoluteString == raw else { throw failure() }
        return url
    }
    static func headers(status: Int, mime: String?, length: Int64, responseURL: URL?, requestURL: URL) throws {
        guard status == 200, mime?.lowercased() == "image/png", length >= -1,
              length <= maximumAssetBytes, responseURL == requestURL else { throw failure() }
    }
    static func dimensions(width: Int, height: Int) throws {
        guard width > 0, height > 0, width <= maximumWidth, height <= maximumHeight,
              width * height <= maximumPixels else { throw failure() }
    }
    static func png(_ data: Data) throws {
        guard data.count <= maximumAssetBytes, data.count >= 33,
              Array(data.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10] else { throw failure() }
    }
    static func response(_ asset: Asset) throws -> String {
        let data = try JSONEncoder().encode(asset)
        guard data.count <= maximumJSONBytes, let text = String(data: data, encoding: .utf8) else { throw failure() }
        return text
    }
    static func failure() -> NSError {
        NSError(domain: "Assist.WeatherAttribution", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "La marque officielle Apple Weather n’a pas pu être chargée ou validée. Aucune image de remplacement inventée."])
    }
}
