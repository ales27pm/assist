import Foundation

/// Closed, transport-independent values. Native values are validated before
/// entering a model prompt; a tool result can never become a protocol marker.
indirect enum AssistToolValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([Self])
    case object([String: Self])

    var foundationObject: Any {
        switch self {
        case .string(let value): value
        case .number(let value): Self.sendableNumber(value)
        case .bool(let value): value
        case .null: NSNull()
        case .array(let values): values.map(\.foundationObject)
        case .object(let values): values.mapValues(\.foundationObject)
        }
    }

    var sendableValue: any Sendable {
        switch self {
        case .string(let value): value
        case .number(let value): Self.sendableNumber(value)
        case .bool(let value): value
        case .null: Optional<String>.none as (any Sendable)
        case .array(let values): values.map(\.sendableValue)
        case .object(let values): values.mapValues(\.sendableValue)
        }
    }

    private static func sendableNumber(_ value: Double) -> any Sendable {
        if value.isFinite, value.rounded(.towardZero) == value,
           value >= Double(Int.min), value < Double(Int.max) { return Int(value) }
        return value
    }

    var objectDictionary: [String: Self]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }
    var integerValue: Int? {
        guard case .number(let value) = self, value.isFinite,
              value.rounded(.towardZero) == value, value >= Double(Int.min), value < Double(Int.max) else { return nil }
        return Int(value)
    }
    var boolValue: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }

    static let maximumJSONBytes = 24 * 1_024
    static let maximumStringBytes = 8_192

    /// Use this entry point for raw native JSON. Unlike JSONDecoder's object
    /// container, this bounded reader also rejects duplicate decoded keys.
    static func decodeJSON(_ json: String) throws -> Self {
        guard json.utf8.count <= maximumJSONBytes else { throw AssistToolContractError.oversizedValue }
        var reader = AssistToolJSONReader(bytes: Array(json.utf8))
        let value = try reader.value(depth: 0)
        reader.whitespace()
        guard reader.finished else { throw AssistToolContractError.invalidValue }
        return try value.validated()
    }

    @discardableResult
    func validated() throws -> Self {
        var remaining = 512
        try validate(depth: 0, remaining: &remaining)
        guard try JSONEncoder().encode(self).count <= Self.maximumJSONBytes else { throw AssistToolContractError.oversizedValue }
        return self
    }

    private func validate(depth: Int, remaining: inout Int) throws {
        guard depth <= 8, remaining > 0 else { throw AssistToolContractError.oversizedValue }
        remaining -= 1
        switch self {
        case .string(let text):
            guard text.utf8.count <= Self.maximumStringBytes else { throw AssistToolContractError.oversizedValue }
            try AssistToolContent.validate(text)
        case .number(let value):
            guard value.isFinite else { throw AssistToolContractError.invalidValue }
        case .array(let values):
            for value in values { try value.validate(depth: depth + 1, remaining: &remaining) }
        case .object(let values):
            for (key, value) in values {
                guard !key.isEmpty, key.utf8.count <= 128 else { throw AssistToolContractError.invalidValue }
                try AssistToolContent.validate(key)
                try value.validate(depth: depth + 1, remaining: &remaining)
            }
        case .bool, .null: break
        }
    }

    init(from decoder: any Decoder) throws {
        guard decoder.codingPath.count <= 8 else { throw AssistToolContractError.oversizedValue }
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Double.self), value.isFinite { self = .number(value) }
        else if let value = try? container.decode([Self].self) { self = .array(value) }
        else if let value = try? container.decode([String: Self].self) { self = .object(value) }
        else { throw AssistToolContractError.invalidValue }
        _ = try validated()
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value):
            guard value.isFinite else { throw AssistToolContractError.invalidValue }
            try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        case .array(let values): try container.encode(values)
        case .object(let values): try container.encode(values)
        }
    }
}

enum AssistToolName: String, CaseIterable, Codable, Sendable {
    case contacts_search, calendar_list, calendar_create, reminders_list, reminder_create
    case location_current, photo_select, camera_capture, notification_schedule
    case biometrics_status, biometrics_authenticate, device_capabilities, native_boundary
    case maps_search, maps_directions, weather_forecast
    case alarm_list, alarm_create, alarm_update, alarm_stop, alarm_cancel
    case translation_languages, text_translate
    case document_scan, document_export_pdf, document_preview, document_read, document_search, document_index, document_unindex, message_compose

    static var legacyCases: [Self] { Array(allCases.prefix(13)) }
    var isExtended: Bool { Self.allCases.firstIndex(of: self)! >= 16 }
    var execution: String { [.maps_search, .maps_directions, .weather_forecast].contains(self) ? "apple_network" : "device" }

    var effect: AssistToolEffect { AssistDeviceToolRegistry.effect(of: self) }
}

enum AssistToolEffect: String, Codable, Sendable { case read, write, interactive }

struct AssistDeviceToolCall: Codable, Equatable, Sendable {
    let name: AssistToolName
    let arguments: [String: AssistToolValue]
}

enum AssistToolContractError: Error, LocalizedError {
    case invalidValue, invalidArguments, oversizedValue, unsafeContent, invalidOutput
    var errorDescription: String? {
        switch self {
        case .invalidValue: "Le résultat natif ne respecte pas le contrat des outils."
        case .invalidArguments: "Les arguments de l’outil sont invalides."
        case .oversizedValue: "Le contenu dépasse les limites de sécurité des outils."
        case .unsafeContent: "Le contenu comporte des délimiteurs réservés au protocole du modèle."
        case .invalidOutput: "La réponse ne respecte pas le protocole des outils."
        }
    }
}

enum AssistDeviceToolRegistry {
    typealias Definition = [String: any Sendable]

    static func effect(of name: AssistToolName) -> AssistToolEffect {
        switch name {
        case .calendar_create, .reminder_create, .notification_schedule, .alarm_create, .alarm_update, .alarm_stop, .alarm_cancel, .document_index, .document_unindex: .write
        case .photo_select, .camera_capture, .biometrics_authenticate, .text_translate, .document_scan, .document_export_pdf, .document_preview, .message_compose: .interactive
        default: .read
        }
    }

    static let boundaryFeatures = ["telephony", "sms", "systemSettings", "backgroundLocation"]

    static var definitions: [Definition] { AssistToolName.allCases.map(definition) }

    /// Model arguments are a closed flat dictionary. Destination calendar IDs,
    /// notification identifiers and consent tokens belong to the host only.
    static func validate(call: AssistDeviceToolCall, now: Date = Date()) throws -> AssistDeviceToolCall {
        _ = try AssistToolValue.object(call.arguments).validated()
        if call.name.isExtended { return try AssistExtendedToolsPolicy.validate(call, now: now) }
        var arguments = call.arguments
        func keys(_ required: Set<String>, optional: Set<String> = []) throws {
            let actual = Set(arguments.keys)
            guard required.isSubset(of: actual), actual.isSubset(of: required.union(optional)) else {
                throw AssistToolContractError.invalidArguments
            }
        }
        func text(_ key: String, maximum: Int, trim: Bool = false, empty: Bool = false) throws -> String {
            guard case .string(let raw) = arguments[key] else { throw AssistToolContractError.invalidArguments }
            let value = trim ? raw.trimmingCharacters(in: .whitespacesAndNewlines) : raw
            guard (empty || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty),
                  value.utf8.count <= maximum else { throw AssistToolContractError.invalidArguments }
            return value
        }
        func limit() throws {
            guard let count = arguments["limit"]?.integerValue, (1...5).contains(count) else {
                throw AssistToolContractError.invalidArguments
            }
        }
        func interval(maximumDays: Int = 31) throws {
            guard let startRaw = arguments["start_iso"]?.stringValue,
                  let endRaw = arguments["end_iso"]?.stringValue else { throw AssistToolContractError.invalidArguments }
            let start = try AssistToolContent.timestamp(startRaw)
            let end = try AssistToolContent.timestamp(endRaw)
            guard end > start, end.timeIntervalSince(start) <= Double(maximumDays) * 86_400 else { throw AssistToolContractError.invalidArguments }
        }
        func coordinate(_ latitude: String, _ longitude: String) throws {
            guard case .number(let lat) = arguments[latitude], case .number(let lon) = arguments[longitude],
                  lat.isFinite, lon.isFinite, (-90...90).contains(lat), (-180...180).contains(lon) else {
                throw AssistToolContractError.invalidArguments
            }
        }
        switch call.name {
        case .alarm_list, .alarm_create, .alarm_update, .alarm_stop, .alarm_cancel, .translation_languages, .text_translate, .document_scan, .document_export_pdf, .document_preview, .document_read, .document_search, .document_index, .document_unindex, .message_compose:
            throw AssistToolContractError.invalidArguments // handled by the extended registry above
        case .maps_search:
            try keys(["query", "limit"]); try limit()
            let query = try text("query", maximum: 256, trim: true)
            guard !query.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw AssistToolContractError.invalidArguments }
            arguments["query"] = .string(query)
        case .maps_directions:
            try keys(["origin_latitude", "origin_longitude", "destination_latitude", "destination_longitude", "transport"])
            try coordinate("origin_latitude", "origin_longitude"); try coordinate("destination_latitude", "destination_longitude")
            guard ["walking", "automobile"].contains(try text("transport", maximum: 16)) else { throw AssistToolContractError.invalidArguments }
        case .weather_forecast:
            try keys(["latitude", "longitude", "unit", "hourly_count", "daily_count"])
            try coordinate("latitude", "longitude")
            guard ["celsius", "fahrenheit"].contains(try text("unit", maximum: 16)),
                  let hourly = arguments["hourly_count"]?.integerValue, (0...12).contains(hourly),
                  let daily = arguments["daily_count"]?.integerValue, (0...5).contains(daily) else { throw AssistToolContractError.invalidArguments }
        case .contacts_search:
            try keys(["query", "limit"]); try limit()
            arguments["query"] = .string(try text("query", maximum: 256, trim: true))
        case .calendar_list:
            try keys(["start_iso", "end_iso", "limit"]); try limit(); try interval()
        case .calendar_create:
            try keys(["title", "start_iso", "end_iso"], optional: ["notes", "location"])
            try interval(maximumDays: 366)
            arguments["title"] = .string(try text("title", maximum: 512, trim: true))
            if arguments["notes"] != nil { arguments["notes"] = .string(try text("notes", maximum: 4_000, empty: true)) }
            if arguments["location"] != nil { arguments["location"] = .string(try text("location", maximum: 512, empty: true)) }
        case .reminders_list:
            try keys(["start_iso", "end_iso", "include_completed", "limit"])
            try limit(); try interval()
            guard arguments["include_completed"]?.boolValue != nil else { throw AssistToolContractError.invalidArguments }
        case .reminder_create:
            try keys(["title"], optional: ["due_iso", "notes"])
            arguments["title"] = .string(try text("title", maximum: 512, trim: true))
            if arguments["due_iso"] != nil { _ = try AssistToolContent.timestamp(text("due_iso", maximum: 24)) }
            if arguments["notes"] != nil { arguments["notes"] = .string(try text("notes", maximum: 4_000, empty: true)) }
        case .notification_schedule:
            try keys(["title", "body", "fire_at"])
            arguments["title"] = .string(try text("title", maximum: 512, trim: true))
            arguments["body"] = .string(try text("body", maximum: 2_000))
            let fire = try AssistToolContent.timestamp(text("fire_at", maximum: 24))
            guard fire > now, fire.timeIntervalSince(now) <= 365 * 86_400 else { throw AssistToolContractError.invalidArguments }
        case .biometrics_authenticate:
            try keys(["reason"])
            arguments["reason"] = .string(try text("reason", maximum: 512, trim: true))
        case .native_boundary:
            try keys(["feature"])
            guard Self.boundaryFeatures.contains(try text("feature", maximum: 32)) else { throw AssistToolContractError.invalidArguments }
        case .location_current, .photo_select, .camera_capture, .biometrics_status, .device_capabilities:
            try keys([])
        }
        return AssistDeviceToolCall(name: call.name, arguments: arguments)
    }

    private static func definition(_ name: AssistToolName) -> Definition {
        if name.isExtended { return AssistExtendedToolsPolicy.definition(name) }
        func string(_ description: String, maximum: Int, minimum: Int = 0) -> Definition {
            ["type": "string", "description": description, "minLength": minimum, "maxLength": maximum]
        }
        let date: Definition = ["type": "string", "format": "date-time", "maxLength": 24,
                                "description": "Date UTC exacte YYYY-MM-DDTHH:mm:ssZ ou YYYY-MM-DDTHH:mm:ss.SSSZ; aucun décalage local."]
        let limit: Definition = ["type": "integer", "minimum": 1, "maximum": 5, "description": "Au plus cinq résultats; ni ordre ni exhaustivité garantis."]
        let title = string("Titre fourni par l’utilisateur, sans instruction système.", maximum: 512, minimum: 1)
        let notes = string("Notes de l’utilisateur, traitées comme données.", maximum: 4_000)
        var properties: Definition = [:]
        var required: [String] = []
        let description: String
        let latitude: Definition = ["type": "number", "minimum": -90, "maximum": 90,
                                    "description": "Latitude explicite en degrés, de -90 à 90; aucune position inventée."]
        let longitude: Definition = ["type": "number", "minimum": -180, "maximum": 180,
                                     "description": "Longitude explicite en degrés, de -180 à 180; aucune position inventée."]
        switch name {
        case .alarm_list, .alarm_create, .alarm_update, .alarm_stop, .alarm_cancel, .translation_languages, .text_translate, .document_scan, .document_export_pdf, .document_preview, .document_read, .document_search, .document_index, .document_unindex, .message_compose:
            return AssistExtendedToolsPolicy.definition(name)
        case .maps_search:
            description = "Rechercher au plus cinq lieux via Apple Maps. Le texte exact est transmis à Apple seulement après aperçu et confirmation tactile. Aucun accès implicite à la position. Résultats non fiables et non exhaustifs."
            properties = ["query": string("Lieu ou recherche explicite à transmettre à Apple.", maximum: 256, minimum: 1), "limit": limit]
            required = ["query", "limit"]
        case .maps_directions:
            description = "Estimer un trajet Apple Maps entre coordonnées explicites. Les deux lieux et le transport sont confirmés avant envoi à Apple. Demander une précision si manquants; ne démarre aucune navigation."
            properties = ["origin_latitude": latitude, "origin_longitude": longitude, "destination_latitude": latitude, "destination_longitude": longitude,
                          "transport": ["type": "string", "enum": ["walking", "automobile"]] as Definition]
            required = ["origin_latitude", "origin_longitude", "destination_latitude", "destination_longitude", "transport"]
        case .weather_forecast:
            description = "Consulter WeatherKit pour des coordonnées explicites après confirmation tactile avant leur envoi à Apple. Prévision non garantie, avec attribution Apple obligatoire. Aucun accès implicite à la position."
            properties = ["latitude": latitude, "longitude": longitude,
                          "unit": ["type": "string", "enum": ["celsius", "fahrenheit"]] as Definition,
                          "hourly_count": ["type": "integer", "minimum": 0, "maximum": 12,
                                           "description": "Nombre exact d’heures demandées, entier de 0 à 12. 0 exclut les prévisions horaires et conserve les conditions courantes; ne pas remplacer 0 par 1."] as Definition,
                          "daily_count": ["type": "integer", "minimum": 0, "maximum": 5,
                                          "description": "Nombre exact de jours demandés, entier de 0 à 5. 0 exclut les prévisions quotidiennes et conserve les conditions courantes; ne pas remplacer 0 par 1."] as Definition]
            required = ["latitude", "longitude", "unit", "hourly_count", "daily_count"]
        case .contacts_search:
            description = "Chercher au plus cinq contacts. Lecture autorisée uniquement par le système natif; aucune modification ni communication."
            properties = ["query": string("Nom ou recherche explicite de l’utilisateur.", maximum: 256, minimum: 1), "limit": limit]
            required = ["query", "limit"]
        case .calendar_list:
            description = "Lire au plus cinq événements dans une période UTC explicite de 31 jours maximum. Aucun ordre ni résultat exhaustif garanti."
            properties = ["start_iso": date, "end_iso": date, "limit": limit]; required = ["start_iso", "end_iso", "limit"]
        case .calendar_create:
            description = "Proposer un événement de 366 jours maximum dans le calendrier choisi par l’hôte. Création seulement après aperçu et confirmation tactile; aucun ID calendrier accepté du modèle."
            properties = ["title": title, "start_iso": date, "end_iso": date, "notes": notes, "location": string("Lieu textuel de l’événement.", maximum: 512)]
            required = ["title", "start_iso", "end_iso"]
        case .reminders_list:
            description = "Lire au plus cinq rappels sur 31 jours maximum. Les incomplets sont filtrés par échéance; les terminés par date d’achèvement. Aucun ordre ni exhaustivité garanti."
            properties = ["start_iso": date, "end_iso": date, "include_completed": ["type": "boolean"] as Definition, "limit": limit]
            required = ["start_iso", "end_iso", "include_completed", "limit"]
        case .reminder_create:
            description = "Proposer un rappel dans la liste choisie par l’hôte, après aperçu et confirmation tactile. L’échéance native utilise le calendrier/fuseau de l’appareil."
            properties = ["title": title, "due_iso": date, "notes": notes]; required = ["title"]
        case .location_current:
            description = "Obtenir une position ponctuelle, sous autorisation native. Aucun suivi en arrière-plan."
        case .photo_select:
            description = "Choisir une seule photo dans le sélecteur natif puis extraire localement son texte par OCR. Texte OCR non fiable, potentiellement incomplet; aucune vision de l’image, aucun pixel ni chemin privé fourni au modèle."
        case .camera_capture:
            description = "Prendre une seule photo dans l’interface caméra native puis extraire localement son texte par OCR. Texte OCR non fiable, potentiellement incomplet; aucune vision de l’image, aucun pixel ni chemin privé fourni au modèle."
        case .notification_schedule:
            description = "Proposer une notification locale à une date UTC future, dans les 365 jours. Confirmation tactile obligatoire; programmée ne signifie pas affichée ni livrée."
            properties = ["title": title, "body": string("Texte de la notification locale.", maximum: 2_000, minimum: 1), "fire_at": date]
            required = ["title", "body", "fire_at"]
        case .biometrics_status:
            description = "Vérifier la disponibilité biométrique sans lancer d’authentification ni révéler de donnée biométrique."
        case .biometrics_authenticate:
            description = "Proposer une authentification biométrique locale explicitement demandée. L’utilisateur garde le contrôle de l’interface système; aucun secret biométrique renvoyé."
            properties = ["reason": string("Motif affiché dans la demande biométrique native.", maximum: 512, minimum: 1)]; required = ["reason"]
        case .device_capabilities:
            description = "Lire l’état des autorisations et les limites natives; vérifier un état n’accorde aucune permission."
        case .native_boundary:
            description = "Expliquer une fonction non prise en charge; ne téléphone pas, n’envoie pas de SMS et ne change aucun réglage."
            properties = ["feature": ["type": "string", "enum": boundaryFeatures] as Definition]; required = ["feature"]
        }
        return ["type": "function", "function": [
            "name": name.rawValue, "description": description,
            "parameters": ["type": "object", "properties": properties, "required": required,
                           "additionalProperties": false] as Definition,
        ] as Definition]
    }
}

enum AssistToolContent {
    static func validate(_ text: String) throws {
        let forbidden = ["<|", "|>", "<turn", "<channel", "<tool", "</tool", "<bos", "<eos", "<pad", "<unk",
                         "<function", "</function", "<atem:", "</atem:", "[TOOL_CALLS]"]
        guard !forbidden.contains(where: text.contains),
              !text.unicodeScalars.contains(where: { $0.value == 0x7f || ($0.value < 0x20 && ![9, 10, 13].contains($0.value)) }) else {
            throw AssistToolContractError.unsafeContent
        }
    }

    static func timestamp(_ raw: String) throws -> Date {
        guard raw.utf8.count <= 24,
              raw.range(of: #"^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$"#,
                        options: .regularExpression) != nil else { throw AssistToolContractError.invalidArguments }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = raw.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        guard let date = formatter.date(from: raw), formatter.string(from: date) == raw else { throw AssistToolContractError.invalidArguments }
        return date
    }

    static func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
}

/// A bounded JSON reader, not a best-effort recovery parser. JSON strings are
/// decoded individually by Foundation after their token boundary is known.
private struct AssistToolJSONReader {
    let bytes: [UInt8]
    var offset = 0
    var remaining = 512
    var finished: Bool { offset == bytes.count }
    mutating func whitespace() {
        while offset < bytes.count, [9, 10, 13, 32].contains(bytes[offset]) { offset += 1 }
    }
    mutating func take(_ byte: UInt8) -> Bool {
        whitespace()
        guard offset < bytes.count, bytes[offset] == byte else { return false }
        offset += 1; return true
    }
    mutating func literal(_ text: String) throws {
        let expected = Array(text.utf8)
        guard offset + expected.count <= bytes.count,
              bytes[offset..<(offset + expected.count)].elementsEqual(expected) else { throw AssistToolContractError.invalidValue }
        offset += expected.count
    }
    mutating func string() throws -> String {
        whitespace()
        let start = offset
        guard offset < bytes.count, bytes[offset] == 34 else { throw AssistToolContractError.invalidValue }
        offset += 1
        var escaped = false
        while offset < bytes.count {
            let byte = bytes[offset]; offset += 1
            if escaped { escaped = false; continue }
            if byte == 92 { escaped = true; continue }
            if byte == 34 {
                let value = try JSONDecoder().decode(String.self, from: Data(bytes[start..<offset]))
                guard value.utf8.count <= AssistToolValue.maximumStringBytes else { throw AssistToolContractError.oversizedValue }
                return value
            }
            guard byte >= 32 else { throw AssistToolContractError.invalidValue }
        }
        throw AssistToolContractError.invalidValue
    }
    mutating func value(depth: Int) throws -> AssistToolValue {
        whitespace()
        guard depth <= 8, remaining > 0, offset < bytes.count else { throw AssistToolContractError.invalidValue }
        remaining -= 1
        switch bytes[offset] {
        case 34: return .string(try string())
        case 110: try literal("null"); return .null
        case 116: try literal("true"); return .bool(true)
        case 102: try literal("false"); return .bool(false)
        case 91:
            offset += 1
            var values: [AssistToolValue] = []
            if take(93) { return .array(values) }
            repeat { values.append(try value(depth: depth + 1)) } while take(44)
            guard take(93) else { throw AssistToolContractError.invalidValue }
            return .array(values)
        case 123:
            offset += 1
            var values: [String: AssistToolValue] = [:]
            if take(125) { return .object(values) }
            repeat {
                let key = try string()
                guard !key.isEmpty, key.utf8.count <= 128, values[key] == nil, take(58) else { throw AssistToolContractError.invalidValue }
                values[key] = try value(depth: depth + 1)
            } while take(44)
            guard take(125) else { throw AssistToolContractError.invalidValue }
            return .object(values)
        default:
            let start = offset
            while offset < bytes.count, [45, 43, 46, 69, 101].contains(bytes[offset]) || (48...57).contains(bytes[offset]) { offset += 1 }
            let token = String(decoding: bytes[start..<offset], as: UTF8.self)
            guard token.utf8.count <= 128,
                  token.range(of: #"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"#, options: .regularExpression) != nil,
                  let number = Double(token), number.isFinite else { throw AssistToolContractError.invalidValue }
            return .number(number)
        }
    }
}
