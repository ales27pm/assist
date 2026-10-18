import AVFoundation
import Foundation

/// Input lifetime is independent of output. A human interruption invalidates
/// every old playback callback while preserving the request's input token.
struct AssistVoiceDuplexLifetime: Sendable {
    private(set) var recognition = UUID()
    private(set) var playback = UUID()
    private(set) var retained = false

    mutating func reset() {
        recognition = UUID()
        playback = UUID()
        retained = false
    }
    mutating func rearmRecognition() { recognition = UUID() }
    mutating func retirePlayback(retainingInput: Bool = false) {
        playback = UUID()
        retained = retainingInput
    }
    mutating func adoptInput() -> Bool {
        guard retained else { return false }
        retained = false
        return true
    }
    static func containsSpeechText(_ text: String?) -> Bool {
        guard let text else { return false }
        return text.rangeOfCharacter(from: .letters.union(.decimalDigits)) != nil
    }
}

/// Synthesis completion is not speaker completion. The owner additionally
/// closes the generation's text input before publishing its natural idle.
struct AssistVoicePlaybackDrain: Sendable {
    static let maximumQueuedFrames = 48_000 * 15
    private(set) var utterance: UUID?
    private(set) var productionEnded = false
    private(set) var queuedFrames = 0
    private var buffers: [UUID: Int] = [:]
    var isComplete: Bool { utterance != nil && productionEnded && buffers.isEmpty }

    mutating func begin(_ identifier: UUID) {
        cancel()
        utterance = identifier
    }
    mutating func schedule(_ identifier: UUID, frames: Int) -> Bool {
        guard utterance != nil, !productionEnded, frames > 0,
              buffers[identifier] == nil,
              frames <= Self.maximumQueuedFrames - queuedFrames else { return false }
        buffers[identifier] = frames
        queuedFrames += frames
        return true
    }
    mutating func finishProduction() { productionEnded = true }
    mutating func didPlay(_ identifier: UUID) -> Bool {
        guard let frames = buffers.removeValue(forKey: identifier) else { return false }
        queuedFrames -= frames
        return isComplete
    }
    mutating func cancel() {
        utterance = nil
        productionEnded = false
        queuedFrames = 0
        buffers.removeAll(keepingCapacity: true)
    }
}

/// Empty recognizer completions spaced over a long answer may rearm normally.
/// A rapid failure loop backs off and stops, and the response has a finite
/// total retry budget. Fatal authorization/device errors never enter this path.
struct AssistVoiceMonitorRetry: Sendable {
    private var attempts: [Double] = []
    private var total = 0
    private var lastTime: Double = 0

    mutating func reserve(now: Double) -> Double? {
        guard now.isFinite, now >= lastTime, total < 32 else { return nil }
        lastTime = now
        attempts.removeAll { now - $0 >= 5 }
        guard attempts.count < 3 else { return nil }
        let delay = Double(attempts.count) * 0.25
        attempts.append(now)
        total += 1
        return delay
    }
}

/// Hardware identifiers participate only in private equality. Diagnostics expose
/// port types separately; this type deliberately has no serialization contract.
struct AssistVoiceRouteIdentity: Sendable, Equatable {
    struct Port: Sendable, Equatable {
        let type: String
        private let uid: String
        init(type: String, uid: String) { self.type = type; self.uid = uid }
        fileprivate var sortKey: String { type + "\u{0}" + uid }
    }
    private let inputs: [Port]
    private let outputs: [Port]
    init(inputs: [Port], outputs: [Port]) {
        self.inputs = inputs.sorted { $0.sortKey < $1.sortKey }
        self.outputs = outputs.sorted { $0.sortKey < $1.sortKey }
    }
    var hasInputAndOutput: Bool { !inputs.isEmpty && !outputs.isEmpty }
    var diagnosticTypes: String {
        func types(_ ports: [Port]) -> String {
            ports.map { String($0.type.filter { $0.isLetter || $0.isNumber }.prefix(32)) }.joined(separator: ",")
        }
        return types(inputs) + "/" + types(outputs)
    }
}

struct AssistVoiceRouteFormat: Sendable, Equatable {
    let rate: Double
    let channels: Int
    let commonFormat: UInt
    let interleaved: Bool
    var isValid: Bool { rate.isFinite && rate > 0 && channels > 0 && commonFormat != 0 }
    var diagnosticFormat: String { "\(rate)/\(channels)/c\(commonFormat)/i\(interleaved ? 1 : 0)" }
}

struct AssistVoiceRouteBaseline: Sendable, Equatable {
    let route: AssistVoiceRouteIdentity
    let input: AssistVoiceRouteFormat
    let output: AssistVoiceRouteFormat
    let player: AssistVoiceRouteFormat
}

/// Evidence from this generation's own setCategory/setActive operation.
/// A delayed category notification may describe its pre-activation route, even
/// though the committed graph already uses the operation's observed target.
struct AssistVoiceOwnedCategoryTransition: Sendable {
    let previous: [AssistVoiceRouteIdentity]
    let target: AssistVoiceRouteIdentity
    func contains(previous route: AssistVoiceRouteIdentity, current: AssistVoiceRouteIdentity) -> Bool {
        target == current && previous.contains(route)
    }
}

/// Reason values are Apple's stable AVAudioSession.RouteChangeReason raw values.
/// No route reason alone is evidence that an existing graph remains usable.
enum AssistVoiceRouteDecision: String, Sendable {
    case accept, deferUntilCommit, fail
}

struct AssistVoiceRouteFacts: Sendable {
    let reason: UInt?
    let previous: AssistVoiceRouteIdentity?
    let current: AssistVoiceRouteIdentity
    let baseline: AssistVoiceRouteBaseline?
    let ownedCategoryTransition: AssistVoiceOwnedCategoryTransition?
    let input: AssistVoiceRouteFormat
    let output: AssistVoiceRouteFormat
    let player: AssistVoiceRouteFormat
    let tapInput: AssistVoiceRouteFormat?
    let appActive: Bool
    let sessionActive: Bool
    let expectedSessionConfiguration: Bool
    let constructing: Bool
    let engineRunning: Bool
    let inputVoiceProcessing: Bool
    let outputVoiceProcessing: Bool

    var samePorts: Bool {
        baseline?.route == current
    }

    private var previousIsExpected: Bool {
        guard let previous else { return true }
        return previous == current || (reason == 3 &&
            ownedCategoryTransition?.contains(previous: previous, current: current) == true)
    }

    /// The decision and diagnostics consume these exact predicates in this
    /// order. Startup construction defers only checks requiring a committed graph.
    var rejectionCauses: [String] {
        var causes: [String] = []
        if reason != 8 && reason != 3 { causes.append("reason") }
        if !appActive { causes.append("app") }
        if !sessionActive { causes.append("session") }
        if !expectedSessionConfiguration { causes.append("config") }
        if !current.hasInputAndOutput { causes.append("route") }
        if constructing { return causes }
        if baseline == nil { causes.append("baseline") }
        if !samePorts { causes.append("ports") }
        if !previousIsExpected { causes.append("previous") }
        if !engineRunning { causes.append("run") }
        if !inputVoiceProcessing { causes.append("vpIn") }
        if !outputVoiceProcessing { causes.append("vpOut") }
        if !input.isValid { causes.append("inInvalid") }
        if !output.isValid { causes.append("outInvalid") }
        if !player.isValid { causes.append("playerInvalid") }
        if player.rate != 48_000 || player.channels != 1 ||
            player.commonFormat != AVAudioCommonFormat.pcmFormatFloat32.rawValue || player.interleaved {
            causes.append("playerPCM")
        }
        if input != output { causes.append("ioMismatch") }
        if input != tapInput { causes.append("tapMismatch") }
        if let baseline {
            if input != baseline.input { causes.append("inChanged") }
            if output != baseline.output { causes.append("outChanged") }
            if player != baseline.player { causes.append("playerChanged") }
        }
        return causes
    }

    var decision: AssistVoiceRouteDecision {
        guard rejectionCauses.isEmpty else { return .fail }
        return constructing ? .deferUntilCommit : .accept
    }

    func diagnosticLines(source: String, phase: String, decision: String, frames: Int) -> [String] {
        let causes = rejectionCauses
        let reason = (source == "route" || source == "interruption") ? self.reason.map(String.init) ?? "none" : "none"
        let first = "causes=\(causes.isEmpty ? "none" : causes.joined(separator: ",")) source=\(source) reason=\(reason) phase=\(phase) app=\(appActive ? 1 : 0) session=\(sessionActive ? 1 : 0) config=\(expectedSessionConfiguration ? 1 : 0) base=\(baseline != nil ? 1 : 0) same=\(samePorts ? 1 : 0) run=\(engineRunning ? 1 : 0) vp=\(inputVoiceProcessing ? 1 : 0)/\(outputVoiceProcessing ? 1 : 0) pcm=\(frames) decision=\(decision)"
        let second = "formats in=\(input.diagnosticFormat) tap=\(tapInput?.diagnosticFormat ?? "none") out=\(output.diagnosticFormat) player=\(player.diagnosticFormat) ports=\(current.diagnosticTypes) previous=\(previous?.diagnosticTypes ?? "none")"
        return [first, second]
    }

}

struct AssistVoiceAudioDiagnostics: Sendable {
    private(set) var lines: [String] = []
    mutating func append(_ line: String) {
        lines.append(String(line.replacingOccurrences(of: "\n", with: " ").prefix(400)))
        if lines.count > 8 { lines.removeFirst(lines.count - 8) }
    }
}

/// Model initialization can fail before a microphone or route exists. Keep a
/// bounded cause chain without error descriptions, URLs or reference content.
struct AssistFluidLoadFailure: Error, LocalizedError, Sendable {
    enum Stage: String, Sendable {
        case pocket, parakeet, silero, session
        var label: String {
            switch self {
            case .pocket: return "PocketTTS français"
            case .parakeet: return "Parakeet"
            case .silero: return "Silero"
            case .session: return "la voix Estelle"
            }
        }
    }
    let stage: Stage
    let diagnosticLine: String
    init(stage: Stage, error: Error) {
        self.stage = stage
        diagnosticLine = Self.formattedDiagnostic(error: error, stage: stage)
    }

    /// The synthesis consumer keeps its generic user-facing message while
    /// exposing only a bounded, redacted native error chain in audio details.
    static func synthesisDiagnostic(error: Error) -> String {
        formattedDiagnostic(error: error, stage: nil)
    }

    private static func formattedDiagnostic(error: Error, stage: Stage?) -> String {
        var chain: [String] = []
        var current: NSError? = error as NSError
        var modelContext = ""
        for _ in 0..<3 {
            guard let value = current else { break }
            // SDK metadata is a fixed local component name and compute route,
            // never a path or a framework's arbitrary error description.
            if stage == .pocket, value.domain == "FluidAudio.PocketModelLoad",
               let component = value.userInfo["PocketTtsComponent"] as? String,
               ["cond_prefill.mlmodelc", "flowlm_stepv2.mlmodelc", "flow_decoder_fused.mlmodelc", "mimi_decoder.mlmodelc"].contains(component),
               let units = value.userInfo["PocketTtsComputeUnits"] as? String,
               ["all", "cpuAndGPU", "cpuOnly", "cpuAndNeuralEngine"].contains(units) {
                let retried = value.userInfo["PocketTtsRetried"] as? Bool == true ? 1 : 0
                modelContext = " model=\(component) units=\(units) retried=\(retried)"
            }
            if stage == .parakeet, value.domain == "FluidAudio.ParakeetModelLoad",
               let component = value.userInfo["ParakeetComponent"] as? String,
               ["Preprocessor.mlmodelc", "Encoder.mlmodelc", "Encoder_v2.mlmodelc", "EncoderInt4.mlmodelc",
                "Decoder.mlmodelc", "JointDecision.mlmodelc", "JointDecisionv3.mlmodelc", "CtcHead.mlmodelc",
                "Decoderv2.mlmodelc", "Jointerv2.mlmodelc"].contains(component),
               let units = value.userInfo["ParakeetComputeUnits"] as? String,
               ["all", "cpuAndGPU", "cpuOnly", "cpuAndNeuralEngine"].contains(units) {
                modelContext = " model=\(component) units=\(units)"
            }
            // An SDK prefix alone is insufficient: an arbitrary domain can
            // contain a private name even when it contains only ASCII letters.
            let known = [
                "com.apple.CoreML", "NSCocoaErrorDomain", "NSPOSIXErrorDomain", "NSOSStatusErrorDomain",
                "AVFoundationErrorDomain", "com.apple.coreaudio.avfaudio", "Assist.Voice", "Assist.Voice.PCM",
                "FluidAudio.PocketModelLoad", "FluidAudio.ParakeetModelLoad", "FluidAudio.PocketTTSError",
                "FluidAudio.ASRError", "FluidAudio.AsrModelsError", "FluidAudio.VadError", "FluidAudio.ModelTensorContract",
            ]
            let domain = known.contains(value.domain) ? value.domain : "other"
            chain.append("\(domain):\(value.code)")
            current = value.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        let prefix = stage.map { "load stage=\($0.rawValue)" } ?? "synthesis"
        return String("\(prefix)\(modelContext) cause=\(chain.joined(separator: " > "))".prefix(400))
    }
    var errorDescription: String? {
        "Impossible de charger \(stage.label). Consulte les détails audio ci-dessous; les ressources importées sont conservées."
    }
}

/// Every accepted notice replaces the observation, including when PCM advanced
/// between two notices. An older timer cannot validate a newer configuration.
struct AssistVoiceRouteProgressWatch: Sendable {
    private(set) var identifier: UUID?
    private var initialFrames = 0
    mutating func begin(frameCount: Int) -> UUID {
        let identifier = UUID()
        self.identifier = identifier
        initialFrames = frameCount
        return identifier
    }
    func progressed(identifier: UUID, frameCount: Int) -> Bool? {
        guard self.identifier == identifier else { return nil }
        return frameCount > initialFrames
    }
    mutating func cancel() { identifier = nil }
}

/// Relinquish ownership before any AVFoundation teardown call can notify us
/// synchronously. The returned value permits exactly one system deactivation.
struct AssistVoiceAudioSessionOwnership: Sendable {
    private(set) var isActive = false
    mutating func acquire() { isActive = true }
    mutating func relinquish() -> Bool {
        let wasActive = isActive
        isActive = false
        return wasActive
    }
}

/// Production wiring shared with offline format/conversion checks. The client
/// format, rather than the hardware output format, is common to VPIO input/output.
@MainActor
enum AssistVoiceIOWiring {
    static func connectOutput(engine: AVAudioEngine, mixer: AVAudioMixerNode, format: AVAudioFormat) throws {
        guard !engine.isRunning, format.sampleRate.isFinite, format.sampleRate > 0,
              format.channelCount > 0, format.commonFormat != .otherFormat else {
            throw NSError(domain: "Assist.Voice.IOFormat", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Le format PCM client du graphe vocal est invalide ou le moteur est déjà actif."])
        }
        engine.connect(mixer, to: engine.outputNode, format: format)
    }
}
