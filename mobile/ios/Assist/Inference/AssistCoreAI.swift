import CoreAI
import CoreAILanguageModels
import CryptoKit
import Foundation
import Tokenizers

/// Objective-C boundary only. All mutable inference state belongs to the actor below.
/// Requires pinned CoreAILM and Core AI SDK APIs; Gemma execution requires iOS 27.2+.
@objc(AssistCoreAI)
final class AssistCoreAI: NSObject {
    private let monitor: AssistRuntimeMonitor
    private let coordinator: AssistInferenceCoordinator

    override init() {
        let monitor = AssistRuntimeMonitor()
        self.monitor = monitor
        self.coordinator = AssistInferenceCoordinator(monitor: monitor)
        super.init()
    }

    @objc(monitoringSnapshot:)
    func monitoringSnapshot(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        let monitor = monitor
        Task { @concurrent in
            do { completion(try await monitor.snapshotJSON(), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(shutdownMonitoring:)
    func shutdownMonitoring(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        let monitor = monitor
        Task { @concurrent in
            await monitor.shutdown()
            completion("{}", nil)
        }
    }

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

    @objc(runNumericalProbe:)
    func runNumericalProbe(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        let coordinator = coordinator
        Task { @concurrent in
            do { completion(try await coordinator.runNumericalProbe(), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(lastModelLoadProbe:)
    func lastModelLoadProbe(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        Task { @concurrent in
            do { completion(try AssistModelLoadProbe.lastReportJSON(), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(repairNumericalProbe:)
    func repairNumericalProbe(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        let coordinator = coordinator
        Task { @concurrent in
            do { completion(try await coordinator.repairNumericalProbe(), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(repairModelLoadProbe:functionName:completion:)
    func repairModelLoadProbe(
        _ path: String, functionName: String,
        completion: @escaping @Sendable (String?, NSError?) -> Void
    ) {
        let coordinator = coordinator
        Task { @concurrent in
            do { completion(try await coordinator.repairModelLoadProbe(path: path, functionName: functionName), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(lastSpecializationRepair:)
    func lastSpecializationRepair(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        Task { @concurrent in
            do { completion(try AssistSpecializationRepair.lastReportJSON(), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(lastModelAssetProbe:)
    func lastModelAssetProbe(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        Task { @concurrent in
            do { completion(try AssistModelAssetProbe.lastReportJSON(), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(runModelAssetProbe:completion:)
    func runModelAssetProbe(_ path: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        let coordinator = coordinator
        Task { @concurrent in
            do { completion(try await coordinator.runModelAssetProbe(path: path), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(runModelLoadProbe:functionName:completion:)
    func runModelLoadProbe(
        _ path: String, functionName: String,
        completion: @escaping @Sendable (String?, NSError?) -> Void
    ) {
        let coordinator = coordinator
        Task { @concurrent in
            do { completion(try await coordinator.runModelLoadProbe(path: path, functionName: functionName), nil) }
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
    let numericalDiagnostics: AssistNumericalTrace?
}

/// Bounded local qualification evidence. The prompt itself is not added to reports.
private struct AssistNumericalTrace: Encodable, Sendable {
    let schemaVersion = 1
    let promptTokenEncoding = "uint32-little-endian"
    let promptTokenSHA256: String
    let logitsDomain = "engine_returned"
    let temperature: Double
    let processedTokensBefore: Int
    let processedTokensAtGenerationStart: Int
    let steps: [AssistLogitStep]
}

/// Actor reentrancy does not serialize an entire async operation. The explicit busy
/// latch remains held across every await; only status and cooperative cancel enter.
private actor AssistInferenceCoordinator {
    private let monitor: AssistRuntimeMonitor
    private var phase = AssistPhase.idle
    private var operationInFlight = false
    private var cancellationWaiters = 0
    private var generationTask: Task<String, any Error>?
    private var repairTask: Task<String, any Error>?
    private var engine: (any InferenceEngine)?
    private var tokenizer: (any Tokenizer)?
    private var stopTokens = Set<Int32>()
    private var capacity = 0
    private var modelName: String?
    private var lastError: String?
    private var loadElapsedMs: Double?
    private var beforeLoadFootprint: UInt64?
    private var afterLoadFootprint: UInt64?

    init(monitor: AssistRuntimeMonitor) {
        self.monitor = monitor
    }

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
        await monitor.transition(phase: phase.rawValue, code: "MODEL_LOAD_STARTED")
        lastError = nil
        let loadClock = ContinuousClock()
        let loadStarted = loadClock.now
        loadElapsedMs = nil
        beforeLoadFootprint = Self.physicalFootprint()
        afterLoadFootprint = nil
        defer { operationInFlight = false }
        do {
            // The app can compile/deploy against iOS 27.1, but Apple's Gemma
            // export requires the 27.2 runtime. Reject before any model IO.
            guard #available(iOS 27.2, *) else {
                throw AssistInferenceError.invalid("Gemma nécessite iOS 27.2 ou une version ultérieure. Aucun modèle n’a été chargé.")
            }
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
            await monitor.setContextCapacity(capacity)
            await monitor.transition(phase: phase.rawValue, code: "MODEL_LOAD_COMPLETED")
            return try statusJSON()
        } catch {
            clearResidentIdentity()
            phase = .failed
            lastError = error.localizedDescription
            loadElapsedMs = Self.milliseconds(loadStarted.duration(to: loadClock.now))
            afterLoadFootprint = Self.physicalFootprint()
            await monitor.setContextCapacity(nil)
            await monitor.transition(phase: phase.rawValue, code: "MODEL_LOAD_FAILED", severity: "critical")
            throw error
        }
    }

    func generate(_ json: String, onProgress: @escaping @Sendable (String) -> Void) async throws -> String {
        guard !busy else { throw AssistInferenceError.busy }
        guard engine != nil, tokenizer != nil else { throw AssistInferenceError.notLoaded }
        do {
            let request = try JSONDecoder().decode(AssistGenerationRequest.self, from: Data(json.utf8))
            try request.validate()
            operationInFlight = true
            phase = .generating
            lastError = nil
            // Capturing this actor inherits its executor; tokenizer access stays on it.
            let task = Task { try await self.runGeneration(request, onProgress: onProgress) }
            generationTask = task
            let result = try await task.value
            // runGeneration's defer has restored the actual engine phase before this point.
            return result
        } catch {
            if engine == nil { await monitor.setContextCapacity(nil) }
            await monitor.transition(phase: engine == nil ? "failed" : "ready",
                                     code: engine == nil ? "GENERATION_FAILED" : "GENERATION_REJECTED",
                                     severity: engine == nil ? "critical" : "warning")
            throw error
        }
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
        await monitor.beginGeneration(
            requestId: request.requestId, promptTokens: prompt.count, contextCapacity: capacity,
            elapsedMs: Self.milliseconds(started.duration(to: ContinuousClock.now))
        )
        do {
            let result = try await Self.consumeGeneration(
                request: request, prompt: prompt, budget: budget, capacity: capacity,
                modelName: modelName, engine: engine, tokenizer: tokenizer,
                stopTokens: stopTokens, started: started, monitor: monitor, onProgress: onProgress
            )
            await monitor.endGeneration(
                requestId: request.requestId, promptTokens: result.promptTokens,
                generatedTokens: result.generatedTokens, elapsedMs: result.elapsedMs,
                ttftMs: result.ttftMs, finishReason: result.finishReason
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
        monitor: AssistRuntimeMonitor,
        onProgress: @escaping @Sendable (String) -> Void
    ) async throws -> AssistGenerationResult {
        let clock = ContinuousClock()
        var generated = AssistOutputBuffer()
        var text = ""
        var ttft: Double?
        var peak = Self.physicalFootprint()
        var finishReason = "length"
        var lastProgress = started
        let diagnosticsEnabled = engine.supportsLogits && AssistNumericalDiagnostics.enabled(
            promptTokens: prompt.count, budget: budget, temperature: request.temperature
        )
        let promptFingerprint = diagnosticsEnabled
            ? SHA256.hash(data: AssistNumericalDiagnostics.canonicalPromptBytes(prompt))
                .map { String(format: "%02x", $0) }.joined()
            : nil
        let processedTokensBefore = engine.processedTokenCount
        var processedTokensAtGenerationStart = processedTokensBefore
        var diagnosticSteps: [AssistLogitStep] = []
        do {
            try Task.checkCancellation()
            let stream = try await engine.generate(
                with: prompt.map(Int32.init),
                samplingConfiguration: SamplingConfiguration(temperature: request.temperature),
                inferenceOptions: InferenceOptions(maxTokens: budget, includeLogits: diagnosticsEnabled)
            )
            processedTokensAtGenerationStart = engine.processedTokenCount
            for try await output in stream {
                try Task.checkCancellation()
                if diagnosticsEnabled,
                    let step = AssistNumericalDiagnostics.step(
                        index: diagnosticSteps.count, tokenId: Int(output.tokenId), logits: output.logits
                    )
                {
                    diagnosticSteps.append(step)
                }
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
                    // Counts remain live while text snapshots use bounded decode work.
                    text = generated.progressSnapshot { tokenizer.decode(tokens: $0) }
                    onProgress(try AssistJSON.encode(AssistProgress(
                        requestId: request.requestId, text: text, generatedTokens: generated.count,
                        promptTokens: prompt.count, elapsedMs: Self.milliseconds(started.duration(to: clock.now))
                    )))
                    await monitor.progress(
                        requestId: request.requestId, promptTokens: prompt.count,
                        generatedTokens: generated.count,
                        elapsedMs: Self.milliseconds(started.duration(to: clock.now)), ttftMs: ttft
                    )
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
            peakPhysicalFootprintBytes: peak,
            numericalDiagnostics: promptFingerprint.map {
                AssistNumericalTrace(
                    promptTokenSHA256: $0, temperature: request.temperature,
                    processedTokensBefore: processedTokensBefore,
                    processedTokensAtGenerationStart: processedTokensAtGenerationStart,
                    steps: diagnosticSteps
                )
            }
        )
    }

    func cancel() async throws -> String {
        if let task = repairTask {
            cancellationWaiters += 1
            defer { cancellationWaiters -= 1 }
            task.cancel()
            await monitor.transition(phase: "cancelling", code: "CANCELLATION_REQUESTED")
            // Keep the exclusive latch until cooperative cancellation and persistence drain.
            _ = await task.result
            await monitor.transition(phase: phase.rawValue, code: "PHASE_CHANGED")
            return try statusJSON()
        }
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
        await monitor.transition(phase: phase.rawValue, code: "CANCELLATION_REQUESTED")
        try await engine?.cancel()
        // Acknowledgement means the operation has stopped, not merely that a flag was set.
        _ = await task.result
        await monitor.transition(phase: engine == nil ? "failed" : "ready", code: "PHASE_CHANGED")
        return try AssistJSON.encode(AssistStatus(
            phase: engine == nil ? .failed : .ready,
            contextCapacity: capacity, modelName: modelName, error: lastError,
            loadElapsedMs: loadElapsedMs, beforeLoadPhysicalFootprintBytes: beforeLoadFootprint,
            afterLoadPhysicalFootprintBytes: afterLoadFootprint
        ))
    }

    func runNumericalProbe() async throws -> String {
        guard !busy else { throw AssistInferenceError.busy }
        guard engine == nil else {
            throw AssistInferenceError.invalid("Décharge le modèle avant le diagnostic de calcul.")
        }
        guard #available(iOS 27.2, *) else {
            throw AssistInferenceError.invalid("Ce diagnostic nécessite iOS 27.2 ou une version ultérieure.")
        }
        operationInFlight = true
        defer { operationInFlight = false }
        await monitor.beginDiagnostic(total: 48)
        do {
            let result = try await AssistNumericalProbe.run { [monitor] variant, mode, function, passed in
                await monitor.diagnosticCase(variant: variant, mode: mode, function: function, passed: passed)
            }
            await monitor.endDiagnostic(phase: phase.rawValue)
            return result
        } catch {
            await monitor.transition(phase: phase.rawValue, code: "DIAGNOSTIC_FAILED", severity: "warning")
            throw error
        }
    }

    func runModelLoadProbe(path: String, functionName: String) async throws -> String {
        guard !busy else { throw AssistInferenceError.busy }
        guard engine == nil else {
            throw AssistInferenceError.invalid("Décharge le modèle avant le diagnostic de chargement.")
        }
        guard #available(iOS 27.2, *) else {
            throw AssistInferenceError.invalid("Ce diagnostic nécessite iOS 27.2 ou une version ultérieure.")
        }
        operationInFlight = true
        defer { operationInFlight = false }
        await monitor.transition(phase: "diagnosing", code: "LOAD_PROBE_STARTED")
        do {
            let result = try await AssistModelLoadProbe.run(path: path, functionName: functionName)
            let report = try JSONDecoder().decode(AssistModelLoadProbe.Report.self, from: Data(result.utf8))
            let failed = report.stage == .failed
            await monitor.transition(phase: phase.rawValue,
                                     code: failed ? "LOAD_PROBE_FAILED" : "LOAD_PROBE_COMPLETED",
                                     severity: failed ? "warning" : "info")
            return result
        } catch {
            await monitor.transition(phase: phase.rawValue, code: "LOAD_PROBE_FAILED", severity: "warning")
            throw error
        }
    }

    /// A repair is a separate manual operation, never a retry hidden inside loading.
    /// The busy latch excludes all engine/probe mutations through validation, deletion and qualification.
    func repairNumericalProbe() async throws -> String {
        guard !busy else { throw AssistInferenceError.busy }
        guard engine == nil else {
            throw AssistInferenceError.invalid("Décharge le modèle avant de réparer sa préparation.")
        }
        guard #available(iOS 27.2, *) else {
            throw AssistInferenceError.invalid("Cette réparation nécessite iOS 27.2 ou une version ultérieure.")
        }
        let monitor = monitor
        return try await runRepair(diagnosticCases: 48) {
            try await Self.repairNumericalSpecialization { variant, mode, function, passed in
                await monitor.diagnosticCase(variant: variant, mode: mode, function: function, passed: passed)
            }
        }
    }

    func repairModelLoadProbe(path: String, functionName: String) async throws -> String {
        guard !busy else { throw AssistInferenceError.busy }
        guard engine == nil else {
            throw AssistInferenceError.invalid("Décharge le modèle avant de réparer sa préparation.")
        }
        guard #available(iOS 27.2, *) else {
            throw AssistInferenceError.invalid("Cette réparation nécessite iOS 27.2 ou une version ultérieure.")
        }
        // Keep the first repair bounded to the function whose failure was captured.
        guard functionName == "extend_1024_8" else { throw AssistModelLoadProbe.Failure.invalidRequest }
        return try await runRepair {
            try await Self.repairSelectedSpecialization(path: path, functionName: functionName)
        }
    }

    private func runRepair(
        diagnosticCases: Int? = nil, operation: @escaping @Sendable () async throws -> String
    ) async throws -> String {
        operationInFlight = true
        // Register before the first suspension so cancel can always find the active repair.
        let task = Task {
            defer {
                repairTask = nil
                operationInFlight = false
            }
            await monitor.transition(phase: "diagnosing", code: "SPECIALIZATION_REPAIR_STARTED")
            if let diagnosticCases { await monitor.beginDiagnostic(total: diagnosticCases) }
            do {
                let result = try await operation()
                if diagnosticCases != nil { await monitor.endDiagnostic(phase: phase.rawValue) }
                await monitor.transition(phase: phase.rawValue, code: "SPECIALIZATION_REPAIR_COMPLETED")
                return result
            } catch {
                if diagnosticCases != nil {
                    await monitor.transition(phase: phase.rawValue, code: "DIAGNOSTIC_FAILED", severity: "warning")
                }
                await monitor.transition(phase: phase.rawValue, code: "SPECIALIZATION_REPAIR_FAILED", severity: "warning")
                throw error
            }
        }
        repairTask = task
        return try await task.value
    }

    @concurrent
    private static func repairNumericalSpecialization(
        onCase: @escaping @Sendable (String, String, String, Bool) async -> Void
    ) async throws -> String {
        return try await AssistSpecializationRepair.run(
            target: .bundledF16,
            nativeBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            verifySource: { try AssistNumericalProbe.assetURLForSpecializationRepair() },
            invalidate: { assetURL in
                try AIModelCache.default.deleteEntry(
                    for: assetURL, options: SpecializationOptions(preferredComputeUnitKind: .neuralEngine))
            }, qualify: { try await AssistNumericalProbe.run(onCase: onCase) }
        )
    }

    @concurrent
    private static func repairSelectedSpecialization(path: String, functionName: String) async throws -> String {
        // Retain selection errors until the orchestrator has persisted a fresh source-verification marker.
        let selected: Result<(AssistModelAssetProbe.Identity, AssistSpecializationRepair.Target), any Error> = Result {
            let identity = try AssistModelAssetProbe.selectedIdentity(path: path)
            return (identity, try AssistSpecializationRepair.Target.selected(modelName: identity.modelName))
        }
        let target: AssistSpecializationRepair.Target
        switch selected {
        case .success(let source): target = source.1
        case .failure: target = .selectedGemmaF16
        }
        return try await AssistSpecializationRepair.run(
            target: target,
            nativeBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            verifySource: {
                let identity = try selected.get().0
                let initial = AssistModelAssetProbe.Report(
                    identity: identity,
                    nativeBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
                    osVersion: ProcessInfo.processInfo.operatingSystemVersionString)
                let result = try AssistModelAssetProbe.execute(
                    path: path, report: initial, store: AssistModelAssetProbe.Store.applicationSupport())
                let verified = try JSONDecoder().decode(AssistModelAssetProbe.Report.self, from: Data(result.utf8))
                guard verified.stage == .completed else { throw AssistModelLoadProbe.Failure.invalidBundle }
                return URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
                    .appendingPathComponent(identity.modelName + ".aimodel", isDirectory: true)
            }, invalidate: { assetURL in
                try AIModelCache.default.deleteEntry(
                    for: assetURL, options: SpecializationOptions(preferredComputeUnitKind: .neuralEngine))
            }, qualify: { try await AssistModelLoadProbe.run(path: path, functionName: functionName) }
        )
    }

    func runModelAssetProbe(path: String) async throws -> String {
        guard !busy else { throw AssistInferenceError.busy }
        guard engine == nil else {
            throw AssistInferenceError.invalid("Décharge le modèle avant de vérifier ses fichiers.")
        }
        operationInFlight = true
        defer { operationInFlight = false }
        await monitor.transition(phase: "diagnosing", code: "ASSET_PROBE_STARTED")
        do {
            let result = try await AssistModelAssetProbe.run(path: path)
            let report = try JSONDecoder().decode(AssistModelAssetProbe.Report.self, from: Data(result.utf8))
            let failed = report.stage == .failed
            await monitor.transition(phase: phase.rawValue,
                                     code: failed ? "ASSET_PROBE_FAILED" : "ASSET_PROBE_COMPLETED",
                                     severity: failed ? "warning" : "info")
            return result
        } catch {
            await monitor.transition(phase: phase.rawValue, code: "ASSET_PROBE_FAILED", severity: "warning")
            throw error
        }
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
            await monitor.transition(phase: phase.rawValue, code: "CONVERSATION_RESET")
            return try statusJSON()
        } catch {
            clearResidentIdentity()
            phase = .failed
            lastError = error.localizedDescription
            await monitor.setContextCapacity(nil)
            await monitor.transition(phase: phase.rawValue, code: "CONVERSATION_RESET_FAILED", severity: "critical")
            throw error
        }
    }

    func unload() async throws -> String {
        guard !busy else { throw AssistInferenceError.busy }
        operationInFlight = true
        defer { operationInFlight = false }
        // Never mutate/reset an engine while a stream may still reference it.
        do {
            if let engine { try await engine.cancel() }
        } catch {
            await monitor.transition(phase: phase.rawValue, code: "MODEL_UNLOAD_FAILED", severity: "warning")
            throw error
        }
        clearResidentIdentity()
        lastError = nil
        phase = .idle
        await monitor.setContextCapacity(nil)
        await monitor.transition(phase: phase.rawValue, code: "MODEL_UNLOADED")
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
