import Foundation

@main
struct Checks {
    static func main() throws {
        func eligible(_ id: String = "com.apple.voice.test", name: String = "Voix", language: String = "fr-CA", quality: String? = "premium", personal: Bool = false, novelty: Bool = false) -> Bool {
            AssistSpeechVoicePolicy.isEligible(id: id, name: name, language: language, quality: quality, personal: personal, novelty: novelty)
        }
        precondition(eligible() && eligible(language: "fr_CA"))
        precondition(!eligible("org.thirdparty.test") && !eligible(language: "fr-FR") && !eligible(quality: nil))
        precondition(!eligible(personal: true) && !eligible(novelty: true))
        print("PASS: production eligibility enforces Apple product prefix, exact Canadian locale, known quality and excluded personal/novelty traits.")
        precondition(eligible(name: String(repeating: "😀", count: 80)))
        precondition(!eligible(name: String(repeating: "😀", count: 81)))
        precondition(!eligible(String(repeating: "com.apple.", count: 60)))
        print("PASS: production metadata limits use UTF-16, matching the JavaScript contract.")
        let ids = ["com.apple.voice.A", "com.apple.voice.B"]
        precondition(AssistSpeechVoicePolicy.resolve(identifiers: ids, selected: "").id == ids[0])
        precondition(AssistSpeechVoicePolicy.resolve(identifiers: ids, selected: ids[1]).id == ids[1])
        let missing = AssistSpeechVoicePolicy.resolve(identifiers: ids, selected: "removed")
        precondition(missing.id == ids[0] && missing.missing)
        let empty = AssistSpeechVoicePolicy.resolve(identifiers: [], selected: "")
        precondition(empty.id == nil && !empty.missing)
        precondition(AssistSpeechVoicePolicy.resolve(identifiers: [], selected: "removed").missing)
        print("PASS: selected, automatic, disappeared and empty catalog resolutions remain coherent.")
        func json(_ value: Any) -> String { String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)! }
        precondition(AssistSpeechPreviewPlan.segments(from: json(["Salut!", "Comment ça va?"]))?.count == 2)
        precondition(AssistSpeechPreviewPlan.segments(from: json(Array(repeating: "x", count: 12)))?.count == 12)
        for invalid in [[], [""], [" \n\t"], Array(repeating: "x", count: 13), [String(repeating: "x", count: 2_401)], Array(repeating: String(repeating: "x", count: 2_400), count: 4)] {
            precondition(AssistSpeechPreviewPlan.segments(from: json(invalid)) == nil)
        }
        precondition(AssistSpeechPreviewPlan.segments(from: "{}") == nil)
        precondition(AssistSpeechPreviewPlan.segments(from: "not JSON") == nil)
        precondition(AssistSpeechPreviewPlan.segments(from: json([String(repeating: "é", count: 1_200)])) != nil)
        precondition(AssistSpeechPreviewPlan.segments(from: json([String(repeating: "é", count: 1_201)])) == nil)
        print("PASS: production preview plan enforces shape, 1–12 nonempty segments and UTF-8 byte budgets.")
        var lifetime = AssistSpeechPreviewLifetime()
        let generation = UUID(), first = UUID(), last = UUID()
        lifetime.begin(generation: generation, identifiers: [first, last])
        precondition(!lifetime.didFinish(first, generation: UUID()))
        precondition(!lifetime.didFinish(last, generation: generation))
        precondition(!lifetime.didFinish(last, generation: generation))
        precondition(lifetime.didFinish(first, generation: generation))
        lifetime.cancel()
        precondition(!lifetime.isActive && !lifetime.didFinish(first, generation: generation))
        lifetime.begin(generation: UUID(), identifiers: [UUID()])
        precondition(!lifetime.contains(first, generation: generation))
        print("PASS: production lifetime drains every segment, ignores duplicate/stale callbacks and fences cancellation/replacement.")
        for outcome in ["completed", "cancelled"] {
            let encoded = AssistSpeechPreviewPlan.resultJSON(sessionId: "id-\"é", outcome: outcome)
            let parsed = try JSONSerialization.jsonObject(with: Data(encoded.utf8)) as! [String: String]
            precondition(parsed == ["sessionId": "id-\"é", "outcome": outcome])
        }
        print("PASS: terminal JSON preserves session identity and completion/cancellation outcome.")
        print("PASS: 6 production value-contract checks; no audio engine, synthesizer playback, microphone or permissions.")
    }
}
