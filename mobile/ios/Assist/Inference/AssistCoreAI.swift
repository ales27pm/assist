import CoreAI
import CoreAILanguageModels
import CryptoKit
import Foundation
import FluidAudio
import Tokenizers

/// Objective-C boundary only. All mutable inference state belongs to the actor below.
/// Requires pinned CoreAILM and Core AI SDK APIs; Gemma execution requires iOS 27.2+.
@objc(AssistCoreAI)
final class AssistCoreAI: NSObject {
    private let monitor: AssistRuntimeMonitor
    private let coordinator: AssistInferenceCoordinator
    @MainActor private var voiceMonitoringTask: Task<Void, Never>?
    @MainActor private var agentAdmission: AssistAgentAdmission?
    @MainActor private var toolBroker: AssistToolTransactionCoordinator?

    override init() {
        let monitor = AssistRuntimeMonitor()
        self.monitor = monitor
        self.coordinator = AssistInferenceCoordinator(monitor: monitor)
        super.init()
        // BEGIN CORE ML MONITOR OBSERVER
        // Installed by native engine ownership, never per voice runtime. The
        // global SDK hook cannot keep this bridge or its monitor alive.
        CoreMLPredictionDiagnostics.observer = { [weak monitor] event in
            await monitor?.recordCoreMLPrediction(
                id: event.id, component: event.component, state: event.state, computeUnits: event.computeUnits,
                inputs: event.inputs.map {
                    AssistRuntimePredictionTensor(name: $0.name, shape: $0.shape, dataType: $0.dataType, count: $0.count)
                }, inputFeatureCount: event.inputFeatureCount, metadataTruncated: event.metadataTruncated)
        }
        // END CORE ML MONITOR OBSERVER
        // Monitoring starts with the native engine, not with the diagnostics
        // screen. Model loading and blocked JS must not suspend sampling.
        Task { @concurrent in
            await monitor.start()
            await AssistDebugDiagnostics.shared.start()
        }
        Task { @MainActor in
            if #available(iOS 27.0, *) { AssistSystemDiagnostics.start() }
        }
    }

    @objc(monitoringSnapshot:)
    func monitoringSnapshot(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        let monitor = monitor
        Task { @concurrent in
            do { completion(try await monitor.snapshotJSON(), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @objc(previousMonitoringSnapshot:)
    func previousMonitoringSnapshot(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        let monitor = monitor
        Task { @concurrent in
            do { completion(try await monitor.previousSnapshotJSON(), nil) }
            catch { completion(nil, error as NSError) }
        }
    }

    @MainActor @objc(recordVoiceMonitoringStage:)
    func recordVoiceMonitoringStage(_ stage: String) {
        let monitor = monitor
        let previous = voiceMonitoringTask
        // Preserve native callback order even when actor delivery is delayed.
        // Neither the task nor the monitor captures this bridge object.
        voiceMonitoringTask = Task { @concurrent in
            await previous?.value
            await monitor.recordVoiceStage(stage)
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

    @MainActor @objc(generate:onProgress:completion:)
    func generate(
        _ requestJSON: String,
        onProgress: @escaping @Sendable (String) -> Void,
        completion: @escaping @Sendable (String?, NSError?) -> Void
    ) {
        guard agentAdmission?.isFinished != false else { completion(nil, AssistInferenceError.busy as NSError); return }
        let coordinator = coordinator
        // Reserve the same revocable operation identity as tool/research runs
        // before the actor hop. cancel() may arrive before that hop is admitted.
        let admission = AssistAgentAdmission()
        agentAdmission = admission
        Task { @concurrent in
            do {
                let result = try await coordinator.generate(requestJSON, admission: admission, onProgress: onProgress)
                admission.finish()
                completion(result, nil)
            } catch {
                admission.finish()
                completion(nil, error as NSError)
            }
        }
    }

    @MainActor @objc(generateCalendarToday:gateway:onProgress:onCalendarActivity:completion:)
    func generateCalendarToday(
        _ requestJSON: String, gateway: AssistDeviceCapabilities,
        onProgress: @escaping @Sendable (String) -> Void,
        onCalendarActivity: @escaping @Sendable (String) -> Void,
        completion: @escaping @Sendable (String?, NSError?) -> Void
    ) {
        let coordinator = coordinator
        guard agentAdmission?.isFinished != false else { completion(nil, AssistInferenceError.busy as NSError); return }
        let admission = AssistAgentAdmission()
        agentAdmission = admission
        Task { @concurrent in
            do {
                let result = try await coordinator.generateCalendarToday(
                    requestJSON, gateway: gateway, admission: admission, onProgress: onProgress,
                    onCalendarActivity: onCalendarActivity)
                admission.finish()
                completion(result, nil)
            } catch {
                admission.finish()
                completion(nil, error as NSError)
            }
        }
    }

    @MainActor @objc(generateWithTools:gateway:onToolActivity:completion:)
    func generateWithTools(
        _ requestJSON: String, gateway: AssistDeviceCapabilities,
        onToolActivity: @escaping @Sendable (String) -> Void,
        completion: @escaping @Sendable (String?, NSError?) -> Void
    ) {
        guard agentAdmission?.isFinished != false else { completion(nil, AssistInferenceError.busy as NSError); return }
        if toolBroker == nil { toolBroker = AssistToolTransactionCoordinator(gateway: gateway) }
        guard let broker = toolBroker else { completion(nil, AssistInferenceError.busy as NSError); return }
        let coordinator = coordinator
        let admission = AssistAgentAdmission()
        agentAdmission = admission
        Task { @concurrent in
            do {
                let result = try await coordinator.generateWithTools(
                    requestJSON, broker: broker, admission: admission, onToolActivity: onToolActivity)
                admission.finish()
                completion(result, nil)
            } catch {
                admission.finish()
                completion(nil, error as NSError)
            }
        }
    }

    /// Additive v2 entrypoint. It shares the admission, broker and engine owner
    /// with v1; capability negotiation never grants permission to execute.
    @MainActor @objc(generateWithToolHost:gateway:onToolActivity:completion:)
    func generateWithToolHost(
        _ requestJSON: String, gateway: AssistDeviceCapabilities,
        onToolActivity: @escaping @Sendable (String) -> Void,
        completion: @escaping @Sendable (String?, NSError?) -> Void
    ) {
        guard agentAdmission?.isFinished != false else { completion(nil, AssistInferenceError.busy as NSError); return }
        if toolBroker == nil { toolBroker = AssistToolTransactionCoordinator(gateway: gateway) }
        guard let broker = toolBroker else { completion(nil, AssistInferenceError.busy as NSError); return }
        let coordinator = coordinator
        let admission = AssistAgentAdmission()
        agentAdmission = admission
        Task { @concurrent in
            do {
                let result = try await coordinator.generateWithToolHost(
                    requestJSON, broker: broker, admission: admission, onToolActivity: onToolActivity)
                admission.finish()
                completion(result, nil)
            } catch {
                admission.finish()
                completion(nil, error as NSError)
            }
        }
    }

    @MainActor @objc(generateResearch:completion:)
    func generateResearch(_ requestJSON: String,
                          completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard agentAdmission?.isFinished != false else { completion(nil, AssistInferenceError.busy as NSError); return }
        let coordinator = coordinator
        let service = AssistPrivateService.shared
        let admission = AssistAgentAdmission()
        agentAdmission = admission
        Task { @concurrent in
            do {
                let output = try await coordinator.generateResearch(requestJSON, service: service, admission: admission)
                admission.finish(); completion(output, nil)
            } catch {
                admission.finish(); completion(nil, error as NSError)
            }
        }
    }

    @objc(researchCapabilities:)
    func researchCapabilities(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        struct Capabilities: Encodable {
            let schemaVersion = 1
            let protocolVersion = 1
            let profile = "research_v1"
            let tools = ["web_search", "web_read"]
            let maximumSearches = 1
            let maximumPageReads = 4
            let maximumDurationSeconds = 120
        }
        do { completion(try AssistJSON.encode(Capabilities()), nil) }
        catch { completion(nil, error as NSError) }
    }

    @MainActor @objc(confirmToolAction:confirmationToken:completion:)
    func confirmToolAction(
        _ transactionId: String, confirmationToken: String,
        completion: @escaping @Sendable (String?, NSError?) -> Void
    ) {
        do {
            let accepted = try toolBroker?.confirm(transactionId: transactionId, token: confirmationToken) ?? false
            completion("{\"schemaVersion\":1,\"accepted\":\(accepted ? "true" : "false")}", nil)
        } catch { completion(nil, error as NSError) }
    }

    @MainActor @objc(toolOperationsWithGateway:completion:)
    func toolOperations(
        gateway: AssistDeviceCapabilities, completion: @escaping @Sendable (String?, NSError?) -> Void
    ) {
        if toolBroker == nil { toolBroker = AssistToolTransactionCoordinator(gateway: gateway) }
        completion(toolBroker?.snapshotOperations() ?? "{\"schemaVersion\":1,\"operations\":[]}", nil)
    }

    @objc(deviceToolCapabilities:)
    func deviceToolCapabilities(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        struct Capabilities: Encodable {
            let schemaVersion = 1
            let protocolVersion = 1
            let tools = AssistToolName.legacyCases.map(\.rawValue)
            let confirmation = "all_accesses"
        }
        do { completion(try AssistJSON.encode(Capabilities()), nil) }
        catch { completion(nil, error as NSError) }
    }

    @objc(toolHostCapabilities:)
    func toolHostCapabilities(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        do { completion(try AssistToolHost.capabilitiesJSON(), nil) }
        catch { completion(nil, error as NSError) }
    }

    @MainActor @objc var allowsTransientToolInactivity: Bool {
        toolBroker?.allowsTransientInactivity ?? false
    }

    @MainActor @objc(cancel:)
    func cancel(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        let coordinator = coordinator
        let admission = agentAdmission
        admission?.cancel()
        toolBroker?.cancelPending()
        Task { @concurrent in
            do {
                let status = try await coordinator.cancel()
                await admission?.waitForFinish()
                completion(status, nil)
            } catch {
                await admission?.waitForFinish()
                completion(nil, error as NSError)
            }
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
    var text: String
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
    var agentTrace: AssistAgentTrace? = nil
    var agentTools: Bool? = nil
    var weather: [AssistToolValue]? = nil
}

private struct AssistDecodedGeneration: Sendable {
    let result: AssistGenerationResult
    let stoppedToken: Int32?
}

private struct AssistAgentEngineFailure: Error {
    let cause: any Error
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
    private var tokenizer: (any Tokenizers.Tokenizer)?
    private var agentChatTemplate: String?
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
        await AssistDebugDiagnostics.shared.record(category: .engine, stage: .modelLoad, outcome: .began)
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
            // Planning and execution use this hash-bound canonical dialect.
            // An unqualified template cannot silently enter either phase.
            var compatibleAgentTemplate: String?
            if let templateURL = try? AssistInferencePolicy.confinedURL("tokenizer/chat_template.jinja", root: root),
               let data = try? Data(contentsOf: templateURL, options: .mappedIfSafe), data.count <= 64 * 1_024,
               SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined()
                    == AssistGemmaToolAdapter.canonicalTemplateSHA256,
               let original = String(data: data, encoding: .utf8) {
                compatibleAgentTemplate = try? AssistGemmaToolAdapter.compatibleTemplate(original)
            }
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
            self.agentChatTemplate = compatibleAgentTemplate
            self.engine = loadedEngine
            stopTokens = stops
            capacity = bundle.maxContextLength
            modelName = bundle.name
            phase = .ready
            loadElapsedMs = Self.milliseconds(loadStarted.duration(to: loadClock.now))
            afterLoadFootprint = Self.physicalFootprint()
            await monitor.setContextCapacity(capacity)
            await monitor.transition(phase: phase.rawValue, code: "MODEL_LOAD_COMPLETED")
            await AssistDebugDiagnostics.shared.record(category: .engine, stage: .modelLoad, outcome: .completed,
                metrics: [.durationMs: loadElapsedMs ?? 0, .contextCapacity: Double(capacity)])
            return try statusJSON()
        } catch {
            clearResidentIdentity()
            phase = .failed
            lastError = error.localizedDescription
            loadElapsedMs = Self.milliseconds(loadStarted.duration(to: loadClock.now))
            afterLoadFootprint = Self.physicalFootprint()
            await monitor.setContextCapacity(nil)
            await monitor.transition(phase: phase.rawValue, code: "MODEL_LOAD_FAILED", severity: "critical")
            await AssistDebugDiagnostics.shared.record(category: .engine, stage: .modelLoad, outcome: .failed,
                reason: .engine, metrics: [.durationMs: loadElapsedMs ?? 0])
            throw error
        }
    }

    func generate(_ json: String, admission: AssistAgentAdmission,
                  onProgress: @escaping @Sendable (String) -> Void) async throws -> String {
        try admission.check()
        guard !busy else { throw AssistInferenceError.busy }
        guard engine != nil, tokenizer != nil else { throw AssistInferenceError.notLoaded }
        do {
            let request = try AssistGenerationRequest.decodeJSON(json)
            try admission.check()
            operationInFlight = true
            phase = .generating
            lastError = nil
            let task = Task { try await self.runGeneration(request, admission: admission, onProgress: onProgress) }
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

    func generateCalendarToday(
        _ json: String, gateway: AssistDeviceCapabilities, admission: AssistAgentAdmission,
        onProgress: @escaping @Sendable (String) -> Void,
        onCalendarActivity: @escaping @Sendable (String) -> Void
    ) async throws -> String {
        try admission.check()
        try AssistInferenceInputPolicy.validateJSON(json)
        guard !busy else { throw AssistInferenceError.busy }
        guard engine != nil, tokenizer != nil else { throw AssistInferenceError.notLoaded }
        let request = try AssistAgentRunController.request(from: json)
        let scope = try AssistAgentCalendarScope.today()
        operationInFlight = true
        phase = .generating
        lastError = nil
        // The same generationTask/busy latch owns both passes AND the native
        // read. Cancellation cannot free the engine between those suspensions.
        let task = Task {
            try await self.runCalendarGeneration(request, scope: scope, gateway: gateway,
                                                 admission: admission, onProgress: onProgress,
                                                 onCalendarActivity: onCalendarActivity)
        }
        generationTask = task
        return try await task.value
    }

    func generateWithTools(
        _ json: String, broker: AssistToolTransactionCoordinator, admission: AssistAgentAdmission,
        onToolActivity: @escaping @Sendable (String) -> Void
    ) async throws -> String {
        try admission.check()
        try AssistInferenceInputPolicy.validateJSON(json)
        guard !busy else { throw AssistInferenceError.busy }
        guard engine != nil, tokenizer != nil else { throw AssistInferenceError.notLoaded }
        let request = try AssistDeviceToolRun.request(from: json)
        return try await startDeviceToolGeneration(
            request, allowedTools: Set(AssistToolName.legacyCases), broker: broker,
            admission: admission, onToolActivity: onToolActivity)
    }

    func generateWithToolHost(
        _ json: String, broker: AssistToolTransactionCoordinator, admission: AssistAgentAdmission,
        onToolActivity: @escaping @Sendable (String) -> Void
    ) async throws -> String {
        try admission.check()
        try AssistInferenceInputPolicy.validateJSON(json)
        guard !busy else { throw AssistInferenceError.busy }
        guard engine != nil, tokenizer != nil else { throw AssistInferenceError.notLoaded }
        // A stale/unknown contract is rejected before model submission and
        // before the shared operation latch is acquired. No v1 downgrade.
        let selection = try AssistToolHost.selection(from: json)
        return try await startDeviceToolGeneration(
            selection.request, allowedTools: selection.allowedTools,
            referenceContext: selection.referenceContext, hostProtocolVersion: selection.hostProtocolVersion, broker: broker,
            admission: admission, onToolActivity: onToolActivity)
    }

    func generateResearch(_ json: String, service: AssistPrivateService,
                          admission: AssistAgentAdmission) async throws -> String {
        try admission.check()
        try AssistInferenceInputPolicy.validateJSON(json)
        guard !busy else { throw AssistInferenceError.busy }
        guard engine != nil, tokenizer != nil else { throw AssistInferenceError.notLoaded }
        let request = try AssistResearchRun.request(from: json)
        operationInFlight = true
        phase = .generating
        lastError = nil
        let task = Task { try await self.runResearchGeneration(request, service: service, admission: admission) }
        generationTask = task
        return try await task.value
    }

    private func runResearchGeneration(_ request: AssistGenerationRequest, service: AssistPrivateService,
                                       admission: AssistAgentAdmission) async throws -> String {
        defer {
            generationTask = nil
            operationInFlight = false
            phase = cancellationWaiters > 0 ? .cancelling : (engine == nil ? .failed : .ready)
        }
        await AssistDebugDiagnostics.shared.record(category: .engine, stage: .admission, outcome: .completed,
            requestId: request.requestId, metrics: [.messageCount: Double(request.messages.count)])
        guard let engine, let tokenizer, let agentChatTemplate else { throw AssistInferenceError.notLoaded }
        let capacity = capacity
        let modelName = modelName
        let monitor = monitor
        let stops = stopTokens.union([Int32(50)])
        let deadline = ContinuousClock.now.advanced(by: .seconds(120))
        var lease: UUID?
        do {
            try admission.check()
            // Reuse the same canonical/token-ID qualification as native tools,
            // but no private-device declaration enters the research prompt.
            try await AssistInferencePreparation.perform(check: { try admission.check() }) {
                try Self.validateAgentTokenizer(tokenizer, request: request, scope: .today(), chatTemplate: agentChatTemplate)
            }
            let thought = try await prepareThoughtTree(request: request,
                baseMessages: AssistResearchAdapter.planningMessages(request: request),
                tools: AssistResearchAdapter.closedToolSchema(), scope: .research,
                admission: admission, deadline: deadline, chatTemplate: agentChatTemplate)
            let ownedLease = try await service.beginResearch(requestId: request.requestId, admission: admission)
            lease = ownedLease
            let outcome = try await AssistResearchRun.run(request: request, deadline: deadline,
                model: { messages, requestedBudget, calls in
                    try Task.checkCancellation()
                    try admission.check()
                    try await service.checkResearch(ownedLease)
                    let prompt = try await AssistInferencePreparation.perform(check: { try admission.check() }) {
                        let prompt = try tokenizer.applyChatTemplate(
                            messages: AssistThoughtTree.applySelection(thought, to: messages),
                            chatTemplate: .literal(agentChatTemplate), addGenerationPrompt: true,
                            truncation: false, maxLength: nil, tools: AssistResearchAdapter.closedToolSchema(),
                            additionalContext: AssistResearchAdapter.additionalContext)
                        let rendered = tokenizer.decode(tokens: prompt, skipSpecialTokens: false)
                        if calls.isEmpty { try AssistResearchAdapter.validateRenderedPlanningPrompt(rendered) }
                        else { try AssistResearchAdapter.validateRenderedContinuationPrompt(rendered, calls: calls) }
                        guard prompt.allSatisfy({ $0 >= 0 && $0 <= Int(Int32.max) }) else {
                            throw AssistInferenceError.invalid("Jeton de recherche hors de la plage native.")
                        }
                        return prompt
                    }
                    let budget = try AssistInferencePolicy.outputBudget(promptTokens: prompt.count,
                        capacity: capacity, requested: requestedBudget)
                    let started = ContinuousClock.now
                    let passId = String(request.requestId.prefix(100)) + ":research-\(calls.count)"
                    await monitor.beginGeneration(requestId: passId, promptTokens: prompt.count,
                                                  contextCapacity: capacity, elapsedMs: 0)
                    let decoded: AssistDecodedGeneration
                    do {
                        decoded = try await Self.consumeGeneration(request: request, prompt: prompt, budget: budget,
                            capacity: capacity, modelName: modelName, engine: engine, tokenizer: tokenizer,
                            stopTokens: stops, started: started, monitor: monitor, onProgress: { _ in },
                            emitPublicProgress: false, deadline: deadline, monitorRequestId: passId)
                    } catch is CancellationError { throw CancellationError() }
                    catch let policy as AssistInferenceError { throw policy }
                    catch { throw AssistAgentEngineFailure(cause: error) }
                    await monitor.endGeneration(requestId: passId, promptTokens: decoded.result.promptTokens,
                        generatedTokens: decoded.result.generatedTokens, elapsedMs: decoded.result.elapsedMs,
                        ttftMs: decoded.result.ttftMs, finishReason: decoded.result.finishReason)
                    try admission.check()
                    try await service.checkResearch(ownedLease)
                    if decoded.result.finishReason == "cancelled" { throw CancellationError() }
                    if calls.isEmpty {
                        let decision = try AssistResearchAdapter.parse(raw: decoded.result.text,
                            stoppedAtToolResponse: decoded.stoppedToken == 50)
                        let name: String?
                        switch decision { case .call(let call): name = call.name.rawValue; case .answer: name = nil }
                        try AssistThoughtTree.validateFirstAction(thought, toolName: name)
                    }
                    await monitor.transition(phase: "generating", code: "PHASE_CHANGED")
                    let safeText = decoded.stoppedToken == 50 ? decoded.result.text
                        : try AssistThoughtTree.publicAnswer(decoded.result.text, selection: thought,
                            completedEOS: decoded.result.finishReason == "eos")
                    return AssistAgentModelTurn(rawText: safeText,
                        stoppedAtToolResponse: decoded.stoppedToken == 50,
                        completed: decoded.result.finishReason == "eos", value: decoded.result)
                }, perform: { call in
                    try admission.check()
                    return try await service.performResearch(call, lease: ownedLease)
                }, isCancelled: { admission.isCancelled })
            try admission.check()
            try await service.checkResearch(ownedLease)
            struct Output: Encodable {
                let schemaVersion = 1
                let requestId: String
                let text: String
                let sources: [AssistResearchSource]
                let degraded: Bool
            }
            let output = try AssistJSON.encode(Output(requestId: request.requestId,
                text: outcome.visibleText, sources: outcome.sources, degraded: outcome.degraded))
            await service.endResearch(ownedLease, preserveSources: true)
            await monitor.transition(phase: "ready", code: "PHASE_CHANGED")
            try Task.checkCancellation()
            try admission.check()
            return output
        } catch let failure as AssistAgentEngineFailure {
            if let lease { await service.endResearch(lease, preserveSources: false) }
            await service.discardResearchSources(requestId: request.requestId)
            clearResidentIdentity()
            lastError = failure.cause.localizedDescription
            await monitor.setContextCapacity(nil)
            await monitor.transition(phase: "failed", code: "GENERATION_FAILED", severity: "critical")
            throw failure.cause
        } catch {
            if let lease { await service.endResearch(lease, preserveSources: false) }
            await service.discardResearchSources(requestId: request.requestId)
            await monitor.transition(phase: "ready", code: "GENERATION_REJECTED", severity: "warning")
            throw error
        }
    }

    private func startDeviceToolGeneration(
        _ request: AssistGenerationRequest, allowedTools: Set<AssistToolName>,
        referenceContext: AssistDeviceReferenceContext = .empty, hostProtocolVersion: Int = 2,
        broker: AssistToolTransactionCoordinator, admission: AssistAgentAdmission,
        onToolActivity: @escaping @Sendable (String) -> Void
    ) async throws -> String {
        operationInFlight = true
        phase = .generating
        lastError = nil
        let task = Task {
            try await self.runDeviceToolGeneration(
                request, allowedTools: allowedTools, referenceContext: referenceContext,
                hostProtocolVersion: hostProtocolVersion, broker: broker,
                admission: admission, onToolActivity: onToolActivity)
        }
        generationTask = task
        return try await task.value
    }

    private func runDeviceToolGeneration(
        _ request: AssistGenerationRequest, allowedTools: Set<AssistToolName>,
        referenceContext: AssistDeviceReferenceContext, hostProtocolVersion: Int, broker: AssistToolTransactionCoordinator,
        admission: AssistAgentAdmission, onToolActivity: @escaping @Sendable (String) -> Void
    ) async throws -> String {
        defer {
            generationTask = nil
            operationInFlight = false
            phase = cancellationWaiters > 0 ? .cancelling : (engine == nil ? .failed : .ready)
        }
        await AssistDebugDiagnostics.shared.record(category: .engine, stage: .admission, outcome: .completed,
            requestId: request.requestId, metrics: [.messageCount: Double(request.messages.count)])
        guard let engine, let tokenizer else { throw AssistInferenceError.notLoaded }
        guard let agentChatTemplate else {
            throw AssistInferenceError.invalid("Le template local n’est pas qualifié pour les outils. Aucun accès exécuté.")
        }
        let capacity = capacity
        let modelName = modelName
        let monitor = monitor
        let stops = stopTokens.union([Int32(50)])
        let deadline = ContinuousClock.now.advanced(by: .seconds(180))
        do {
            try admission.check()
            try await AssistInferencePreparation.perform(check: { try admission.check() }) {
                try Self.validateDeviceToolTokenizer(tokenizer, request: request, chatTemplate: agentChatTemplate,
                                                     allowedTools: allowedTools, referenceContext: referenceContext)
            }
            let thought = try await prepareThoughtTree(request: request,
                baseMessages: AssistDeviceToolAdapter.planningMessages(request: request, referenceContext: referenceContext),
                tools: AssistDeviceToolAdapter.closedToolSchema(allowedTools: allowedTools), scope: .device,
                admission: admission, deadline: deadline, chatTemplate: agentChatTemplate)
            let outcome = try await AssistDeviceToolRun.run(
                request: request, deadline: deadline, allowedTools: allowedTools,
                referenceContext: referenceContext, model: { messages, requestedBudget, calls in
                    try Task.checkCancellation()
                    try admission.check()
                    let prompt = try await AssistInferencePreparation.perform(check: { try admission.check() }) {
                        let prompt = try tokenizer.applyChatTemplate(
                            messages: AssistThoughtTree.applySelection(thought, to: messages),
                            chatTemplate: .literal(agentChatTemplate), addGenerationPrompt: true,
                            truncation: false, maxLength: nil, tools: AssistDeviceToolAdapter.closedToolSchema(allowedTools: allowedTools),
                            additionalContext: AssistGemmaToolAdapter.additionalContext)
                        let rendered = tokenizer.decode(tokens: prompt, skipSpecialTokens: false)
                        if calls.isEmpty {
                            try AssistDeviceToolAdapter.validateRenderedPlanningPrompt(rendered, allowedTools: allowedTools)
                        } else {
                            try AssistDeviceToolAdapter.validateRenderedContinuationPrompt(rendered, calls: calls, allowedTools: allowedTools)
                        }
                        guard prompt.allSatisfy({ $0 >= 0 && $0 <= Int(Int32.max) }) else {
                            throw AssistInferenceError.invalid("Jeton des outils hors de la plage native.")
                        }
                        return prompt
                    }
                    let budget = try AssistInferencePolicy.outputBudget(
                        promptTokens: prompt.count, capacity: capacity, requested: requestedBudget)
                    let started = ContinuousClock.now
                    let passId = String(request.requestId.prefix(100)) + ":tools-\(calls.count)"
                    await monitor.beginGeneration(requestId: passId, promptTokens: prompt.count,
                                                  contextCapacity: capacity, elapsedMs: 0)
                    let decoded: AssistDecodedGeneration
                    do {
                        decoded = try await Self.consumeGeneration(
                            request: request, prompt: prompt, budget: budget, capacity: capacity,
                            modelName: modelName, engine: engine, tokenizer: tokenizer, stopTokens: stops,
                            started: started, monitor: monitor, onProgress: { _ in },
                            emitPublicProgress: false, deadline: deadline, monitorRequestId: passId)
                    } catch is CancellationError {
                        await monitor.recordToolPass(passIndex: calls.count, finishReason: "cancelled")
                        throw CancellationError()
                    } catch let policy as AssistInferenceError {
                        await monitor.recordToolPass(passIndex: calls.count, finishReason: "error")
                        throw policy
                    } catch {
                        await monitor.recordToolPass(passIndex: calls.count, finishReason: "error")
                        throw AssistAgentEngineFailure(cause: error)
                    }
                    // Keep only a bounded, closed outcome code before protocol
                    // validation can reject an empty EOS or malformed proposal.
                    await monitor.recordToolPass(passIndex: calls.count,
                        finishReason: decoded.result.finishReason,
                        stoppedAtToolResponse: decoded.stoppedToken == 50,
                        generatedTokens: decoded.result.generatedTokens)
                    await monitor.endGeneration(
                        requestId: passId, promptTokens: decoded.result.promptTokens,
                        generatedTokens: decoded.result.generatedTokens, elapsedMs: decoded.result.elapsedMs,
                        ttftMs: decoded.result.ttftMs, finishReason: decoded.result.finishReason)
                    if decoded.result.finishReason == "cancelled" { throw CancellationError() }
                    if calls.isEmpty {
                        let decision = try AssistDeviceToolAdapter.parse(raw: decoded.result.text,
                            stoppedAtToolResponse: decoded.stoppedToken == 50, allowedTools: allowedTools)
                        let name: String?
                        switch decision { case .call(let call): name = call.name.rawValue; case .answer: name = nil }
                        try AssistThoughtTree.validateFirstAction(thought, toolName: name)
                    }
                    // The engine owner remains occupied during confirmation
                    // and tool execution, even though this model pass ended.
                    await monitor.transition(phase: "generating", code: "PHASE_CHANGED")
                    let safeText = decoded.stoppedToken == 50 ? decoded.result.text
                        : try AssistThoughtTree.publicAnswer(decoded.result.text, selection: thought,
                            completedEOS: decoded.result.finishReason == "eos")
                    return AssistAgentModelTurn(rawText: safeText,
                                               stoppedAtToolResponse: decoded.stoppedToken == 50,
                                               completed: decoded.result.finishReason == "eos", value: decoded.result)
                }, perform: { call in
                    try Task.checkCancellation()
                    try admission.check()
                    guard allowedTools.contains(call.name) else { throw AssistToolContractError.invalidArguments }
                    do {
                        return try await broker.perform(call: call, requestId: request.requestId,
                                                        admission: admission, onActivity: onToolActivity)
                    } catch AssistToolTransactionError.outcomeUnknown {
                        // Never let a model turn convert an uncertain write to
                        // "done" or propose a duplicate. The journal is truth.
                        return .object(["status": .string("outcome_unknown")])
                    } catch AssistToolTransactionError.cancelledBeforeSubmission {
                        return .object(["status": .string("cancelled")])
                    } catch AssistToolTransactionError.cancelled {
                        return .object(["status": .string("cancelled")])
                    }
                }, isCancelled: { admission.isCancelled })
            try Task.checkCancellation()
            try admission.check()
            var result = outcome.value
            // Public text is either validated model prose for a data-bearing
            // read or exact native receipt text for a completed action. Only
            // broker receipts/journal, never model prose, prove side effects.
            result = AssistGenerationResult(
                phase: result.phase, contextCapacity: result.contextCapacity, modelName: result.modelName,
                requestId: result.requestId, text: outcome.visibleText, generatedTokens: result.generatedTokens,
                promptTokens: result.promptTokens, elapsedMs: result.elapsedMs, ttftMs: result.ttftMs,
                finishReason: outcome.cancelled ? "cancelled" : result.finishReason, requestedMaxTokens: result.requestedMaxTokens,
                effectiveMaxTokens: result.effectiveMaxTokens, peakPhysicalFootprintBytes: result.peakPhysicalFootprintBytes,
                numericalDiagnostics: nil, agentTools: true,
                weather: outcome.weather.isEmpty ? nil : outcome.weather)
            await monitor.transition(phase: "ready", code: "PHASE_CHANGED")
            if hostProtocolVersion == 3 {
                return try AssistToolHost.resultJSON(result,
                    referenceContextEligible: outcome.referenceContextEligible && result.finishReason == "eos")
            }
            return try AssistJSON.encode(result)
        } catch let failure as AssistAgentEngineFailure {
            clearResidentIdentity()
            lastError = failure.cause.localizedDescription
            await monitor.setContextCapacity(nil)
            await monitor.transition(phase: "failed", code: "GENERATION_FAILED", severity: "critical")
            throw failure.cause
        } catch {
            await monitor.transition(phase: "ready", code: "GENERATION_REJECTED", severity: "warning")
            throw error
        }
    }

    private static func validateDeviceToolTokenizer(
        _ tokenizer: any Tokenizers.Tokenizer, request: AssistGenerationRequest, chatTemplate: String,
        allowedTools: Set<AssistToolName>, referenceContext: AssistDeviceReferenceContext = .empty
    ) throws {
        // Same hash-bound canonical dialect as the existing read-only path.
        try validateAgentTokenizer(tokenizer, request: request, scope: .today(), chatTemplate: chatTemplate)
        let messages = try AssistDeviceToolAdapter.planningMessages(request: request, referenceContext: referenceContext)
        func render(_ messages: [[String: any Sendable]]) throws -> String {
            let tokens = try tokenizer.applyChatTemplate(
                messages: messages, chatTemplate: .literal(chatTemplate), addGenerationPrompt: true,
                truncation: false, maxLength: nil, tools: AssistDeviceToolAdapter.closedToolSchema(allowedTools: allowedTools),
                additionalContext: AssistGemmaToolAdapter.additionalContext)
            return tokenizer.decode(tokens: tokens, skipSpecialTokens: false)
        }
        try AssistDeviceToolAdapter.validateRenderedPlanningPrompt(render(messages), allowedTools: allowedTools)
        // The baseline probe still qualifies the canonical dialect; a recipe
        // cannot silently add its probe capability to the selected tool set.
        guard allowedTools.contains(.device_capabilities) else { return }
        let call = AssistDeviceToolCall(name: .device_capabilities, arguments: [:])
        let continuation = try AssistDeviceToolAdapter.continuationMessages(
            messages: messages, call: call, result: .object(["available": .bool(true)]))
        try AssistDeviceToolAdapter.validateRenderedContinuationPrompt(render(continuation), calls: [call], allowedTools: allowedTools)
    }

    private func runCalendarGeneration(
        _ request: AssistGenerationRequest, scope: AssistAgentCalendarScope,
        gateway: AssistDeviceCapabilities, admission: AssistAgentAdmission,
        onProgress: @escaping @Sendable (String) -> Void,
        onCalendarActivity: @escaping @Sendable (String) -> Void
    ) async throws -> String {
        defer {
            generationTask = nil
            operationInFlight = false
            phase = cancellationWaiters > 0 ? .cancelling : (engine == nil ? .failed : .ready)
        }
        await AssistDebugDiagnostics.shared.record(category: .engine, stage: .admission, outcome: .completed,
            requestId: request.requestId, metrics: [.messageCount: Double(request.messages.count)])
        guard let engine, let tokenizer else { throw AssistInferenceError.notLoaded }
        guard let agentChatTemplate else {
            throw AssistInferenceError.invalid("Le template local n’est pas qualifié pour cette consultation. Aucun calendrier lu.")
        }
        let capacity = capacity
        let modelName = modelName
        let monitor = monitor
        let stops = stopTokens.union([Int32(50)])
        let deadline = ContinuousClock.now.advanced(by: .seconds(60))
        do {
            try admission.check()
            try await AssistInferencePreparation.perform(check: { try admission.check() }) {
                try Self.validateAgentTokenizer(tokenizer, request: request, scope: scope, chatTemplate: agentChatTemplate)
            }
            let thought = try await prepareThoughtTree(request: request,
                baseMessages: AssistGemmaToolAdapter.planningMessages(request: request, scope: scope),
                tools: AssistGemmaToolAdapter.closedToolSchema(scope: scope), scope: .calendar,
                admission: admission, deadline: deadline, chatTemplate: agentChatTemplate)
            let outcome = try await AssistAgentRunController.run(
                request: request, scope: scope, deadline: deadline,
                model: { messages, requestedBudget, planning in
                    try Task.checkCancellation()
                    try admission.check()
                    let prompt = try await AssistInferencePreparation.perform(check: { try admission.check() }) {
                        let prompt = try tokenizer.applyChatTemplate(
                            messages: AssistThoughtTree.applySelection(thought, to: messages),
                            chatTemplate: .literal(agentChatTemplate), addGenerationPrompt: true,
                            truncation: false, maxLength: nil,
                            tools: AssistGemmaToolAdapter.closedToolSchema(scope: scope),
                            additionalContext: AssistGemmaToolAdapter.additionalContext)
                        let rendered = tokenizer.decode(tokens: prompt, skipSpecialTokens: false)
                        if planning {
                            try AssistGemmaToolAdapter.validateRenderedPlanningPrompt(rendered, scope: scope)
                        } else {
                            try AssistGemmaToolAdapter.validateRenderedContinuationPrompt(
                                rendered, call: .init(startISO: scope.startISO, endISO: scope.endISO, limit: 5), scope: scope)
                        }
                        guard prompt.allSatisfy({ $0 >= 0 && $0 <= Int(Int32.max) }) else {
                            throw AssistInferenceError.invalid("Jeton agent hors de la plage native.")
                        }
                        return prompt
                    }
                    if planning {
                        guard capacity - prompt.count >= AssistAgentRunController.planningTokenBudget
                            + AssistAgentRunController.resultTokenReserve + AssistAgentRunController.answerTokenBudget else {
                            throw AssistInferenceError.invalid("Contexte insuffisant pour réserver le résultat calendrier et la réponse.")
                        }
                    }
                    let budget = try AssistInferencePolicy.outputBudget(
                        promptTokens: prompt.count, capacity: capacity, requested: requestedBudget)
                    let started = ContinuousClock.now
                    let passId = String(request.requestId.prefix(100)) + (planning ? ":agent-plan" : ":agent-answer")
                    await monitor.beginGeneration(
                        requestId: passId, promptTokens: prompt.count,
                        contextCapacity: capacity, elapsedMs: 0)
                    let decoded: AssistDecodedGeneration
                    do {
                        decoded = try await Self.consumeGeneration(
                            request: request, prompt: prompt, budget: budget, capacity: capacity,
                            modelName: modelName, engine: engine, tokenizer: tokenizer, stopTokens: stops,
                            started: started, monitor: monitor, onProgress: onProgress,
                            emitPublicProgress: false, deadline: deadline, monitorRequestId: passId)
                    } catch is CancellationError { throw CancellationError() }
                    catch let policy as AssistInferenceError { throw policy }
                    catch { throw AssistAgentEngineFailure(cause: error) }
                    await monitor.endGeneration(
                        requestId: passId, promptTokens: decoded.result.promptTokens,
                        generatedTokens: decoded.result.generatedTokens, elapsedMs: decoded.result.elapsedMs,
                        ttftMs: decoded.result.ttftMs, finishReason: decoded.result.finishReason)
                    if decoded.result.finishReason == "cancelled" { throw CancellationError() }
                    if planning {
                        let decision = try AssistGemmaToolAdapter.parse(raw: decoded.result.text,
                            stoppedAtToolResponse: decoded.stoppedToken == 50, scope: scope)
                        let name: String?
                        switch decision { case .call(let call): name = call.name; case .answer: name = nil }
                        try AssistThoughtTree.validateFirstAction(thought, toolName: name)
                    }
                    await monitor.transition(phase: "generating", code: "PHASE_CHANGED")
                    let safeText = decoded.stoppedToken == 50 ? decoded.result.text
                        : try AssistThoughtTree.publicAnswer(decoded.result.text, selection: thought,
                            completedEOS: decoded.result.finishReason == "eos")
                    return AssistAgentModelTurn(
                        rawText: safeText, stoppedAtToolResponse: decoded.stoppedToken == 50,
                        completed: decoded.result.finishReason == "eos", value: decoded.result)
                },
                readCalendar: { scope in
                    try admission.check()
                    return try await gateway.readCalendarForAgent(scope: scope, admission: admission)
                }, isCancelled: { admission.isCancelled }, activity: { event in
                    // The typed encoder has no transcript, argument or row fields.
                    // The bridge enqueues these sequential callbacks on MAIN and
                    // fences them by the owning operation before delivery to JS.
                    try Task.checkCancellation()
                    try admission.check()
                    onCalendarActivity(try AssistJSON.encode(event))
                })
            try Task.checkCancellation()
            try admission.check()
            // Only a complete, validated user-facing answer crosses the bridge.
            // All tool syntax and observations stay inside this native task.
            let result = outcome.value
            let safeResult = AssistGenerationResult(
                phase: result.phase, contextCapacity: result.contextCapacity, modelName: result.modelName,
                requestId: result.requestId, text: outcome.visibleText, generatedTokens: result.generatedTokens,
                promptTokens: result.promptTokens, elapsedMs: result.elapsedMs, ttftMs: result.ttftMs,
                finishReason: result.finishReason, requestedMaxTokens: result.requestedMaxTokens,
                effectiveMaxTokens: result.effectiveMaxTokens, peakPhysicalFootprintBytes: result.peakPhysicalFootprintBytes,
                numericalDiagnostics: nil, agentTrace: outcome.trace)
            onProgress(try AssistJSON.encode(AssistProgress(
                requestId: safeResult.requestId, text: outcome.visibleText,
                generatedTokens: safeResult.generatedTokens, promptTokens: safeResult.promptTokens,
                elapsedMs: safeResult.elapsedMs)))
            await monitor.transition(phase: "ready", code: "PHASE_CHANGED")
            return try AssistJSON.encode(safeResult)
        } catch let failure as AssistAgentEngineFailure {
            clearResidentIdentity()
            lastError = failure.cause.localizedDescription
            await monitor.setContextCapacity(nil)
            await monitor.transition(phase: "failed", code: "GENERATION_FAILED", severity: "critical")
            throw failure.cause
        } catch {
            // Parse, permission, deadline and cancellation failures do not
            // invent a reply, retry the read or silently load another model.
            await monitor.transition(phase: "ready", code: "GENERATION_REJECTED", severity: "warning")
            throw error
        }
    }

    private static func validateAgentTokenizer(
        _ tokenizer: any Tokenizers.Tokenizer,
        request: AssistGenerationRequest, scope: AssistAgentCalendarScope, chatTemplate: String
    ) throws {
        for (identifier, marker) in [(48, "<|tool_call>"), (49, "<tool_call|>"), (50, "<|tool_response>"),
                                     (51, "<tool_response|>"), (106, "<turn|>"), (1, "<eos>")] {
            guard tokenizer.convertTokenToId(marker) == identifier,
                  tokenizer.decode(tokens: [identifier], skipSpecialTokens: false) == marker,
                  tokenizer.encode(text: marker, addSpecialTokens: false) == [identifier] else {
                throw AssistInferenceError.invalid("Le tokenizer local n’a pas le dialecte d’outils Gemma qualifié.")
            }
        }
        // Untrusted text cannot inject literal template control markers.
        guard request.messages.allSatisfy({ !$0.content.contains("<|") && !$0.content.contains("|>") }) else {
            throw AssistInferenceError.invalid("Un message contient un délimiteur réservé du modèle.")
        }
        let probe = AssistGenerationRequest(
            requestId: "template-probe", messages: [.init(role: "user", content: AssistAgentRunController.userPrompt)],
            temperature: 0, maxTokens: nil)
        let prompt = try tokenizer.applyChatTemplate(
            messages: AssistGemmaToolAdapter.planningMessages(request: probe, scope: scope),
            chatTemplate: .literal(chatTemplate), addGenerationPrompt: true, truncation: false, maxLength: nil,
            tools: AssistGemmaToolAdapter.closedToolSchema(scope: scope),
            additionalContext: AssistGemmaToolAdapter.additionalContext)
        let rendered = tokenizer.decode(tokens: prompt, skipSpecialTokens: false)
        try AssistGemmaToolAdapter.validateRenderedPlanningPrompt(rendered, scope: scope)
        let call = AssistGemmaToolAdapter.Call(startISO: scope.startISO, endISO: scope.endISO, limit: 5)
        let emptyObservation = AssistAgentCalendarObservation(scope: scope, events: [], possiblyTruncated: false)
        let continuation = try tokenizer.applyChatTemplate(
            messages: AssistGemmaToolAdapter.continuationMessages(
                request: probe, call: call, toolResponse: emptyObservation.modelResponse, scope: scope),
            chatTemplate: .literal(chatTemplate), addGenerationPrompt: true, truncation: false, maxLength: nil,
            tools: AssistGemmaToolAdapter.closedToolSchema(scope: scope),
            additionalContext: AssistGemmaToolAdapter.additionalContext)
        let continued = tokenizer.decode(tokens: continuation, skipSpecialTokens: false)
        try AssistGemmaToolAdapter.validateRenderedContinuationPrompt(continued, call: call, scope: scope)
        // decode may clean punctuation spaces at this tokenizer pin. It is
        // suitable for structural checks, not an encode/decode equality proof.
    }

    private func runGeneration(
        _ request: AssistGenerationRequest, admission: AssistAgentAdmission,
        onProgress: @escaping @Sendable (String) -> Void
    ) async throws -> String {
        defer {
            generationTask = nil
            operationInFlight = false
            phase = cancellationWaiters > 0 ? .cancelling : (engine == nil ? .failed : .ready)
        }
        await AssistDebugDiagnostics.shared.record(category: .engine, stage: .admission, outcome: .completed,
            requestId: request.requestId, metrics: [.messageCount: Double(request.messages.count)])
        guard let engine, let tokenizer else { throw AssistInferenceError.notLoaded }
        guard let agentChatTemplate else {
            throw AssistInferenceError.invalid("Le template local n’est pas qualifié pour la préparation de la réponse.")
        }
        let started = ContinuousClock.now
        let deadline = started.advanced(by: .seconds(180))
        let baseMessages: [Tokenizers.Message] = request.messages.map { ["role": $0.role, "content": $0.content] }
        // Admit the complete original conversation before paying for search.
        // The final prompt is counted again with its frozen selected guide.
        let originalPrompt = try await AssistInferencePreparation.perform(check: { try admission.check() }) {
            try tokenizer.applyChatTemplate(messages: baseMessages,
                chatTemplate: .literal(agentChatTemplate), addGenerationPrompt: true,
                truncation: false, maxLength: nil, tools: [], additionalContext: ["enable_thinking": false])
        }
        _ = try AssistInferencePolicy.outputBudget(promptTokens: originalPrompt.count,
            capacity: capacity, requested: request.maxTokens)
        let thought: AssistThoughtTree.Selection
        do {
            thought = try await prepareThoughtTree(request: request, baseMessages: baseMessages,
                tools: [], scope: .conversation, admission: admission, deadline: deadline,
                chatTemplate: agentChatTemplate)
        } catch let failure as AssistAgentEngineFailure {
            clearResidentIdentity()
            lastError = failure.cause.localizedDescription
            throw failure.cause
        }
        let messages = try AssistThoughtTree.applySelection(thought, to: baseMessages)
        let prompt = try await AssistInferencePreparation.perform(check: { try admission.check() }) {
            try tokenizer.applyChatTemplate(messages: messages,
                chatTemplate: .literal(agentChatTemplate), addGenerationPrompt: true,
                truncation: false, maxLength: nil, tools: [], additionalContext: ["enable_thinking": false])
        }
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
            let decoded = try await Self.consumeGeneration(
                request: request, prompt: prompt, budget: budget, capacity: capacity,
                modelName: modelName, engine: engine, tokenizer: tokenizer,
                stopTokens: stopTokens, started: started, monitor: monitor, onProgress: onProgress,
                deadline: deadline,
                publicSnapshotFilter: { try AssistThoughtTree.shouldEmitPublicSnapshot($0, selection: thought) }
            )
            var result = decoded.result
            result.text = try AssistThoughtTree.publicAnswer(result.text, selection: thought,
                completedEOS: result.finishReason == "eos")
            if result.finishReason == "eos", result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw AssistThoughtTree.Failure.invalidPublicOutput
            }
            await monitor.endGeneration(
                requestId: request.requestId, promptTokens: result.promptTokens,
                generatedTokens: result.generatedTokens, elapsedMs: result.elapsedMs,
                ttftMs: result.ttftMs, finishReason: result.finishReason
            )
            return try AssistJSON.encode(result)
        } catch let policy as AssistThoughtTree.Failure {
            await monitor.transition(phase: "ready", code: "GENERATION_REJECTED", severity: "warning")
            throw policy
        } catch let policy as AssistToolContractError {
            await monitor.transition(phase: "ready", code: "GENERATION_REJECTED", severity: "warning")
            throw policy
        } catch let policy as AssistInferenceError {
            await monitor.transition(phase: "ready", code: "GENERATION_REJECTED", severity: "warning")
            throw policy
        } catch {
            // The one generation task has drained before we discard its resident identity.
            clearResidentIdentity()
            lastError = error.localizedDescription
            throw error
        }
    }

    /// Exactly once per external request, under its existing engine ownership.
    /// There is no broker, service, tool executor or public progress in this phase.
    private func prepareThoughtTree(
        request: AssistGenerationRequest, baseMessages: [Tokenizers.Message],
        tools: [Tokenizers.Message], scope: AssistThoughtTree.Scope,
        admission: AssistAgentAdmission, deadline: ContinuousClock.Instant, chatTemplate: String
    ) async throws -> AssistThoughtTree.Selection {
        guard let engine, let tokenizer else { throw AssistInferenceError.notLoaded }
        let capacity = capacity
        let modelName = modelName
        let monitor = monitor
        let stops = stopTokens.union([Int32(50)])
        let privateRequest = AssistGenerationRequest(requestId: request.requestId,
            messages: request.messages, temperature: 0, maxTokens: nil)
        await monitor.recordThoughtTreeStart(requestId: request.requestId)
        // Ownership was reserved before entering this helper. Observability must
        // never add a suspension between the admission guard and busy latch.
        await AssistDebugDiagnostics.shared.record(category: .context, stage: .context, outcome: .completed,
            requestId: request.requestId, metrics: [.messageCount: Double(baseMessages.count),
                .inputBytes: Double(baseMessages.reduce(0) { $0 + (($1["content"] as? String)?.utf8.count ?? 0) }),
                .contextCapacity: Double(capacity)])
        do {
            let selection = try await AssistThoughtTree.run(baseMessages: baseMessages, tools: tools, scope: scope,
                deadline: deadline, model: { messages, requestedBudget in
                    let preparationPhase: AssistThoughtTree.PreparationPhase =
                        requestedBudget == AssistThoughtTree.rootTokenBudget ? .roots : .leaves
                    try Task.checkCancellation()
                    try admission.check()
                    guard ContinuousClock.now < deadline else {
                        throw AssistThoughtTree.Rejection(phase: preparationPhase, reason: .deadline,
                            cause: AssistThoughtTree.Failure.deadline)
                    }
                    let preparationStarted = ContinuousClock.now
                    await AssistDebugDiagnostics.shared.record(category: .context, stage: .tokenization, outcome: .began,
                        requestId: request.requestId, metrics: [.passIndex: requestedBudget == AssistThoughtTree.rootTokenBudget ? 0 : 1,
                            .messageCount: Double(messages.count)])
                    let prompt: [Int]
                    do {
                        prompt = try await AssistInferencePreparation.perform(check: { try admission.check() }) {
                            let prompt = try tokenizer.applyChatTemplate(messages: messages,
                                chatTemplate: .literal(chatTemplate), addGenerationPrompt: true,
                                truncation: false, maxLength: nil, tools: [], additionalContext: ["enable_thinking": false])
                            guard prompt.allSatisfy({ $0 >= 0 && $0 <= Int(Int32.max) }) else {
                                throw AssistInferenceError.invalid("Jeton de préparation hors de la plage native.")
                            }
                            return prompt
                        }
                    } catch is CancellationError {
                        await AssistDebugDiagnostics.shared.record(category: .context, stage: .tokenization, outcome: .cancelled,
                            requestId: request.requestId, reason: .cancelRequested)
                        throw CancellationError()
                    } catch {
                        await AssistDebugDiagnostics.shared.record(category: .context, stage: .tokenization, outcome: .failed,
                            requestId: request.requestId, reason: .prompt)
                        throw AssistThoughtTree.Rejection(phase: preparationPhase, reason: .prompt, cause: error)
                    }
                    let budget: Int
                    do {
                        budget = try AssistInferencePolicy.outputBudget(promptTokens: prompt.count,
                            capacity: capacity, requested: requestedBudget)
                    } catch {
                        await AssistDebugDiagnostics.shared.record(category: .context, stage: .context, outcome: .rejected,
                            requestId: request.requestId, reason: .budget,
                            metrics: [.promptTokens: Double(prompt.count), .contextCapacity: Double(capacity)])
                        throw AssistThoughtTree.Rejection(phase: preparationPhase, reason: .budget, cause: error)
                    }
                    await AssistDebugDiagnostics.shared.record(category: .context, stage: .tokenization, outcome: .completed,
                        requestId: request.requestId, metrics: [.durationMs: Self.milliseconds(preparationStarted.duration(to: .now)),
                            .promptTokens: Double(prompt.count), .budgetTokens: Double(budget),
                            .contextCapacity: Double(capacity)])
                    // These two fixed suffixes identify only the planning stage,
                    // never its intent, branches, tools, conditions or text.
                    let passID = String(request.requestId.prefix(100))
                        + (requestedBudget == AssistThoughtTree.rootTokenBudget ? ":tree-roots" : ":tree-leaves")
                    let started = ContinuousClock.now
                    await monitor.beginGeneration(requestId: passID, promptTokens: prompt.count,
                        contextCapacity: capacity, elapsedMs: 0)
                    let decoded: AssistDecodedGeneration
                    do {
                        decoded = try await Self.consumeGeneration(request: privateRequest,
                            prompt: prompt, budget: budget, capacity: capacity, modelName: modelName,
                            engine: engine, tokenizer: tokenizer, stopTokens: stops, started: started,
                            monitor: monitor, onProgress: { _ in }, emitPublicProgress: false,
                            deadline: deadline, monitorRequestId: passID)
                    } catch is CancellationError { throw CancellationError() }
                    catch let policy as AssistInferenceError { throw policy }
                    catch { throw AssistAgentEngineFailure(cause: error) }
                    await monitor.endGeneration(requestId: passID, promptTokens: decoded.result.promptTokens,
                        generatedTokens: decoded.result.generatedTokens, elapsedMs: decoded.result.elapsedMs,
                        ttftMs: decoded.result.ttftMs, finishReason: decoded.result.finishReason)
                    await monitor.transition(phase: "generating", code: "PHASE_CHANGED")
                    try Task.checkCancellation()
                    try admission.check()
                    if decoded.result.finishReason == "cancelled" { throw CancellationError() }
                    return AssistThoughtTree.ModelTurn(rawText: decoded.result.text,
                        completedEOS: decoded.result.finishReason == "eos"
                            && [Int32(1), Int32(106)].contains(decoded.stoppedToken ?? -1),
                        stoppedAtToolResponse: decoded.stoppedToken == 50,
                        termination: .observed(finishReason: decoded.result.finishReason, stoppedToken: decoded.stoppedToken))
                }, isCancelled: { admission.isCancelled }, cancelModel: { try? await engine.cancel() })
            await monitor.recordThoughtTreeEnd(requestId: request.requestId, outcome: .ready)
            await AssistDebugDiagnostics.shared.record(category: .planning, stage: .validation, outcome: .completed,
                requestId: request.requestId, metrics: [.itemCount: 2])
            return selection
        } catch is CancellationError {
            await monitor.recordThoughtTreeEnd(requestId: request.requestId, outcome: .cancelled)
            await AssistDebugDiagnostics.shared.record(category: .planning, stage: .cancellation, outcome: .cancelled,
                requestId: request.requestId, reason: .cancelRequested)
            await monitor.transition(phase: "ready", code: "GENERATION_REJECTED", severity: "warning")
            throw CancellationError()
        } catch {
            let rejection = AssistThoughtTree.Rejection.wrapping(error, phase: .unknown)
            let engineFailure = rejection.cause as? AssistAgentEngineFailure
            let reason: AssistThoughtTree.RejectionReason = engineFailure == nil ? rejection.reason : .engine
            await monitor.recordThoughtTreeDiagnostic(requestId: request.requestId,
                phase: rejection.phase.rawValue, reason: reason.rawValue)
            var details: [AssistDebugDiagnostics.Metric: Double] = [:]
            if let value = rejection.validation?.branchIndex { details[.branchIndex] = Double(value) }
            if let value = rejection.validation?.fieldBytes { details[.fieldBytes] = Double(value) }
            if let value = rejection.validation?.limitBytes { details[.limitBytes] = Double(value) }
            if let value = rejection.validation?.itemCount { details[.itemCount] = Double(value) }
            await AssistDebugDiagnostics.shared.record(category: .planning,
                stage: rejection.phase == .roots ? .roots : (rejection.phase == .leaves ? .leaves : .validation),
                outcome: engineFailure == nil ? .rejected : .failed, requestId: request.requestId,
                reason: AssistDebugDiagnostics.Reason(rawValue: rejection.validation?.reason.rawValue ?? reason.rawValue) ?? .unknown,
                field: rejection.validation.flatMap { AssistDebugDiagnostics.Field(rawValue: $0.field.rawValue) }, metrics: details)
            await monitor.recordThoughtTreeEnd(requestId: request.requestId,
                outcome: engineFailure == nil ? .rejected : .error)
            if let engineFailure {
                // Keep the SDK cause and the existing engine-owner cleanup and
                // lastError diagnostics. This is not a policy rejection.
                throw engineFailure
            }
            let publicError = AssistThoughtTree.PreparationError(phase: rejection.phase, reason: reason)
            await monitor.transition(phase: "ready", code: "GENERATION_REJECTED", severity: "warning")
            throw publicError
        }
    }

    /// Apple's output sequence is not Sendable. Create and consume it entirely on
    /// one generic-executor operation, returning only a Sendable result to the actor.
    /// The busy latch excludes all other engine mutations except its thread-safe cancel.
    @concurrent
    private static func consumeGeneration(
        request: AssistGenerationRequest, prompt: [Int], budget: Int, capacity: Int,
        modelName: String?, engine: any InferenceEngine, tokenizer: any Tokenizers.Tokenizer,
        stopTokens: Set<Int32>, started: ContinuousClock.Instant,
        monitor: AssistRuntimeMonitor,
        onProgress: @escaping @Sendable (String) -> Void,
        emitPublicProgress: Bool = true, deadline: ContinuousClock.Instant? = nil,
        monitorRequestId: String? = nil,
        publicSnapshotFilter: (@Sendable (String) throws -> Bool)? = nil
    ) async throws -> AssistDecodedGeneration {
        let operation: @Sendable () async throws -> AssistDecodedGeneration = {
            try await Self.consumeGenerationStream(request: request, prompt: prompt, budget: budget,
                capacity: capacity, modelName: modelName, engine: engine, tokenizer: tokenizer,
                stopTokens: stopTokens, started: started, monitor: monitor, onProgress: onProgress,
                emitPublicProgress: emitPublicProgress, deadline: deadline,
                monitorRequestId: monitorRequestId, publicSnapshotFilter: publicSnapshotFilter)
        }
        if let deadline {
            return try await AssistInferenceDeadline.run(until: deadline, operation: operation,
                cancelOperation: { try? await engine.cancel() },
                acceptCancelledValue: { emitPublicProgress && $0.result.finishReason == "cancelled" })
        }
        return try await operation()
    }

    /// Keep the SDK's non-Sendable sequence on this one executor. The enclosing
    /// deadline owns cancellation and cannot return before this stream drains.
    @concurrent
    private static func consumeGenerationStream(
        request: AssistGenerationRequest, prompt: [Int], budget: Int, capacity: Int,
        modelName: String?, engine: any InferenceEngine, tokenizer: any Tokenizers.Tokenizer,
        stopTokens: Set<Int32>, started: ContinuousClock.Instant,
        monitor: AssistRuntimeMonitor,
        onProgress: @escaping @Sendable (String) -> Void,
        emitPublicProgress: Bool, deadline: ContinuousClock.Instant?,
        monitorRequestId: String?, publicSnapshotFilter: (@Sendable (String) throws -> Bool)?
    ) async throws -> AssistDecodedGeneration {
        let clock = ContinuousClock()
        var generated = AssistOutputBuffer()
        var text = ""
        var ttft: Double?
        var peak = Self.physicalFootprint()
        var finishReason = "length"
        var stoppedToken: Int32?
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
        let monitoringID = monitorRequestId ?? request.requestId
        let debugStage: AssistDebugDiagnostics.Stage = monitorRequestId?.hasSuffix(":tree-roots") == true ? .roots
            : (monitorRequestId?.hasSuffix(":tree-leaves") == true ? .leaves : .generation)
        let debugCategory: AssistDebugDiagnostics.Category = debugStage == .generation ? .engine : .planning
        do {
            try Task.checkCancellation()
            if let deadline, clock.now >= deadline {
                throw AssistInferenceError.invalid("Le budget de temps de la consultation locale est atteint.")
            }
            await AssistDebugDiagnostics.shared.record(category: debugCategory, stage: debugStage, outcome: .began,
                requestId: request.requestId, metrics: [.promptTokens: Double(prompt.count),
                    .budgetTokens: Double(budget), .contextCapacity: Double(capacity)])
            // Recording is an await too: an expired/cancelled operation must
            // not submit compute after that observation resumes.
            try Task.checkCancellation()
            if let deadline, clock.now >= deadline {
                throw AssistInferenceError.invalid("Le budget de temps de la consultation locale est atteint.")
            }
            let stream = try await engine.generate(
                with: prompt.map(Int32.init),
                samplingConfiguration: SamplingConfiguration(temperature: request.temperature),
                inferenceOptions: InferenceOptions(maxTokens: budget, includeLogits: diagnosticsEnabled)
            )
            processedTokensAtGenerationStart = engine.processedTokenCount
            for try await output in stream {
                try Task.checkCancellation()
                if let deadline, clock.now >= deadline {
                    throw AssistInferenceError.invalid("Le budget de temps de la consultation locale est atteint.")
                }
                if diagnosticsEnabled,
                    let step = AssistNumericalDiagnostics.step(
                        index: diagnosticSteps.count, tokenId: Int(output.tokenId), logits: output.logits
                    )
                {
                    diagnosticSteps.append(step)
                }
                if stopTokens.contains(output.tokenId) {
                    stoppedToken = output.tokenId
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
                    if emitPublicProgress, try publicSnapshotFilter?(text) ?? true {
                        onProgress(try AssistJSON.encode(AssistProgress(
                            requestId: request.requestId, text: text, generatedTokens: generated.count,
                            promptTokens: prompt.count, elapsedMs: Self.milliseconds(started.duration(to: clock.now))
                        )))
                    }
                    await monitor.progress(
                        requestId: monitoringID, promptTokens: prompt.count,
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
            do { try await engine.cancel() }
            catch {
                await AssistDebugDiagnostics.shared.record(category: debugCategory, stage: .cancellation, outcome: .failed,
                    requestId: request.requestId, reason: .engine)
                throw error
            }
        } catch {
            try? await engine.cancel()
            let failureReason: AssistDebugDiagnostics.Reason
            if error is AssistInferenceError, let deadline, clock.now >= deadline { failureReason = .deadline }
            else if let policy = error as? AssistThoughtTree.Failure {
                if case .firstActionMismatch = policy { failureReason = .branch }
                else { failureReason = .text }
            } else { failureReason = error is AssistInferenceError ? .unknown : .engine }
            await AssistDebugDiagnostics.shared.record(category: debugCategory, stage: debugStage, outcome: .failed,
                requestId: request.requestId, reason: failureReason,
                metrics: [.durationMs: Self.milliseconds(started.duration(to: clock.now)), .generatedTokens: Double(generated.count)])
            throw error
        }
        // Always emit the final whole-prefix snapshot, including cancellation.
        text = generated.snapshot { tokenizer.decode(tokens: $0) }
        let stopReason: AssistDebugDiagnostics.Reason
        if finishReason == "cancelled" { stopReason = .cancelRequested }
        else {
            switch stoppedToken {
            case 1: stopReason = .eos1
            case 106: stopReason = .turn106
            case 50: stopReason = .tool50
            case .some: stopReason = .otherStop
            case nil: stopReason = .noStop
            }
        }
        await AssistDebugDiagnostics.shared.record(category: debugCategory, stage: debugStage,
            outcome: finishReason == "cancelled" ? .cancelled : .completed,
            requestId: request.requestId, reason: stopReason, field: .protocol,
            metrics: [.durationMs: Self.milliseconds(started.duration(to: clock.now)),
                .promptTokens: Double(prompt.count), .generatedTokens: Double(generated.count),
                .outputBytes: Double(text.utf8.count), .budgetTokens: Double(budget), .contextCapacity: Double(capacity)])
        if finishReason == "length" {
            await AssistDebugDiagnostics.shared.record(category: debugCategory, stage: debugStage, outcome: .rejected,
                requestId: request.requestId, reason: .length, field: .output,
                metrics: [.generatedTokens: Double(generated.count), .budgetTokens: Double(budget)])
        }
        if emitPublicProgress, try publicSnapshotFilter?(text) ?? true {
            onProgress(try AssistJSON.encode(AssistProgress(
                requestId: request.requestId, text: text, generatedTokens: generated.count,
                promptTokens: prompt.count, elapsedMs: Self.milliseconds(started.duration(to: clock.now))
            )))
        }
        return AssistDecodedGeneration(result: AssistGenerationResult(
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
        ), stoppedToken: stoppedToken)
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
        let cancellationStarted = ContinuousClock.now
        await AssistDebugDiagnostics.shared.record(category: .engine, stage: .cancellation, outcome: .began,
            reason: .cancelRequested)
        await monitor.transition(phase: phase.rawValue, code: "CANCELLATION_REQUESTED")
        try await engine?.cancel()
        // Acknowledgement means the operation has stopped, not merely that a flag was set.
        _ = await task.result
        await AssistDebugDiagnostics.shared.record(category: .engine, stage: .cancellation, outcome: .completed,
            metrics: [.durationMs: Self.milliseconds(cancellationStarted.duration(to: .now))])
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
        agentChatTemplate = nil
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
