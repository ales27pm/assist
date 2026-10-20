import Foundation

/// Closed contracts for explicit locations only. This layer never requests the
/// device location, expands a destination URL or chooses a transport for a caller.
enum AssistApplePlacesPolicy {
    static let maximumRequestBytes = 2_048
    static let maximumResponseBytes = 24 * 1_024

    struct Coordinate: Equatable, Sendable {
        let latitude: Double
        let longitude: Double
        var value: AssistToolValue {
            .object(["latitude": .number(latitude), "longitude": .number(longitude)])
        }
    }
    struct Search: Sendable { let requestId: String; let query: String; let limit: Int }
    struct Directions: Sendable {
        let requestId: String
        let origin: Coordinate
        let destination: Coordinate
        let transport: String
    }
    struct Forecast: Sendable {
        let requestId: String
        let coordinate: Coordinate
        let unit: String
        let hourlyCount: Int
        let dailyCount: Int
    }
    struct Epoch: Sendable {
        private(set) var active: UUID?
        mutating func begin() -> UUID { let id = UUID(); active = id; return id }
        mutating func cancel() { active = nil }
        func accepts(_ id: UUID, foreground: Bool) -> Bool { foreground && active == id }
    }
    struct ResultScope: Sendable {
        let requestId: String
        let createdAt: Date
        let ids: Set<String>
        func accepts(requestId: String, resultId: String, now: Date, foreground: Bool) -> Bool {
            let age = now.timeIntervalSince(createdAt)
            return foreground && self.requestId == requestId && ids.contains(resultId) && age >= 0 && age <= 600
        }
    }

    static func search(_ json: String) throws -> Search {
        let row = try object(json, keys: ["schemaVersion", "requestId", "query", "limit"])
        guard let text = row["query"]?.stringValue, let limit = row["limit"]?.integerValue,
              (1...10).contains(limit) else { throw failure(.invalid) }
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, query.utf8.count <= 256,
              !query.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw failure(.invalid) }
        return Search(requestId: try requestId(row), query: query, limit: limit)
    }

    static func directions(_ json: String) throws -> Directions {
        let row = try object(json, keys: ["schemaVersion", "requestId", "origin", "destination", "transport"])
        guard let transport = row["transport"]?.stringValue,
              ["walking", "automobile"].contains(transport) else { throw failure(.invalid) }
        return Directions(requestId: try requestId(row), origin: try coordinate(row["origin"]),
                          destination: try coordinate(row["destination"]), transport: transport)
    }

    static func forecast(_ json: String) throws -> Forecast {
        let row = try object(json, keys: ["schemaVersion", "requestId", "coordinate", "unit", "hourlyCount", "dailyCount"])
        guard let unit = row["unit"]?.stringValue, ["celsius", "fahrenheit"].contains(unit),
              let hourly = row["hourlyCount"]?.integerValue, (0...12).contains(hourly),
              let daily = row["dailyCount"]?.integerValue, (0...5).contains(daily) else { throw failure(.invalid) }
        return Forecast(requestId: try requestId(row), coordinate: try coordinate(row["coordinate"]),
                        unit: unit, hourlyCount: hourly, dailyCount: daily)
    }

    static func coordinate(_ value: AssistToolValue?) throws -> Coordinate {
        guard let row = value?.objectDictionary, Set(row.keys) == ["latitude", "longitude"],
              case .number(let latitude) = row["latitude"], case .number(let longitude) = row["longitude"],
              latitude.isFinite, longitude.isFinite, (-90...90).contains(latitude),
              (-180...180).contains(longitude) else { throw failure(.invalid) }
        return Coordinate(latitude: latitude, longitude: longitude)
    }

    /// Broker-owned wire request. Request identity and nested coordinates are
    /// constructed only after the tactile confirmation; model arguments stay flat.
    static func toolRequest(_ call: AssistDeviceToolCall, operationId: UUID) throws -> String {
        let call = try AssistDeviceToolRegistry.validate(call: call)
        var row: [String: AssistToolValue] = ["schemaVersion": .number(1), "requestId": .string(operationId.uuidString)]
        func point(_ latitude: String, _ longitude: String) -> AssistToolValue {
            .object(["latitude": call.arguments[latitude]!, "longitude": call.arguments[longitude]!])
        }
        switch call.name {
        case .maps_search:
            row["query"] = call.arguments["query"]; row["limit"] = call.arguments["limit"]
        case .maps_directions:
            row["origin"] = point("origin_latitude", "origin_longitude")
            row["destination"] = point("destination_latitude", "destination_longitude")
            row["transport"] = call.arguments["transport"]
        case .weather_forecast:
            row["coordinate"] = point("latitude", "longitude"); row["unit"] = call.arguments["unit"]
            row["hourlyCount"] = call.arguments["hourly_count"]; row["dailyCount"] = call.arguments["daily_count"]
        default: throw failure(.invalid)
        }
        return try AssistJSON.encode(AssistToolValue.object(row))
    }

    /// Validate native results as strictly as model proposals. No arbitrary JSON,
    /// extra field, swapped coordinate or forged provider enters Gemma/a receipt.
    static func toolResult(_ raw: String, call: AssistDeviceToolCall, operationId: UUID) throws -> AssistToolValue {
        let value = try AssistToolValue.decodeJSON(raw)
        guard let row = value.objectDictionary, row["schemaVersion"] == .number(1),
              row["requestId"] == .string(operationId.uuidString) else { throw failure(.unavailable) }
        let request = try toolRequest(call, operationId: operationId)
        func exact(_ row: [String: AssistToolValue], _ keys: Set<String>) throws {
            guard Set(row.keys) == keys else { throw failure(.unavailable) }
        }
        func text(_ row: [String: AssistToolValue], _ key: String, _ maximum: Int, empty: Bool = false) throws {
            guard let text = row[key]?.stringValue, text.utf8.count <= maximum,
                  empty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw failure(.unavailable) }
        }
        func number(_ row: [String: AssistToolValue], _ key: String, min: Double = -Double.greatestFiniteMagnitude,
                    max: Double = Double.greatestFiniteMagnitude) throws {
            guard case .number(let number) = row[key], number.isFinite, number >= min, number <= max else { throw failure(.unavailable) }
        }
        func date(_ row: [String: AssistToolValue], _ key: String) throws {
            guard let value = row[key]?.stringValue else { throw failure(.unavailable) }
            _ = try AssistToolContent.timestamp(value)
        }
        switch call.name {
        case .maps_search:
            let query = try search(request)
            try exact(row, ["schemaVersion", "requestId", "provider", "results", "truncated", "untrusted"])
            guard row["provider"] == .string("Apple Maps"), row["untrusted"] == .bool(true),
                  row["truncated"]?.boolValue != nil, case .array(let results) = row["results"],
                  results.count <= query.limit else { throw failure(.unavailable) }
            var ids: Set<String> = []
            for value in results {
                guard let item = value.objectDictionary else { throw failure(.unavailable) }
                try exact(item, ["id", "name", "address", "coordinate"])
                let id = try requestId(["requestId": item["id"]!])
                guard ids.insert(id).inserted else { throw failure(.unavailable) }
                try text(item, "name", 256, empty: true); try text(item, "address", 512, empty: true)
                _ = try coordinate(item["coordinate"])
            }
        case .maps_directions:
            let query = try directions(request)
            try exact(row, ["schemaVersion", "requestId", "provider", "origin", "destination", "transport",
                            "distanceMeters", "expectedTravelSeconds", "name", "calculatedAt", "estimateOnly", "navigationStarted"])
            guard row["provider"] == .string("Apple Maps"), row["origin"] == query.origin.value,
                  row["destination"] == query.destination.value, row["transport"] == .string(query.transport),
                  row["estimateOnly"] == .bool(true), row["navigationStarted"] == .bool(false) else { throw failure(.unavailable) }
            try number(row, "distanceMeters", min: 0); try number(row, "expectedTravelSeconds", min: 0)
            try text(row, "name", 256, empty: true); try date(row, "calculatedAt")
        case .weather_forecast:
            let query = try forecast(request)
            try exact(row, ["schemaVersion", "requestId", "coordinate", "temperatureUnit", "retrievedAt", "attribution", "current", "hourly", "daily", "forecastNotGuarantee"])
            guard row["coordinate"] == query.coordinate.value, row["temperatureUnit"] == .string(query.unit),
                  row["forecastNotGuarantee"] == .bool(true), let credit = row["attribution"]?.objectDictionary,
                  let current = row["current"]?.objectDictionary, case .array(let hours) = row["hourly"],
                  case .array(let days) = row["daily"], hours.count <= query.hourlyCount, days.count <= query.dailyCount else { throw failure(.unavailable) }
            try date(row, "retrievedAt")
            try exact(credit, ["serviceName", "legalPageURL", "combinedMarkLightURL", "combinedMarkDarkURL", "legalAttributionText"])
            try text(credit, "serviceName", 256); try text(credit, "legalAttributionText", 4_096)
            for key in ["legalPageURL", "combinedMarkLightURL", "combinedMarkDarkURL"] {
                guard let raw = credit[key]?.stringValue, let url = URL(string: raw), try attributionURL(url) == raw,
                      let host = url.host, host == "apple.com" || host.hasSuffix(".apple.com") else { throw failure(.unavailable) }
            }
            try exact(current, ["date", "condition", "symbolName", "temperature", "apparentTemperature", "humidity", "windKilometersPerHour"])
            try date(current, "date"); try text(current, "condition", 128); try text(current, "symbolName", 128)
            try number(current, "temperature"); try number(current, "apparentTemperature")
            try number(current, "humidity", min: 0, max: 1); try number(current, "windKilometersPerHour", min: 0)
            for value in hours {
                guard let hour = value.objectDictionary else { throw failure(.unavailable) }
                try exact(hour, ["date", "condition", "temperature", "precipitationChance"])
                try date(hour, "date"); try text(hour, "condition", 128); try number(hour, "temperature")
                try number(hour, "precipitationChance", min: 0, max: 1)
            }
            for value in days {
                guard let day = value.objectDictionary else { throw failure(.unavailable) }
                try exact(day, ["date", "condition", "highTemperature", "lowTemperature", "precipitationChance"])
                try date(day, "date"); try text(day, "condition", 128)
                try number(day, "highTemperature"); try number(day, "lowTemperature"); try number(day, "precipitationChance", min: 0, max: 1)
                guard case .number(let high) = day["highTemperature"], case .number(let low) = day["lowTemperature"], high >= low else { throw failure(.unavailable) }
            }
        default: throw failure(.invalid)
        }
        return value
    }

    /// WeatherKit attribution comes from WeatherService.attribution, not a
    /// fabricated provider or a hard-coded legal page. Reject malformed URLs.
    static func attributionURL(_ url: URL) throws -> String {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.fragment == nil,
              parts.port == nil || parts.port == 443, url.absoluteString.utf8.count <= 2_048 else {
            throw failure(.unavailable)
        }
        return url.absoluteString
    }

    static func boundedText(_ value: String, maximumBytes: Int) -> String {
        var text = String(value.prefix(maximumBytes))
        while text.utf8.count > maximumBytes { text.removeLast() }
        return text
    }

    static func response(_ row: [String: AssistToolValue]) throws -> String {
        let value = try AssistToolValue.object(row).validated()
        let encoded = try AssistJSON.encode(value)
        guard encoded.utf8.count <= maximumResponseBytes else { throw failure(.unavailable) }
        return encoded
    }

    enum Failure: Int, Sendable { case invalid = 1, busy, cancelled, network, weatherAuthorization, unavailable, attributionUnavailable }
    static func failure(_ failure: Failure) -> NSError {
        let message: String
        switch failure {
        case .invalid: message = "Les coordonnées ou paramètres ne respectent pas le contrat attendu."
        case .busy: message = "Une opération Cartes ou Météo est déjà en cours."
        case .cancelled: message = "L’opération a été interrompue; aucun ancien résultat n’a été réutilisé."
        case .network: message = "Le service Apple est inaccessible sur le réseau pour le moment."
        case .weatherAuthorization: message = "WeatherKit n’est pas autorisé pour cette build ou ce compte Apple."
        case .unavailable: message = "Le service Apple n’a pas fourni de résultat utilisable."
        case .attributionUnavailable: message = "L’attribution Apple Weather n’a pas pu être obtenue ou validée. Aucune prévision n’est affichée."
        }
        return NSError(domain: "Assist.ApplePlaces", code: failure.rawValue,
                       userInfo: [NSLocalizedDescriptionKey: message])
    }

    private static func object(_ json: String, keys: Set<String>) throws -> [String: AssistToolValue] {
        guard json.utf8.count <= maximumRequestBytes,
              let row = try AssistToolValue.decodeJSON(json).objectDictionary,
              Set(row.keys) == keys, row["schemaVersion"]?.integerValue == 1 else { throw failure(.invalid) }
        return row
    }
    private static func requestId(_ row: [String: AssistToolValue]) throws -> String {
        guard let id = row["requestId"]?.stringValue, id.utf8.count <= 128,
              id.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]*$"#, options: .regularExpression) != nil else {
            throw failure(.invalid)
        }
        return id
    }
}
