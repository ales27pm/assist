#if ASSIST_POLICY_CHECKS
import Foundation

/// Standalone Foundation-only checks; not part of the app target.
/// swiftc -D ASSIST_POLICY_CHECKS InferencePolicy.swift InferencePolicyChecks.swift -o policy-checks
@main
struct InferencePolicyChecks {
    static func main() throws {
        var checks = 0
        func expect(_ condition: @autoclosure () -> Bool, _ description: String) throws {
            guard condition() else { throw AssistInferenceError.invalid("FAIL: \(description)") }
            checks += 1
        }
        func reject(_ description: String, _ operation: () throws -> Void) throws {
            do { try operation() }
            catch { checks += 1; return }
            throw AssistInferenceError.invalid("FAIL: accepted \(description)")
        }

        try AssistInferencePolicy.validateModel(tokenizer: "google/gemma-4-E2B-it", context: 32768, embeddedTokenizer: true)
        checks += 1
        try AssistInferencePolicy.validateModel(tokenizer: "google/gemma-4-E2B-it", context: 8192, embeddedTokenizer: true)
        checks += 1
        try reject("network tokenizer") {
            try AssistInferencePolicy.validateModel(tokenizer: "google/gemma-4-E2B-it", context: 32768, embeddedTokenizer: false)
        }
        try reject("different model") {
            try AssistInferencePolicy.validateModel(tokenizer: "google/gemma-4-E4B-it", context: 32768, embeddedTokenizer: true)
        }
        try reject("unqualified export context") {
            try AssistInferencePolicy.validateModel(tokenizer: "google/gemma-4-E2B-it", context: 131072, embeddedTokenizer: true)
        }
        try AssistInferencePolicy.validateGraphs(
            ["load_embeddings", "extend_1024_8", "extend_32768_8", "prompt_opt_32768_64"], context: 32768
        )
        checks += 1
        try reject("metadata-only 32K claim") {
            try AssistInferencePolicy.validateGraphs(["load_embeddings", "extend_8192_8", "prompt_opt_8192_64"], context: 32768)
        }
        try reject("wrong query shape") {
            try AssistInferencePolicy.validateGraphs(["load_embeddings", "extend_32768_1", "prompt_opt_32768_64"], context: 32768)
        }
        try reject("missing prefill") {
            try AssistInferencePolicy.validateGraphs(["load_embeddings", "extend_32768_8"], context: 32768)
        }
        let allRemaining = try AssistInferencePolicy.outputBudget(promptTokens: 10, capacity: 32768, requested: nil)
        try expect(allRemaining == 32758, "nil budget uses the real remaining context, not 32/512")
        let requested = try AssistInferencePolicy.outputBudget(promptTokens: 10, capacity: 32768, requested: 4096)
        try expect(requested == 4096, "requested output above 32 preserved")
        let clamped = try AssistInferencePolicy.outputBudget(promptTokens: 32760, capacity: 32768, requested: 4096)
        try expect(clamped == 8, "input and output share context")
        try reject("full context") { _ = try AssistInferencePolicy.outputBudget(promptTokens: 32768, capacity: 32768, requested: nil) }
        try reject("negative budget") { _ = try AssistInferencePolicy.outputBudget(promptTokens: 10, capacity: 32768, requested: -1) }
        try reject("empty prompt") { _ = try AssistInferencePolicy.outputBudget(promptTokens: 0, capacity: 32768, requested: nil) }
        let stops = try AssistInferencePolicy.stopTokenIDs(
            metadata: Data(#"{"language":{"eos_token_ids":[106,106]}}"#.utf8), vocabSize: 262144, tokenizerEOS: 1
        )
        try expect(stops == [1, 106], "checkpoint EOS and tokenizer EOS union preserved")
        try reject("missing export EOS") {
            _ = try AssistInferencePolicy.stopTokenIDs(metadata: Data(#"{"language":{}}"#.utf8), vocabSize: 262144, tokenizerEOS: 1)
        }
        try reject("out-of-range EOS") {
            _ = try AssistInferencePolicy.stopTokenIDs(
                metadata: Data(#"{"language":{"eos_token_ids":[262144]}}"#.utf8), vocabSize: 262144, tokenizerEOS: 1
            )
        }
        let request = try JSONDecoder().decode(AssistGenerationRequest.self, from: Data(
            #"{"requestId":"1","messages":[{"role":"user","content":"Bonjour"}],"temperature":0,"maxTokens":null}"#.utf8
        ))
        try request.validate()
        try expect(request.maxTokens == nil, "JSON null preserved as remaining context")
        var zeroBudgetMessage = ""
        do {
            try AssistGenerationRequest(
                requestId: "1", messages: [.init(role: "user", content: "x")], temperature: 0, maxTokens: 0
            ).validate()
        } catch { zeroBudgetMessage = error.localizedDescription }
        try expect(zeroBudgetMessage.contains("nil"), "zero is rejected and the error identifies nil as remaining context")
        try AssistGenerationRequest(
            requestId: "1", messages: [.init(role: "user", content: "x")], temperature: 0, maxTokens: 1
        ).validate()
        checks += 1
        try reject("invalid role") {
            try AssistGenerationRequest(requestId: "1", messages: [.init(role: "tool", content: "x")], temperature: 0, maxTokens: nil).validate()
        }
        try reject("invalid temperature") {
            try AssistGenerationRequest(requestId: "1", messages: [.init(role: "user", content: "x")], temperature: .infinity, maxTokens: nil).validate()
        }
        let root = URL(fileURLWithPath: "/tmp/assist-policy-fixture", isDirectory: true)
        let confined = try AssistInferencePolicy.confinedURL("tokenizer/tokenizer.json", root: root)
        try expect(confined.path.hasSuffix("assist-policy-fixture/tokenizer/tokenizer.json"), "local child accepted")
        try reject("parent escape") { _ = try AssistInferencePolicy.confinedURL("../outside", root: root) }
        try reject("absolute escape") { _ = try AssistInferencePolicy.confinedURL("/tmp/outside", root: root) }

        let package = root.appendingPathComponent("main.mlmodelc", isDirectory: true)
        let weights = package.appendingPathComponent("weights.bin")
        let hidden = root.appendingPathComponent(".provider-placeholder")
        let tree = [root: [package, hidden], package: [weights]]
        typealias Entry = AssistModelDirectoryPolicy.Entry
        let directory = Entry(isDirectory: true, isSymbolicLink: false, isReadable: true, isUbiquitous: false, isDownloaded: true)
        let file = Entry(isDirectory: false, isSymbolicLink: false, isReadable: true, isUbiquitous: false, isDownloaded: true)
        var overrides: [URL: Entry] = [:]
        var visited = Set<URL>()
        var listed = Set<URL>()
        func validateDirectoryFixture() throws {
            visited = []
            listed = []
            try AssistModelDirectoryPolicy.validate(root, entry: { url in
                visited.insert(url)
                return overrides[url] ?? (tree[url] == nil ? file : directory)
            }, children: { url in
                listed.insert(url)
                return tree[url] ?? []
            })
        }
        try validateDirectoryFixture()
        try expect(visited == [root, package, weights, hidden], "local model packages and hidden entries are all checked")
        overrides = [root: Entry(isDirectory: true, isSymbolicLink: false, isReadable: true, isUbiquitous: true, isDownloaded: true)]
        try reject("downloaded iCloud root") { try validateDirectoryFixture() }
        try expect(listed.isEmpty, "iCloud folder is rejected before listing its contents")
        overrides = [package: Entry(isDirectory: true, isSymbolicLink: false, isReadable: true, isUbiquitous: true, isDownloaded: true)]
        try reject("nested iCloud folder") { try validateDirectoryFixture() }
        try expect(!listed.contains(package), "rejected nested cloud folder is never enumerated")
        overrides = [weights: Entry(isDirectory: false, isSymbolicLink: false, isReadable: true, isUbiquitous: false, isDownloaded: false)]
        try reject("readable nested File Provider placeholder") { try validateDirectoryFixture() }
        overrides = [hidden: Entry(isDirectory: false, isSymbolicLink: false, isReadable: true, isUbiquitous: false, isDownloaded: false)]
        try reject("hidden undownloaded entry") { try validateDirectoryFixture() }
        overrides = [weights: Entry(isDirectory: false, isSymbolicLink: true, isReadable: true, isUbiquitous: false, isDownloaded: true)]
        try reject("nested symbolic link") { try validateDirectoryFixture() }
        overrides = [weights: Entry(isDirectory: false, isSymbolicLink: false, isReadable: false, isUbiquitous: false, isDownloaded: true)]
        try reject("unreadable nested entry") { try validateDirectoryFixture() }
        overrides = [root: file]
        try reject("file selected as directory") { try validateDirectoryFixture() }
        try reject("metadata unavailable") {
            try AssistModelDirectoryPolicy.validate(root, entry: { _ in
                throw AssistInferenceError.invalid("metadata unavailable")
            }, children: { _ in [] })
        }
        try reject("directory listing unavailable") {
            try AssistModelDirectoryPolicy.validate(root, entry: { _ in directory }, children: { _ in
                throw AssistInferenceError.invalid("listing unavailable")
            })
        }

        var output = AssistOutputBuffer()
        let bytes: [Int: [UInt8]] = [0: [0xF0, 0x9F], 1: [0x98, 0x80], 2: [0x41], 3: [0x42]]
        let decode: ([Int]) -> String = { ids in
            String(decoding: ids.flatMap { bytes[$0]! }, as: UTF8.self)
        }
        output.append(0)
        _ = output.snapshot(decode: decode) // Partial emoji may show a replacement until complete.
        output.append(1)
        try expect(output.snapshot(decode: decode) == "😀", "UTF-8 split emoji completes")
        output.append(2)
        try expect(output.snapshot(decode: decode) == "😀A", "stream continues after byte-fallback token")
        output.append(3)
        try expect(output.snapshot(decode: decode) == "😀AB", "snapshot neither freezes nor duplicates text")
        try expect(output.count == 4, "raw token count is not decoded character count")

        var longOutput = AssistOutputBuffer()
        var decodedTokens = 0
        var decodeCalls = 0
        let countingDecode: ([Int]) -> String = { ids in
            decodedTokens += ids.count
            decodeCalls += 1
            return String(ids.count)
        }
        for id in 0..<32768 {
            longOutput.append(id)
            _ = longOutput.progressSnapshot(decode: countingDecode)
        }
        try expect(decodedTokens <= 65 * 32768, "32K progress decoding has linear bounded work even with an update per token")
        try expect(decodeCalls < 500, "32K progress does not decode every token prefix")
        try expect(longOutput.snapshot(decode: countingDecode) == "32768", "final snapshot includes all 32K tokens")
        try expect(decodedTokens <= 66 * 32768, "mandatory final decode preserves the linear bound")

        var cancelledOutput = AssistOutputBuffer()
        for _ in 0..<65 {
            cancelledOutput.append(2)
            _ = cancelledOutput.progressSnapshot(decode: decode)
        }
        cancelledOutput.append(0)
        let cached = cancelledOutput.progressSnapshot(decode: decode)
        try expect(cached == String(repeating: "A", count: 65), "progress text is retained between decode milestones")
        try expect(cancelledOutput.snapshot(decode: decode) == String(repeating: "A", count: 65) + "�", "cancellation includes tokens after the latest progress snapshot")
        cancelledOutput.append(1)
        try expect(cancelledOutput.snapshot(decode: decode) == String(repeating: "A", count: 65) + "😀", "final decode repairs a UTF-8 boundary after a cached snapshot")
        var emptyOutput = AssistOutputBuffer()
        try expect(emptyOutput.snapshot(decode: decode).isEmpty, "EOS before text has an exact empty final snapshot")
        var normalizedOutput = AssistOutputBuffer()
        normalizedOutput.append(0)
        let normalize: ([Int]) -> String = { ids in
            ids.map { $0 == 0 ? "Bonjour " : "." }.joined().replacingOccurrences(of: " .", with: ".")
        }
        try expect(normalizedOutput.progressSnapshot(decode: normalize) == "Bonjour ", "initial tokenizer normalization is retained")
        normalizedOutput.append(1)
        try expect(normalizedOutput.snapshot(decode: normalize) == "Bonjour.", "full-prefix final decoding can normalize earlier text")
        print("PASS: \(checks) independent inference policy checks")
    }
}
#endif
