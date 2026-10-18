import Foundation
#if ASSIST_GEMMA_TOKENIZER_RUNTIME
import CryptoKit
import Tokenizers
#endif

@main
struct GemmaToolChecks {
    static func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
        if try value() == false { throw NSError(domain: "GemmaToolChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func rejects(_ body: () throws -> Void, _ message: String) throws {
        do { try body() } catch { return }
        throw NSError(domain: "GemmaToolChecks", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
    }
    static let scope = AssistAgentCalendarScope(startISO: "2026-10-18T04:00:00Z", endISO: "2026-10-19T04:00:00Z", timeZoneIdentifier: "America/Toronto")
    static let request = AssistGenerationRequest(requestId: "fixture", messages: [.init(role: "user", content: "Quels événements aujourd’hui ?")], temperature: 0, maxTokens: 256)
    static let call = AssistGemmaToolAdapter.Call(startISO: scope.startISO, endISO: scope.endISO, limit: 5)
    static var raw: String {
        "<|tool_call>call:calendar_list{start_iso:<|\"|>\(scope.startISO)<|\"|>,end_iso:<|\"|>\(scope.endISO)<|\"|>,limit:5}<tool_call|>"
    }
    static var result: AssistGemmaToolAdapter.Message {
        ["events": [["title": "Réunion {équipe}, \"édition\"", "startISO": "2026-10-18T14:00:00Z", "endISO": "2026-10-18T15:00:00Z", "allDay": false] as AssistGemmaToolAdapter.Message], "possiblyTruncated": false]
    }

    static func fixture() throws -> [String: Any] {
        ["planningMessages": try AssistGemmaToolAdapter.planningMessages(request: request, scope: scope),
         "continuationMessages": try AssistGemmaToolAdapter.continuationMessages(request: request, call: call, toolResponse: result, scope: scope),
         "tools": AssistGemmaToolAdapter.closedToolSchema(scope: scope),
         "additionalContext": AssistGemmaToolAdapter.additionalContext,
         "bosToken": "<bos>", "eosToken": "<eos>"]
    }

    static func main() async throws {
        if CommandLine.arguments.dropFirst().first == "--fixture-json" {
            print(String(decoding: try JSONSerialization.data(withJSONObject: fixture(), options: [.sortedKeys]), as: UTF8.self))
            return
        }
        try expect(try AssistGemmaToolAdapter.parse(raw: raw, stoppedAtToolResponse: true, scope: scope) == .call(call), "exact closed call")
        let reordered = " \n<|tool_call>call:calendar_list{limit:5,end_iso:<|\"|>\(scope.endISO)<|\"|>,start_iso:<|\"|>\(scope.startISO)<|\"|>}<tool_call|>\t"
        try expect(try AssistGemmaToolAdapter.parse(raw: reordered, stoppedAtToolResponse: true, scope: scope) == .call(call), "argument order and outer whitespace")
        try expect(try AssistGemmaToolAdapter.parse(raw: "Je ne peux pas répondre.", stoppedAtToolResponse: false, scope: scope) == .answer("Je ne peux pas répondre."), "plain refusal remains an answer")
        try expect(try AssistGemmaToolAdapter.parse(raw: "Texte visible : call:calendar_list{}", stoppedAtToolResponse: false, scope: scope) == .answer("Texte visible : call:calendar_list{}"), "no extraction from ordinary text")
        let invalid = [
            raw + raw, "Je vais lire. " + raw, raw + " ensuite", raw.replacingOccurrences(of: "calendar_list", with: "calendar_delete"),
            raw.replacingOccurrences(of: "limit:5", with: "limit:50"), raw.replacingOccurrences(of: "limit:5", with: "limit:05"),
            raw.replacingOccurrences(of: "limit:5", with: "limit:5.0"), raw.replacingOccurrences(of: "limit:5", with: "limit:true"),
            raw.replacingOccurrences(of: "limit:5", with: "limit:{value:5}"), raw.replacingOccurrences(of: "limit:5", with: "limit:5,limit:5"),
            raw.replacingOccurrences(of: "limit:5", with: "limit:5,extra:1"), raw.replacingOccurrences(of: "limit:5", with: "other:5"),
            raw.replacingOccurrences(of: scope.startISO, with: "2026-10-17T00:00:00-04:00"),
            raw.replacingOccurrences(of: "<tool_call|>", with: ""), raw + "<|tool_response>",
            String(repeating: " ", count: 4_097), "<|tool_call>call:calendar_list{}<tool_call|>",
            raw.replacingOccurrences(of: "start_iso:", with: "\"start_iso\":"), raw.replacingOccurrences(of: "limit:5", with: "limit:+5"),
        ]
        for (index, value) in invalid.enumerated() {
            try rejects({ _ = try AssistGemmaToolAdapter.parse(raw: value, stoppedAtToolResponse: true, scope: scope) }, "bad grammar \(index)")
        }
        try rejects({ _ = try AssistGemmaToolAdapter.parse(raw: raw, stoppedAtToolResponse: false, scope: scope) }, "call without observed boundary")
        try rejects({ _ = try AssistGemmaToolAdapter.parse(raw: "Une réponse.", stoppedAtToolResponse: true, scope: scope) }, "boundary without call")
        for marker in ["<|tool_call>", "<tool_call|>", "<|\"|>", "<turn|>", "<|", "<tool", "<bos>", "[TOOL_CALLS]", "\u{0}"] {
            try rejects({ _ = try AssistGemmaToolAdapter.validatePublicText("Titre \(marker)") }, "unsafe public marker")
            try rejects({ _ = try AssistGemmaToolAdapter.continuationMessages(request: request, call: call, toolResponse: ["events": [["title": "Titre \(marker)"] as AssistGemmaToolAdapter.Message]], scope: scope) }, "tainted result marker")
        }
        try expect(try AssistGemmaToolAdapter.validatePublicText("  Équipe {édition}, \"notes\".  ") == "Équipe {édition}, \"notes\".", "ordinary punctuation stays data")
        let continuation = try AssistGemmaToolAdapter.continuationMessages(request: request, call: call, toolResponse: result, scope: scope)
        try expect(continuation.count == request.messages.count + 2 && continuation.last?["role"] as? String == "assistant", "real tool response is not a fake user")
        let response = (continuation.last?["tool_responses"] as? [[String: Any]])?.first?["response"] as? [String: Any]
        try expect(response != nil, "object result, not JSON string")
        try rejects({ _ = try AssistGemmaToolAdapter.continuationMessages(request: request, call: .init(startISO: scope.startISO, endISO: scope.endISO, limit: 4), toolResponse: result, scope: scope) }, "call must match closed schema")
        try rejects({ _ = try AssistGemmaToolAdapter.compatibleTemplate("unknown template") }, "unknown template cannot use a best-effort compatibility patch")
        _ = try JSONSerialization.data(withJSONObject: fixture(), options: [.sortedKeys])
        print("PASS: closed Gemma calendar grammar, observed boundary, private scope, public text and tainted-result rejection; synthetic data only")

        if let index = CommandLine.arguments.firstIndex(of: "--native-tokenizer") {
            guard CommandLine.arguments.count > index + 2 else { throw NSError(domain: "GemmaToolChecks", code: 3) }
            #if ASSIST_GEMMA_TOKENIZER_RUNTIME
            try await nativeTokenizer(directory: CommandLine.arguments[index + 1], golden: CommandLine.arguments[index + 2])
            #else
            throw NSError(domain: "GemmaToolChecks", code: 4, userInfo: [NSLocalizedDescriptionKey: "This binary was not compiled with the real Tokenizers module."])
            #endif
        }
    }

    #if ASSIST_GEMMA_TOKENIZER_RUNTIME
    static func nativeTokenizer(directory: String, golden: String) async throws {
        let tokenizer = try await AutoTokenizer.from(modelFolder: URL(fileURLWithPath: directory))
        let expected = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: golden))) as? [String: Any]
        let templateData = try Data(contentsOf: URL(fileURLWithPath: directory).appendingPathComponent("chat_template.jinja"))
        try expect(SHA256.hash(data: templateData).map { String(format: "%02x", $0) }.joined()
                   == AssistGemmaToolAdapter.canonicalTemplateSHA256, "original canonical template identity")
        let compatible = try AssistGemmaToolAdapter.compatibleTemplate(String(decoding: templateData, as: UTF8.self))
        for (name, id) in [("<|tool_call>", 48), ("<tool_call|>", 49), ("<|tool_response>", 50), ("<tool_response|>", 51), ("<eos>", 1), ("<turn|>", 106)] {
            try expect(tokenizer.convertTokenToId(name) == id && tokenizer.convertIdToToken(id) == name, "exact special token \(id)")
            try expect(tokenizer.decode(tokens: [id], skipSpecialTokens: false) == name, "special token must survive decode")
            try expect(tokenizer.encode(text: name, addSpecialTokens: false) == [id], "single-token special encoding")
        }
        let cases = [("planning", try AssistGemmaToolAdapter.planningMessages(request: request, scope: scope)),
                     ("continuation", try AssistGemmaToolAdapter.continuationMessages(request: request, call: call, toolResponse: result, scope: scope))]
        for (name, messages) in cases {
            let tokens = try tokenizer.applyChatTemplate(
                messages: messages, chatTemplate: .literal(compatible), addGenerationPrompt: true,
                truncation: false, maxLength: nil,
                tools: AssistGemmaToolAdapter.closedToolSchema(scope: scope),
                additionalContext: AssistGemmaToolAdapter.additionalContext)
            guard let reference = expected?[name] as? String else { throw AssistGemmaToolAdapter.AdapterError.invalidOutput }
            // decode has punctuation cleanup enabled at the pinned API. The
            // independent proof compares actual IDs to encode(original Python
            // Jinja output), never encode(decode(prompt)).
            let expectedIDs = tokenizer.encode(text: reference, addSpecialTokens: false)
            try expect(tokens == expectedIDs, "actual native prompt IDs must exactly match the independent canonical Jinja reference: \(name)")
            let structural = tokenizer.decode(tokens: tokens, skipSpecialTokens: false)
            if name == "planning" {
                try AssistGemmaToolAdapter.validateRenderedPlanningPrompt(structural, scope: scope)
            } else {
                try AssistGemmaToolAdapter.validateRenderedContinuationPrompt(structural, call: call, scope: scope)
                try rejects({ try AssistGemmaToolAdapter.validateRenderedContinuationPrompt(structural + "<|turn>model\n", call: call, scope: scope) }, "unwanted new model turn")
            }
        }
        let rawTokens = tokenizer.encode(text: raw, addSpecialTokens: false)
        try expect(rawTokens.first == 48 && rawTokens.last == 49 && !rawTokens.contains(50), "closed call before response boundary")
        try expect(tokenizer.decode(tokens: rawTokens, skipSpecialTokens: false) == raw, "closed call roundtrip")
        print("PASS: real native Tokenizers special IDs and exact canonical-reference prompt IDs with an in-memory agent-only template; no CoreAI/model/EventKit/device access")
    }
    #endif
}
