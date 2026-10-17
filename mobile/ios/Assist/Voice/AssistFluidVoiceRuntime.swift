import AVFoundation
@preconcurrency import CoreML
import FluidAudio
import Foundation

// BEGIN PURE FLUID CAPTURE POLICY
/// Bounded actual 16 kHz audio, including pre-onset context. This is shared by
/// the production inference loop and the no-microphone regression harness.
struct AssistFluidCaptureWindow {
    static let maximumSamples = 45 * 16_000
    private(set) var speechStarted = false
    private(set) var samples: [Float] = []
    private var preRoll: [Float] = []
    private var positiveWindows = 0
    private var lastDecodeSamples = 0
    private var monitoring: Bool

    init(monitoring: Bool = false) { self.monitoring = monitoring }

    mutating func append(_ chunk: [Float], probability: Float) throws -> Bool {
        guard !chunk.isEmpty, chunk.count <= 4_096, probability.isFinite else { throw Failure.invalidAudio }
        if speechStarted || !monitoring {
            // A capture already belongs to the user: never evict a short word
            // while waiting for EOT merely because VAD has not qualified it.
            guard samples.count <= Self.maximumSamples - chunk.count else { throw Failure.tooLong }
            samples.append(contentsOf: chunk)
            if speechStarted { return false }
            positiveWindows = probability >= 0.85 ? positiveWindows + 1 : 0
            guard positiveWindows >= 2 else { return false }
            speechStarted = true
            return true
        }
        preRoll.append(contentsOf: chunk)
        if preRoll.count > 16_384 { preRoll.removeFirst(preRoll.count - 16_384) }
        positiveWindows = probability >= 0.85 ? positiveWindows + 1 : 0
        guard positiveWindows >= 2 else { return false }
        speechStarted = true
        samples = preRoll
        preRoll.removeAll(keepingCapacity: false)
        return true
    }
    /// The input worker calls this between complete append operations. Keep
    /// the onset, resampler/VAD tail and any already-qualified utterance; only
    /// remove the stricter policy used while the assistant was speaking.
    mutating func adoptCapture() {
        guard monitoring else { return }
        monitoring = false
        if !speechStarted { samples = preRoll }
        preRoll.removeAll(keepingCapacity: false)
    }
    mutating func reservePartial() -> Bool {
        guard (speechStarted || !monitoring), samples.count - lastDecodeSamples >= 16_000 else { return false }
        lastDecodeSamples = samples.count
        return true
    }
    mutating func finish(tail: [Float]) throws {
        guard tail.count < 4_096 else { throw Failure.invalidAudio }
        if !speechStarted && monitoring { samples = preRoll }
        guard samples.count <= Self.maximumSamples - tail.count else { throw Failure.tooLong }
        samples.append(contentsOf: tail)
    }
    enum Failure: Error, LocalizedError {
        case tooLong, invalidAudio
        var errorDescription: String? {
            switch self {
            case .tooLong: return "Cette prise de parole dépasse 45 secondes. Reprends avec une phrase plus courte."
            case .invalidAudio: return "Le format audio reçu par la dictée locale est invalide."
            }
        }
    }
}
/// A single latest replacement snapshot. A final request cannot be demoted by
/// an older partial, and clearing the mailbox releases its bounded PCM copy.
struct AssistFluidDecodeMailbox {
    struct Snapshot { let samples: [Float]; let final: Bool }
    private var pending: Snapshot?
    private var inFlight = false
    mutating func replace(samples: [Float], final: Bool) {
        guard pending?.final != true else { return }
        pending = Snapshot(samples: samples, final: final)
    }
    mutating func take() -> Snapshot? {
        guard !inFlight, let result = pending else { return nil }
        pending = nil
        inFlight = true
        return result
    }
    mutating func complete() { inFlight = false }
    mutating func cancel() { pending = nil; inFlight = false }
}
// END PURE FLUID CAPTURE POLICY

/// Only values cross from model actors to the main-owned audio coordinator.
enum AssistFluidVoiceEvent: Sendable {
    case onset
    case transcript(String, final: Bool)
    case failure(String)
}

/// One input lifetime owns one runtime. All assets are explicitly local;
/// neither ModelHub nor a download-capable convenience initializer is used.
/// Parakeet receives cumulative snapshots (not delta text) with a fresh decoder:
/// at most one prediction and one replacement snapshot can be outstanding.
actor AssistFluidVoiceRuntime: AssistFluidInputProcessor {
    private let pocket: PocketTtsManager
    private let asr: AsrManager
    private let vad: VadManager
    private var receive: @MainActor @Sendable (AssistFluidVoiceEvent) -> Void
    private var resampler: AssistFluidInputResampler?
    private var vadState = VadStreamState.initial()
    private var vadPending: [Float] = []
    private var capture = AssistFluidCaptureWindow()
    private var decodeMailbox = AssistFluidDecodeMailbox()
    private var decodeTask: Task<Void, Never>?
    private var identity = UUID()
    private var active = true
    private var finishing = false
    private var speechSession: PocketTtsSession?

    init(configuration: AssistAdvancedVoiceConfiguration, monitoring: Bool,
         progress: @escaping @MainActor @Sendable (AssistFluidLoadFailure.Stage, String?) -> Void,
         receive: @escaping @MainActor @Sendable (AssistFluidVoiceEvent) -> Void) async throws {
        self.receive = receive
        self.capture = AssistFluidCaptureWindow(monitoring: monitoring)
        // SDK configuration is protected by its Mutex. Disable transcript/info
        // diagnostics and console mirroring before any model actor is created.
        AppLogger.minimumLevel = .warning
        AppLogger.mirrorsToConsole = false
        var stage = AssistFluidLoadFailure.Stage.pocket
        do {
            try Task.checkCancellation()
            await progress(stage, nil)
            try Task.checkCancellation()
            let pocket = PocketTtsManager(defaultVoice: AssistAdvancedVoiceConfiguration.presetVoice, language: .french24L,
                                        offlineDirectory: configuration.pocketDirectory, precision: .int8, placement: .gpu)
            try await pocket.initialize(progress: { attempt in
                let retry = attempt.retry ? " · reprise CPU/GPU" : ""
                await progress(.pocket, "\(attempt.component) · \(attempt.computeUnits)\(retry)")
            })
            try Task.checkCancellation()
            self.pocket = pocket
            stage = .parakeet
            await progress(stage, nil)
            try Task.checkCancellation()
            let version: AsrModelVersion = configuration.variant == "redux" ? .redux : .ultra
            let models = try AsrModels.loadLocal(from: configuration.asrDirectory, version: version)
            try Task.checkCancellation()
            asr = AsrManager(models: models)
            stage = .silero
            await progress(stage, nil)
            try Task.checkCancellation()
            let config = MLModelConfiguration()
            config.computeUnits = .cpuOnly
            let vadModel = try await MLModel.load(contentsOf: configuration.vadModelURL, configuration: config)
            try Task.checkCancellation()
            vad = VadManager(config: VadConfig(defaultThreshold: 0.85, computeUnits: .cpuOnly), vadModel: vadModel)
            try Task.checkCancellation()
        } catch {
            if error is CancellationError || Task.isCancelled { throw CancellationError() }
            throw AssistFluidLoadFailure(stage: stage, error: error)
        }
    }

    /// Reuse the loaded models across automatic turns. Every per-capture state
    /// and callback identity is reset only after the previous worker has stopped.
    func resetCapture(monitoring: Bool, receive: @escaping @MainActor @Sendable (AssistFluidVoiceEvent) -> Void) async {
        await cancel()
        self.receive = receive
        resampler = nil
        vadState = .initial()
        vadPending.removeAll()
        capture = AssistFluidCaptureWindow(monitoring: monitoring)
        finishing = false
        identity = UUID()
        active = true
    }

    func makeSpeechSession() async throws -> PocketTtsSession {
        guard active else { throw CancellationError() }
        let token = identity
        do {
            let session = try await pocket.makeSession(voice: AssistAdvancedVoiceConfiguration.presetVoice)
            guard active, identity == token, !Task.isCancelled else {
                await session.cancel(); throw CancellationError()
            }
            do {
                try await session.configurePlaybackBackpressure(maximumFrames: 150)
            } catch {
                await session.cancel()
                throw error
            }
            guard active, identity == token, !Task.isCancelled else {
                await session.cancel(); throw CancellationError()
            }
            speechSession = session
            return session
        } catch {
            if error is CancellationError || Task.isCancelled { throw CancellationError() }
            throw AssistFluidLoadFailure(stage: .session, error: error)
        }
    }

    func cancelSpeech() async {
        let session = speechSession
        speechSession = nil
        await session?.cancel()
    }

    /// Serialized by the same worker that drains microphone PCM. No reset,
    /// decoder replacement or actor suspension may lose the retained onset.
    func adoptCapture() -> Bool {
        guard active, !finishing else { return false }
        capture.adoptCapture()
        if capture.reservePartial() { enqueueDecode(final: false) }
        return true
    }

    /// Called by the single ring-draining worker, never by the audio callback.
    func append(_ samples: [Float], sampleRate: Double) async {
        guard active, !finishing else { return }
        let token = identity
        do {
            if resampler == nil { resampler = try AssistFluidInputResampler(sampleRate: sampleRate) }
            let audio = try resampler!.convert(samples)
            guard active, token == identity else { return }
            try await process(audio, token: token)
        } catch {
            if active, token == identity {
                let message = (error as? AssistFluidCaptureWindow.Failure)?.localizedDescription ?? "Le traitement local du microphone a échoué."
                await report(.failure(message))
            }
        }
    }

    private func process(_ audio: [Float], token: UUID) async throws {
        vadPending.append(contentsOf: audio)
        while vadPending.count >= 4_096 {
            let chunk = Array(vadPending.prefix(4_096))
            vadPending.removeFirst(4_096)
            let result = try await vad.processStreamingChunk(chunk, state: vadState)
            guard active, token == identity else { return }
            vadState = result.state
            if try capture.append(chunk, probability: result.probability) {
                await report(.onset)
                guard active, token == identity else { return }
            }
            if capture.reservePartial() { enqueueDecode(final: false) }
        }
    }

    /// Tap is already removed. Process every queued sample before final decode.
    func finishInput() async {
        guard active, !finishing else { return }
        finishing = true
        let token = identity
        do {
            if let resampler { try await process(resampler.finish(), token: token) }
            guard active, token == identity else { return }
            // A short utterance may not fill two VAD windows. Final STT
            // still receives its original audio, never a padded VAD buffer.
            try capture.finish(tail: vadPending)
            vadPending.removeAll(keepingCapacity: false)
            enqueueDecode(final: true)
        } catch {
            if active, token == identity { await report(.failure("La finalisation de la dictée locale a échoué.")) }
        }
    }

    private func enqueueDecode(final: Bool) {
        guard active else { return }
        decodeMailbox.replace(samples: capture.samples, final: final)
        guard decodeTask == nil else { return }
        launchDecode()
    }
    private func launchDecode() {
        guard decodeTask == nil, let pending = decodeMailbox.take() else { return }
        let token = identity
        let asr = asr
        decodeTask = Task { [weak self] in
            do {
                try Task.checkCancellation()
                var state = try TdtDecoderState()
                let result = pending.samples.isEmpty ? nil : try await asr.transcribe(pending.samples, decoderState: &state, language: .french)
                await self?.decoded(result?.text ?? "", final: pending.final, token: token)
            } catch {
                await self?.decodeFailed(token: token)
            }
        }
    }
    private func decoded(_ text: String, final: Bool, token: UUID) async {
        guard active, token == identity else { return }
        decodeTask = nil
        decodeMailbox.complete()
        // Never publish a superseded partial after finalization was requested.
        if final || !finishing { await report(.transcript(text, final: final)) }
        guard active, token == identity else { return }
        if final { decodeMailbox.cancel() }
        else { launchDecode() }
    }
    private func decodeFailed(token: UUID) async {
        guard active, token == identity else { return }
        decodeTask = nil
        decodeMailbox.cancel()
        await report(.failure("La reconnaissance Parakeet locale a échoué. Ton texte est conservé."))
    }
    private func report(_ event: AssistFluidVoiceEvent) async { await receive(event) }

    /// Coordinator has already muted output and removed the tap. Waiting here
    /// releases in-flight Core ML work before another runtime is loaded.
    func cancel() async {
        active = false
        identity = UUID()
        decodeMailbox.cancel()
        let decode = decodeTask
        decodeTask = nil
        decode?.cancel()
        await cancelSpeech()
        await decode?.value
        capture = AssistFluidCaptureWindow()
        vadPending.removeAll()
        resampler = nil
    }
}
