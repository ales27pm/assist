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
