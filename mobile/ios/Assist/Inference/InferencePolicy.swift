import Foundation

enum AssistInferenceError: Error, LocalizedError {
    case invalid(String)
    case busy
    case notLoaded

    var errorDescription: String? {
        switch self {
        case .invalid(let detail): return detail
        case .busy: return "Une opération native est déjà en cours. Annule-la et attends sa fin."
        case .notLoaded: return "Charge d’abord le modèle local."
        }
    }
}

struct AssistMessage: Codable, Sendable {
    let role: String
    let content: String

    init(role: String, content: String) { self.role = role; self.content = content }

    private enum CodingKeys: String, CodingKey { case role, content }
    init(from decoder: any Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        role = try fields.decode(String.self, forKey: .role)
        content = try fields.decode(String.self, forKey: .content)
        try AssistInferenceInputPolicy.validateMessage(self)
    }
}

struct AssistGenerationRequest: Decodable, Sendable {
    let requestId: String
    let messages: [AssistMessage]
    let temperature: Double
    let maxTokens: Int?

    init(requestId: String, messages: [AssistMessage], temperature: Double, maxTokens: Int?) {
        self.requestId = requestId; self.messages = messages
        self.temperature = temperature; self.maxTokens = maxTokens
    }

    private enum CodingKeys: String, CodingKey { case requestId, messages, temperature, maxTokens }
    init(from decoder: any Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try fields.decode(String.self, forKey: .requestId)
        var entries = try fields.nestedUnkeyedContainer(forKey: .messages)
        // JSONDecoder supplies an array count before decoding its messages.
        // The incremental guard also bounds other Decoder implementations.
        if let count = entries.count { try AssistInferenceInputPolicy.validateMessageCount(count) }
        var decoded: [AssistMessage] = []
        decoded.reserveCapacity(entries.count ?? 0)
        while !entries.isAtEnd {
            try AssistInferenceInputPolicy.validateMessageCount(decoded.count + 1)
            decoded.append(try entries.decode(AssistMessage.self))
        }
        messages = decoded
        temperature = try fields.decode(Double.self, forKey: .temperature)
        maxTokens = try fields.decodeIfPresent(Int.self, forKey: .maxTokens)
    }

    static func decodeJSON(_ json: String) throws -> Self {
        // Check the original UTF-8 view before allocating Data or decoding JSON.
        try AssistInferenceInputPolicy.validateJSON(json)
        let request = try JSONDecoder().decode(Self.self, from: Data(json.utf8))
        try request.validate()
        return request
    }

    func validate() throws {
        try AssistInferenceInputPolicy.validateMessages(messages)
        guard !requestId.isEmpty, requestId.utf8.count <= 128 else {
            throw AssistInferenceError.invalid("Identifiant de requête invalide.")
        }
        guard temperature.isFinite, (0...2).contains(temperature) else {
            throw AssistInferenceError.invalid("La température doit être comprise entre 0 et 2.")
        }
        guard maxTokens == nil || maxTokens! > 0 else {
            throw AssistInferenceError.invalid("Le budget de sortie doit être positif ou absent (nil : contexte restant).")
        }
        guard !messages.isEmpty, messages.last?.role == "user",
            messages.allSatisfy({ ["user", "assistant"].contains($0.role) && !$0.content.isEmpty })
        else {
            throw AssistInferenceError.invalid("Conversation invalide : messages user/assistant, terminés par user.")
        }
    }
}

/// Resource admission is independent of the token budget: accepted text still
/// uses the complete 32K export and the actual post-template token count.
enum AssistInferenceInputPolicy {
    static let maximumJSONBytes = 4 * 1_024 * 1_024
    static let maximumMessages = 512
    static let maximumMessageBytes = 1_024 * 1_024

    static func validateJSON(_ json: String) throws {
        guard json.utf8.count <= maximumJSONBytes else {
            throw AssistInferenceError.invalid(
                "La conversation dépasse 4 Mio de JSON UTF-8. Réduis le texte collé ou commence une nouvelle conversation ; aucun message n’a été tronqué.")
        }
    }

    static func validateMessages(_ messages: [AssistMessage]) throws {
        try validateMessageCount(messages.count)
        for message in messages { try validateMessage(message) }
    }

    static func validateMessageCount(_ count: Int) throws {
        guard count <= maximumMessages else {
            throw AssistInferenceError.invalid(
                "La conversation dépasse 512 messages. Commence une nouvelle conversation ; aucun message n’a été tronqué.")
        }
    }

    static func validateMessage(_ message: AssistMessage) throws {
        guard message.content.utf8.count <= maximumMessageBytes else {
            throw AssistInferenceError.invalid(
                "Un message dépasse 1 Mio de texte UTF-8. Réduis le texte collé ou partage-le en plusieurs demandes ; aucun message n’a été tronqué.")
        }
    }
}

/// Tokenizer is Sendable at the pinned package revision. Preparation suspends
/// its owner while synchronous tokenization runs on the generic executor, so
/// status/cancel can enter the owner. Cancellation drains this call before any
/// engine submission; it cannot preempt the tokenizer's synchronous function.
enum AssistInferencePreparation {
    @concurrent
    static func perform<Value: Sendable>(
        check: @Sendable () throws -> Void,
        _ prepare: @Sendable () throws -> Value
    ) async throws -> Value {
        try Task.checkCancellation()
        try check()
        let value = try prepare()
        try Task.checkCancellation()
        try check()
        return value
    }
}

/// Race an owned model operation against its absolute deadline. Cancellation
/// actively stops the SDK, then structured concurrency drains the operation.
/// No detached stop can escape and cancel a subsequent request's engine.
enum AssistInferenceDeadline {
    private enum TimeLimit: Error { case reached }

    static func run<Value: Sendable>(
        until deadline: ContinuousClock.Instant,
        operation: @escaping @Sendable () async throws -> Value,
        cancelOperation: @escaping @Sendable () async -> Void,
        acceptCancelledValue: @escaping @Sendable (Value) -> Bool = { _ in false }
    ) async throws -> Value {
        func check() throws {
            try Task.checkCancellation()
            guard ContinuousClock.now < deadline else {
                throw TimeLimit.reached
            }
        }
        do {
            try check()
            return try await withThrowingTaskGroup(of: Value.self) { group in
                group.addTask { try check(); return try await operation() }
                group.addTask {
                    try await Task.sleep(until: deadline, clock: .continuous)
                    try check()
                    throw TimeLimit.reached
                }
                var completed: Value?
                do {
                    guard let value = try await group.next() else { throw CancellationError() }
                    completed = value
                    try check()
                    group.cancelAll()
                    return value
                } catch {
                    group.cancelAll()
                    await cancelOperation()
                    // A public text stream may retain an explicitly cancelled
                    // partial result, never an EOS success or a deadline result.
                    // Drain every remaining task before considering that value.
                    var drainFailure: (any Error)?
                    while !group.isEmpty {
                        do { if let value = try await group.next() { completed = value } }
                        catch {
                            if !(error is CancellationError), !(error is TimeLimit), drainFailure == nil {
                                drainFailure = error
                            }
                        }
                    }
                    // Preserve a real worker failure even when the timer won.
                    if error is CancellationError || error is TimeLimit {
                        if let drainFailure { throw drainFailure }
                    }
                    if error is CancellationError {
                        if let completed, acceptCancelledValue(completed) { return completed }
                    }
                    throw error
                }
            }
        } catch is TimeLimit {
            throw AssistInferenceError.invalid("Le budget de temps de la consultation locale est atteint.")
        }
    }
}

enum AssistInferencePolicy {
    static let sourceModel = "google/gemma-4-E2B-it"
    static let supportedContexts: Set<Int> = [8192, 32768]

    static func validateModel(tokenizer: String, context: Int, embeddedTokenizer: Bool) throws {
        guard tokenizer == sourceModel else {
            throw AssistInferenceError.invalid("Ce prototype accepte uniquement Gemma 4 E2B Instruct.")
        }
        guard supportedContexts.contains(context) else {
            throw AssistInferenceError.invalid("Un export réel 8 192 ou 32 768 jetons est requis.")
        }
        guard embeddedTokenizer else {
            throw AssistInferenceError.invalid("Tokenizer local absent : tout téléchargement implicite est interdit.")
        }
    }

    static func validateGraphs(_ names: [String], context: Int) throws {
        let decodeDimensions: [(Int, Int)] = names.compactMap { name in
            let pieces = name.split(separator: "_")
            guard pieces.count == 3, pieces[0] == "extend",
                let capacity = Int(pieces[1]), let query = Int(pieces[2]), capacity > 0, query > 0
            else { return nil }
            return (capacity, query)
        }
        guard names.contains("load_embeddings"),
            decodeDimensions.map({ $0.0 }).max() == context,
            // Apple's pinned Gemma export uses an 8-position extend graph even
            // for one-token decoding; it pads/masks the unused positions.
            decodeDimensions.contains(where: { $0.0 == context && $0.1 == 8 }),
            names.contains("prompt_opt_\(context)_64")
        else {
            throw AssistInferenceError.invalid("Les graphes Core AI ne correspondent pas au contexte déclaré.")
        }
    }

    static func outputBudget(promptTokens: Int, capacity: Int, requested: Int?) throws -> Int {
        guard promptTokens > 0, promptTokens < capacity else {
            throw AssistInferenceError.invalid("Le contexte est plein : conserve une place pour la réponse.")
        }
        if let requested, requested <= 0 {
            throw AssistInferenceError.invalid("Le budget de sortie doit être positif.")
        }
        return min(requested ?? capacity, capacity - promptTokens)
    }

    static func stopTokenIDs(metadata: Data, vocabSize: Int, tokenizerEOS: Int?) throws -> Set<Int32> {
        struct Envelope: Decodable {
            struct Language: Decodable {
                let eos_token_ids: [Int]
            }
            let language: Language
        }
        // Apple's Gemma exporter records the checkpoint's generation EOS union.
        // Do not treat every tokenizer "additional_special_token" as a stop token:
        // that can include non-terminal role or thinking markers.
        let declared = try JSONDecoder().decode(Envelope.self, from: metadata).language.eos_token_ids
        guard !declared.isEmpty else {
            throw AssistInferenceError.invalid("Le paquet ne déclare aucun jeton de fin de génération.")
        }
        let ids = Set(declared + (tokenizerEOS.map { [$0] } ?? []))
        guard ids.allSatisfy({ $0 >= 0 && $0 < vocabSize && $0 <= Int(Int32.max) }) else {
            throw AssistInferenceError.invalid("Jeton de fin hors du vocabulaire du modèle.")
        }
        return Set(ids.map(Int32.init))
    }

    /// Reject absolute, parent-traversing, or symlink-escaping paths from imported metadata.
    static func confinedURL(_ relativePath: String, root: URL) throws -> URL {
        guard !relativePath.isEmpty, !(relativePath as NSString).isAbsolutePath,
            !relativePath.split(separator: "/").contains("..")
        else {
            throw AssistInferenceError.invalid("Chemin d’artefact hors du dossier importé.")
        }
        let normalizedRoot = root.resolvingSymlinksInPath().standardizedFileURL
        let result = normalizedRoot.appendingPathComponent(relativePath).resolvingSymlinksInPath().standardizedFileURL
        guard result.path.hasPrefix(normalizedRoot.path + "/") else {
            throw AssistInferenceError.invalid("Un lien symbolique sort du dossier importé.")
        }
        return result
    }
}

/// Inspect every entry before listing a directory; metadata checks never read file contents.
enum AssistModelDirectoryPolicy {
    struct Entry {
        let isDirectory: Bool
        let isSymbolicLink: Bool
        let isReadable: Bool
        let isUbiquitous: Bool
        let isDownloaded: Bool
    }

    static func validate(
        _ root: URL,
        entry: (URL) throws -> Entry,
        children: (URL) throws -> [URL]
    ) throws {
        var pending = [root]
        while let url = pending.popLast() {
            let metadata = try entry(url)
            guard (url != root || metadata.isDirectory), !metadata.isSymbolicLink,
                metadata.isReadable, !metadata.isUbiquitous, metadata.isDownloaded
            else {
                throw NSError(
                    domain: "Assist.ModelDirectoryPicker", code: 1,
                    userInfo: [
                        NSLocalizedDescriptionKey: "Le modèle doit être entièrement téléchargé dans un dossier local, lisible et sans lien symbolique.",
                        "code": "E_MODEL_DIRECTORY"
                    ]
                )
            }
            if metadata.isDirectory { pending.append(contentsOf: try children(url)) }
        }
    }
}

enum AssistJSON {
    static func encode<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }
}

struct AssistLogitCandidate: Encodable, Sendable {
    let tokenId: Int
    let logit: Double
}

struct AssistLogitStep: Encodable, Sendable {
    let step: Int
    let tokenId: Int
    let topCandidates: [AssistLogitCandidate]
    let nonfiniteLogits: Int
    let logitsAvailable: Bool
}

/// Bounded observations of existing outputs; never changes logits or sampling.
enum AssistNumericalDiagnostics {
    static let maxSteps = 16

    static func enabled(promptTokens: Int, budget: Int, temperature: Double) -> Bool {
        (1...64).contains(promptTokens) && (1...64).contains(budget) && temperature == 0
    }

    static func step<Scalar: BinaryFloatingPoint>(
        index: Int, tokenId: Int, logits: [Scalar]?
    ) -> AssistLogitStep? {
        guard (0..<maxSteps).contains(index) else { return nil }
        guard let logits else {
            return AssistLogitStep(
                step: index, tokenId: tokenId, topCandidates: [],
                nonfiniteLogits: 0, logitsAvailable: false
            )
        }
        var first: AssistLogitCandidate?
        var second: AssistLogitCandidate?
        var nonfinite = 0
        func precedes(_ candidate: AssistLogitCandidate, _ current: AssistLogitCandidate) -> Bool {
            candidate.logit > current.logit
                || (candidate.logit == current.logit && candidate.tokenId < current.tokenId)
        }
        for (id, value) in logits.enumerated() {
            let score = Double(value)
            // Float16/Float values fit in Double. Also keep wider generic scalar
            // types from emitting an infinite Double into the JSON report.
            guard value.isFinite, score.isFinite else { nonfinite += 1; continue }
            let candidate = AssistLogitCandidate(tokenId: id, logit: score)
            if first.map({ precedes(candidate, $0) }) ?? true {
                second = first
                first = candidate
            } else if second.map({ precedes(candidate, $0) }) ?? true {
                second = candidate
            }
        }
        return AssistLogitStep(
            step: index, tokenId: tokenId, topCandidates: [first, second].compactMap { $0 },
            nonfiniteLogits: nonfinite, logitsAvailable: true
        )
    }

    /// Hash input format: each caller-validated nonnegative Int32 token encoded
    /// as one UInt32 in little-endian order, independent of native Int width.
    static func canonicalPromptBytes(_ tokens: [Int]) -> Data {
        var result = Data()
        result.reserveCapacity(tokens.count * 4)
        for token in tokens {
            var word = UInt32(token).littleEndian
            withUnsafeBytes(of: &word) { result.append(contentsOf: $0) }
        }
        return result
    }
}

/// Full-prefix snapshots preserve byte-fallback UTF-8 and tokenizer normalization.
/// Progress snapshots grow at least 1/64 beyond the last one, bounding cumulative
/// decoded tokens to 65 times output length; the final snapshot adds one more pass.
struct AssistOutputBuffer {
    private var ids: [Int] = []
    private var text = ""
    private var nextProgressSnapshot = 1
    var count: Int { ids.count }
    mutating func append(_ id: Int) { ids.append(id) }

    mutating func progressSnapshot(decode: ([Int]) -> String) -> String {
        guard count >= nextProgressSnapshot else { return text }
        return snapshot(decode: decode)
    }

    mutating func snapshot(decode: ([Int]) -> String) -> String {
        text = decode(ids)
        nextProgressSnapshot = count + max(1, (count + 63) / 64)
        return text
    }
}
