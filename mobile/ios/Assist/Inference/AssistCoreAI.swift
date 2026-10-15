import CoreAI
import CoreAILanguageModels
import Foundation
import Tokenizers

/// Objective-C boundary only. All mutable inference state belongs to the actor below.
/// Requires CoreAILM at 9db747612f972001279f02adb04d3ef982310d0e and the iOS 27.2 SDK.
@objc(AssistCoreAI)
final class AssistCoreAI: NSObject {
    private let coordinator = AssistInferenceCoordinator()

    @objc(status:)
    func status(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        let coordinator = coordinator
        Task { @concurrent in
            do { completion(try await coordinator.statusJSON(), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(load:completion:)
    func load(_ path: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        let coordinator = coordinator
        Task { @concurrent in
            do { completion(try await coordinator.load(path: path), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(generate:onProgress:completion:)
    func generate(
        _ requestJSON: String,
        onProgress: @escaping @Sendable (String) -> Void,
        completion: @escaping @Sendable (String?, NSError?) -> Void
    ) {
        let coordinator = coordinator
        Task { @concurrent in
            do { completion(try await coordinator.generate(requestJSON, onProgress: onProgress), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(cancel:)
    func cancel(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        let coordinator = coordinator
        Task { @concurrent in
            do { completion(try await coordinator.cancel(), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(reset:)
    func reset(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        let coordinator = coordinator
        Task { @concurrent in
            do { completion(try await coordinator.reset(), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(unload:)
    func unload(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        let coordinator = coordinator
        Task { @concurrent in
            do { completion(try await coordinator.unload(), nil) }
            catch { completion(nil, error as NSError) }
        }
    }
}

private enum AssistPhase: String, Codable, Sendable {
    case idle, loading, ready, generating, cancelling, failed
}

private struct AssistStatus: Encodable, Sendable {
    let nativeBuild = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
    let osVersion = ProcessInfo.processInfo.operatingSystemVersionString
    let phase: AssistPhase
    let contextCapacity: Int
    let modelName: String?
    let error: String?
    let loadElapsedMs: Double?
    let beforeLoadPhysicalFootprintBytes: UInt64?
    let afterLoadPhysicalFootprintBytes: UInt64?
    let loadMemoryMethod = "before/after snapshots; load peaks are not measured"
    let aneExecution = "unverified"
}

private struct AssistProgress: Encodable, Sendable {
    let requestId: String
    let text: String
    let generatedTokens: Int
    let promptTokens: Int
    let elapsedMs: Double
}

private struct AssistGenerationResult: Encodable, Sendable {
    let nativeBuild = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
    let osVersion = ProcessInfo.processInfo.operatingSystemVersionString
    let phase: AssistPhase
    let contextCapacity: Int
    let modelName: String?
    let requestId: String
    let text: String
    let generatedTokens: Int
    let promptTokens: Int
    let elapsedMs: Double
    let ttftMs: Double?
    let finishReason: String
    let requestedMaxTokens: Int?
    let effectiveMaxTokens: Int
    let peakPhysicalFootprintBytes: UInt64?
    // The max of periodic samples is not the kernel's lifetime or true transient peak.
    let peakMemoryMethod = "sampled; transient peaks may be missed"
    let aneExecution = "unverified"
}

/// Actor reentrancy does not serialize an entire async operation. The explicit busy
/// latch remains held across every await; only status and cooperative cancel enter.
private actor AssistInferenceCoordinator {
    private var phase = AssistPhase.idle
    private var operationInFlight = false
    private var cancellationWaiters = 0
    private var generationTask: Task<String, any Error>?
    private var engine: (any InferenceEngine)?
    private var tokenizer: (any Tokenizer)?
    private var stopTokens = Set<Int32>()
    private var capacity = 0
    private var modelName: String?
    private var lastError: String?
    private var loadElapsedMs: Double?
    private var beforeLoadFootprint: UInt64?
    private var afterLoadFootprint: UInt64?

    private var busy: Bool { operationInFlight || cancellationWaiters > 0 }

    func statusJSON() throws -> String {
        try AssistJSON.encode(AssistStatus(
            phase: phase, contextCapacity: capacity, modelName: modelName, error: lastError,
            loadElapsedMs: loadElapsedMs, beforeLoadPhysicalFootprintBytes: beforeLoadFootprint,
            afterLoadPhysicalFootprintBytes: afterLoadFootprint
        ))
    }

    func load(path: String) async throws -> String {
        guard !busy else { throw AssistInferenceError.busy }
        guard engine == nil else {
            throw AssistInferenceError.invalid("Décharge le modèle avant d’en sélectionner un autre.")
        }
        operationInFlight = true
        phase = .loading
        lastError = nil
        let loadClock = ContinuousClock()
        let loadStarted = loadClock.now
        loadElapsedMs = nil
        beforeLoadFootprint = Self.physicalFootprint()
        afterLoadFootprint = nil
        defer { operationInFlight = false }
        do {
            guard (path as NSString).isAbsolutePath else {
                throw AssistInferenceError.invalid("Un dossier local sélectionné dans Fichiers est requis.")
            }
            let root = URL(fileURLWithPath: path, isDirectory: true)
            let bundle = try LanguageModelBundle(at: root)
            try AssistInferencePolicy.validateModel(
                tokenizer: bundle.tokenizer, context: bundle.maxContextLength,
                embeddedTokenizer: bundle.hasEmbeddedTokenizer
            )
            // This prototype intentionally accepts only the standalone iOS text export.
            guard bundle.modelBundle.kind == .llm, bundle.visionConfig == nil,
                Set(bundle.modelBundle.assets.keys) == ["main"],
                Set(bundle.modelBundle.auxiliaryAssets.keys) == ["per_layer_embeddings"]
            else {
                throw AssistInferenceError.invalid("Structure du paquet Gemma 4 iOS inattendue.")
            }
            for relative in Array(bundle.modelBundle.assets.values) + Array(bundle.modelBundle.auxiliaryAssets.values) {
                _ = try AssistInferencePolicy.confinedURL(relative, root: root)
            }
            let localTokenizer = try AssistInferencePolicy.confinedURL("tokenizer", root: root)
            _ = try AssistInferencePolicy.confinedURL("tokenizer/tokenizer.json", root: root)
            _ = try AssistInferencePolicy.confinedURL("tokenizer/tokenizer_config.json", root: root)
            let assetURL = try bundle.modelBundle.requireModelURL(for: "main")
            let asset = try AIModelAsset(contentsOf: assetURL)
            guard let summary = try asset.summary(includingStatistics: false) else {
                throw AssistInferenceError.invalid("Impossible de vérifier les graphes du modèle.")
            }
            try AssistInferencePolicy.validateGraphs(summary.functions.map(\.name), context: bundle.maxContextLength)

            // Never call the network-enabled pretrained initializer. Complete tokenizer
            // construction before specializing the heavy model, avoiding concurrent peaks.
            let loadedTokenizer = try await AutoTokenizer.from(modelFolder: localTokenizer)
            let stops = try AssistInferencePolicy.stopTokenIDs(
                metadata: bundle.rawMetadata, vocabSize: bundle.vocabSize,
                tokenizerEOS: loadedTokenizer.eosTokenId
            )
            let runner = CoreAIRunner(bundle: bundle, variant: "static-shape")
            let loadedEngine = try await runner.makeInferenceEngine()
            guard loadedEngine.config.maxContextLength == bundle.maxContextLength else {
                throw AssistInferenceError.invalid("Le moteur et le paquet déclarent des contextes différents.")
            }
            try await loadedEngine.warmup(queryLength: 1, sampling: nil)
            self.tokenizer = loadedTokenizer
            self.engine = loadedEngine
            stopTokens = stops
            capacity = bundle.maxContextLength
            modelName = bundle.name
            phase = .ready
            loadElapsedMs = Self.milliseconds(loadStarted.duration(to: loadClock.now))
            afterLoadFootprint = Self.physicalFootprint()
            return try statusJSON()
        } catch {
            clearResidentIdentity()
            phase = .failed
            lastError = error.localizedDescription
            loadElapsedMs = Self.milliseconds(loadStarted.duration(to: loadClock.now))
            afterLoadFootprint = Self.physicalFootprint()
            throw error
        }
    }

    func generate(_ json: String, onProgress: @escaping @Sendable (String) -> Void) async throws -> String {
        guard !busy else { throw AssistInferenceError.busy }
        guard engine != nil, tokenizer != nil else { throw AssistInferenceError.notLoaded }
        let request = try JSONDecoder().decode(AssistGenerationRequest.self, from: Data(json.utf8))
        try request.validate()
        operationInFlight = true
        phase = .generating
        lastError = nil
        // Capturing this actor inherits its executor; tokenizer access stays on it.
        let task = Task { try await self.runGeneration(request, onProgress: onProgress) }
        generationTask = task
        return try await task.value
    }

    private func runGeneration(
        _ request: AssistGenerationRequest, onProgress: @escaping @Sendable (String) -> Void
    ) async throws -> String {
        defer {
            generationTask = nil
            operationInFlight = false
            phase = cancellationWaiters > 0 ? .cancelling : (engine == nil ? .failed : .ready)
        }
        guard let engine, let tokenizer else { throw AssistInferenceError.notLoaded }
        let started = ContinuousClock().now
        let messages: [Tokenizers.Message] = request.messages.map { ["role": $0.role, "content": $0.content] }
        let prompt = try tokenizer.applyChatTemplate(messages: messages)
        let budget = try AssistInferencePolicy.outputBudget(
            promptTokens: prompt.count, capacity: capacity, requested: request.maxTokens
        )
        guard prompt.allSatisfy({ $0 >= 0 && $0 <= Int(Int32.max) }) else {
            throw AssistInferenceError.invalid("Jeton hors de la plage native.")
        }
        do {
            let result = try await Self.consumeGeneration(
                request: request, prompt: prompt, budget: budget, capacity: capacity,
                modelName: modelName, engine: engine, tokenizer: tokenizer,
                stopTokens: stopTokens, started: started, onProgress: onProgress
            )
            return try AssistJSON.encode(result)
        } catch {
            // The one generation task has drained before we discard its resident identity.
            clearResidentIdentity()
            lastError = error.localizedDescription
            throw error
        }
    }

    /// Apple's output sequence is not Sendable. Create and consume it entirely on
    /// one generic-executor operation, returning only a Sendable result to the actor.
    /// The busy latch excludes all other engine mutations except its thread-safe cancel.
    @concurrent
    private static func consumeGeneration(
        request: AssistGenerationRequest, prompt: [Int], budget: Int, capacity: Int,
        modelName: String?, engine: any InferenceEngine, tokenizer: any Tokenizer,
        stopTokens: Set<Int32>, started: ContinuousClock.Instant,
        onProgress: @escaping @Sendable (String) -> Void
    ) async throws -> AssistGenerationResult {
        let clock = ContinuousClock()
        var generated = AssistOutputBuffer()
        var text = ""
        var ttft: Double?
        var peak = Self.physicalFootprint()
        var finishReason = "length"
        var lastProgress = started
        do {
            try Task.checkCancellation()
            let stream = try await engine.generate(
                with: prompt.map(Int32.init),
                samplingConfiguration: SamplingConfiguration(temperature: request.temperature),
                inferenceOptions: InferenceOptions(maxTokens: budget)
            )
            for try await output in stream {
                try Task.checkCancellation()
                if stopTokens.contains(output.tokenId) {
                    stream.setStopReason(.eos)
                    finishReason = "eos"
                    break
                }
                if ttft == nil { ttft = Self.milliseconds(started.duration(to: clock.now)) }
                generated.append(Int(output.tokenId))
                if let footprint = Self.physicalFootprint() { peak = max(peak ?? 0, footprint) }
                // Coalesce bridge traffic; never label an event or character count as tokens.
                if generated.count == 1 || Self.milliseconds(lastProgress.duration(to: clock.now)) >= 100 {
                    // Full snapshots preserve byte-fallback UTF-8 and tokenizer normalization.
                    // This correctness-first prototype still has cumulative O(n²) decoding
                    // cost; coalescing reduces work but is not a performance qualification.
                    text = generated.snapshot { tokenizer.decode(tokens: $0) }
                    onProgress(try AssistJSON.encode(AssistProgress(
                        requestId: request.requestId, text: text, generatedTokens: generated.count,
                        promptTokens: prompt.count, elapsedMs: Self.milliseconds(started.duration(to: clock.now))
                    )))
                    lastProgress = clock.now
                }
            }
            if stream.stopReason == .cancelled || Task.isCancelled { finishReason = "cancelled" }
            // Break-on-EOS abandons iteration. Explicitly release its active generation,
            // rather than draining unnecessary tokens until the context limit.
            try await engine.cancel()
        } catch is CancellationError {
            finishReason = "cancelled"
            try await engine.cancel()
        } catch {
            try? await engine.cancel()
            throw error
        }
        // Always emit the final whole-prefix snapshot, including cancellation.
        text = generated.snapshot { tokenizer.decode(tokens: $0) }
        onProgress(try AssistJSON.encode(AssistProgress(
            requestId: request.requestId, text: text, generatedTokens: generated.count,
            promptTokens: prompt.count, elapsedMs: Self.milliseconds(started.duration(to: clock.now))
        )))
        return AssistGenerationResult(
            phase: .ready, contextCapacity: capacity, modelName: modelName,
            requestId: request.requestId, text: text, generatedTokens: generated.count,
            promptTokens: prompt.count, elapsedMs: Self.milliseconds(started.duration(to: clock.now)),
            ttftMs: ttft, finishReason: finishReason,
            requestedMaxTokens: request.maxTokens, effectiveMaxTokens: budget,
            peakPhysicalFootprintBytes: peak
        )
    }

    func cancel() async throws -> String {
        guard let task = generationTask else {
            guard !busy else { throw AssistInferenceError.busy }
            return try statusJSON()
        }
        cancellationWaiters += 1
        phase = .cancelling
        defer {
            cancellationWaiters -= 1
            if cancellationWaiters == 0, !operationInFlight { phase = engine == nil ? .failed : .ready }
        }
        task.cancel()
        try await engine?.cancel()
        // Acknowledgement means the operation has stopped, not merely that a flag was set.
        _ = await task.result
        return try AssistJSON.encode(AssistStatus(
            phase: engine == nil ? .failed : .ready,
            contextCapacity: capacity, modelName: modelName, error: lastError,
            loadElapsedMs: loadElapsedMs, beforeLoadPhysicalFootprintBytes: beforeLoadFootprint,
            afterLoadPhysicalFootprintBytes: afterLoadFootprint
        ))
    }

    func reset() async throws -> String {
        guard !busy else { throw AssistInferenceError.busy }
        guard let engine else { throw AssistInferenceError.notLoaded }
        operationInFlight = true
        defer { operationInFlight = false }
        do {
            try await engine.reset(to: 0)
            phase = .ready
            lastError = nil
            return try statusJSON()
        } catch {
            clearResidentIdentity()
            phase = .failed
            lastError = error.localizedDescription
            throw error
        }
    }

    func unload() async throws -> String {
        guard !busy else { throw AssistInferenceError.busy }
        operationInFlight = true
        defer { operationInFlight = false }
        // Never mutate/reset an engine while a stream may still reference it.
        if let engine { try await engine.cancel() }
        clearResidentIdentity()
        lastError = nil
        phase = .idle
        return try statusJSON()
    }

    private func clearResidentIdentity() {
        engine = nil
        tokenizer = nil
        stopTokens = []
        capacity = 0
        modelName = nil
    }

    private static func milliseconds(_ duration: Duration) -> Double {
        let parts = duration.components
        return Double(parts.seconds) * 1_000 + Double(parts.attoseconds) / 1e15
    }

    private static func physicalFootprint() -> UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : nil
    }
}
