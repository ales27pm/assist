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
    var isValid: Bool { rate.isFinite && rate > 0 && channels > 0 }
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

    var decision: AssistVoiceRouteDecision {
        // Configuration (8), or our requested category (3); never swallow
        // unknown, hardware addition/removal, override, or no-suitable-route.
        guard reason == 8 || reason == 3,
              appActive, sessionActive, expectedSessionConfiguration,
              current.hasInputAndOutput else { return .fail }
        if constructing { return .deferUntilCommit }
        guard let baseline, samePorts, previousIsExpected, engineRunning,
              inputVoiceProcessing, outputVoiceProcessing,
              input.isValid, output.isValid, player.isValid,
              input == baseline.input, output == baseline.output,
              player == baseline.player, input == tapInput else { return .fail }
        return .accept
    }
}

struct AssistVoiceAudioDiagnostics: Sendable {
    private(set) var lines: [String] = []
    mutating func append(_ line: String) {
        lines.append(String(line.replacingOccurrences(of: "\n", with: " ").prefix(400)))
        if lines.count > 8 { lines.removeFirst(lines.count - 8) }
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
