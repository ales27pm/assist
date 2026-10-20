import Foundation

@main
struct TranslationPolicyChecks {
    static func main() throws {
        var checks = 0
        func expect(_ condition: @autoclosure () throws -> Bool) throws {
            guard try condition() else { throw AssistTranslationPolicy.failure(.invalid) }; checks += 1
        }
        func rejects(_ action: () throws -> Void) throws {
            do { try action() } catch { checks += 1; return }
            throw AssistTranslationPolicy.failure(.invalid)
        }
        let availability = #"{"schemaVersion":1,"requestId":"translation-1","action":"availability","source_language":"","target_language":"en","allow_download":false}"#
        let translation = #"{"schemaVersion":1,"requestId":"translation-2","action":"translate","source_language":"fr-CA","target_language":"en","allow_download":false,"text":"Bonjour le monde."}"#
        try expect(try AssistTranslationPolicy.request(availability).action == .availability)
        try expect(try AssistTranslationPolicy.request(translation).text == "Bonjour le monde.")
        try expect(try AssistTranslationPolicy.request(translation).sourceLanguage == "fr-CA")
        try expect(try AssistTranslationPolicy.request(translation.replacingOccurrences(of: "false", with: "true")).allowDownload)
        for invalid in [availability.replacingOccurrences(of: "false", with: "true"),
                        availability.replacingOccurrences(of: "\"target_language\":\"en\"", with: "\"target_language\":\"\""),
                        translation.replacingOccurrences(of: "Bonjour le monde.", with: " "),
                        translation.replacingOccurrences(of: "Bonjour le monde.", with: "<|tool_call>"),
                        translation.replacingOccurrences(of: "Bonjour le monde.", with: "a" + String(repeating: "é", count: 4_096)),
                        translation.replacingOccurrences(of: "\"fr-CA\"", with: "null"),
                        translation.replacingOccurrences(of: "\"fr-CA\"", with: "\"fr_CA\""),
                        translation.replacingOccurrences(of: "\"translation-2\"", with: "\"request with spaces\""),
                        translation.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":2"),
                        translation.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":1,\"schemaVersion\":1"),
                        translation.replacingOccurrences(of: "\"allow_download\":false", with: "\"allow_download\":0"),
                        translation.replacingOccurrences(of: "\"action\":\"translate\"", with: "\"action\":\"download\""),
                        translation.replacingOccurrences(of: "\"text\":\"Bonjour le monde.\"", with: "\"text\":\"Bonjour\",\"extra\":true") ] {
            try rejects { _ = try AssistTranslationPolicy.request(invalid) }
        }
        for language in ["fr", "fr-CA", "zh-Hant", "zh-Hant-TW", "pt-BR"] { try expect(AssistTranslationPolicy.validLanguage(language)) }
        for language in ["", "x", "english", "en_US", "en-<|", "fr\n"] { try expect(!AssistTranslationPolicy.validLanguage(language)) }
        try expect(AssistTranslationPolicy.validText(String(repeating: "é", count: 4_096)))
        try expect(!AssistTranslationPolicy.validText(String(repeating: "é", count: 4_097)))
        try expect(!AssistTranslationPolicy.validText("unsafe\u{0000}"))
        try expect(!AssistTranslationPolicy.validText("unsafe|>"))
        try expect(AssistTranslationPolicy.validText("Texte\navec\tretours."))
        try AssistTranslationPolicy.permits(.installed, allowDownload: false); checks += 1
        try AssistTranslationPolicy.permits(.supported, allowDownload: true); checks += 1
        try rejects { try AssistTranslationPolicy.permits(.supported, allowDownload: false) }
        try rejects { try AssistTranslationPolicy.permits(.unsupported, allowDownload: true) }
        try rejects { try AssistTranslationPolicy.permits(.notChecked, allowDownload: true) }
        var epoch = AssistTranslationPolicy.Epoch()
        let first = epoch.begin()
        try expect(epoch.accepts(first, foreground: true))
        try expect(!epoch.accepts(first, foreground: false))
        epoch.cancel()
        try expect(!epoch.accepts(first, foreground: true))
        let second = epoch.begin()
        try expect(!epoch.accepts(first, foreground: true))
        try expect(epoch.accepts(second, foreground: true))
        try expect(try AssistTranslationPolicy.response(["localOnly": .bool(true)]).contains("true"))
        try rejects { _ = try AssistTranslationPolicy.response(["text": .string("<|tool_response>")]) }
        let translationRequest = try AssistTranslationPolicy.request(translation)
        let translationRow: [String: AssistToolValue] = ["schemaVersion": .number(1), "requestId": .string("translation-2"), "action": .string("translate"), "sourceLanguage": .string("fr-CA"), "targetLanguage": .string("en"), "sourceDetected": .bool(false), "translatedText": .string("Hello world."), "status": .string("installed"), "localOnly": .bool(true), "untrusted": .bool(true)]
        try expect(try AssistTranslationPolicy.result(AssistTranslationPolicy.response(translationRow), request: translationRequest) == .object(translationRow))
        for (key, value) in [("requestId", AssistToolValue.string("foreign")), ("targetLanguage", .string("es")), ("sourceLanguage", .string("en")), ("sourceDetected", .bool(true)), ("localOnly", .bool(false)), ("untrusted", .bool(false)), ("status", .string("supported")), ("extra", .bool(true))] {
            var row = translationRow; row[key] = value
            try rejects { _ = try AssistTranslationPolicy.result(AssistTranslationPolicy.response(row), request: translationRequest) }
        }
        let availabilityRequest = try AssistTranslationPolicy.request(availability)
        var availabilityRow: [String: AssistToolValue] = ["schemaVersion": .number(1), "requestId": .string("translation-1"), "action": .string("availability"), "sourceLanguage": .string(""), "targetLanguage": .string("en"), "status": .string("not_checked"), "languages": .array([.object(["identifier": .string("fr"), "label": .string("Français")])]), "localOnly": .bool(true), "untrusted": .bool(true)]
        try expect(try AssistTranslationPolicy.result(AssistTranslationPolicy.response(availabilityRow), request: availabilityRequest) == .object(availabilityRow))
        availabilityRow["status"] = .string("installed")
        try rejects { _ = try AssistTranslationPolicy.result(AssistTranslationPolicy.response(availabilityRow), request: availabilityRequest) }
        availabilityRow["status"] = .string("not_checked")
        availabilityRow["languages"] = .array([.object(["identifier": .string("fr"), "label": .string("French")]), .object(["identifier": .string("fr"), "label": .string("French")])])
        try rejects { _ = try AssistTranslationPolicy.result(AssistTranslationPolicy.response(availabilityRow), request: availabilityRequest) }
        print("Translation policy: \(checks) checks passed (not an Apple framework or iPhone qualification).")
    }
}
