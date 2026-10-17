import AVFoundation
import Foundation

/// Value state owned by the main-actor voice coordinator. A temporary gap
/// between chunks is not completion: only closed input with no pending chunks
/// finishes a generation. UUIDs remain independent of NSObject address reuse.
struct AssistVoiceSpeechQueue: Sendable {
    private var generation: UUID?
    private var inputClosed = false
    private var pending: Set<UUID> = []

    var pendingCount: Int { pending.count }
    var isActive: Bool { generation != nil }

    mutating func begin(generation: UUID) {
        self.generation = generation
        inputClosed = false
        pending.removeAll(keepingCapacity: true)
    }

    mutating func enqueue() -> UUID? {
        guard isActive, !inputClosed else { return nil }
        let identifier = UUID()
        pending.insert(identifier)
        return identifier
    }

    /// Returns true exactly when this call closes a fully drained generation.
    mutating func finishInput() -> Bool {
        guard isActive else { return false }
        inputClosed = true
        return closeIfDrained()
    }

    /// Stale generations, unknown identifiers and duplicate callbacks do not
    /// mutate the active queue or complete the current response.
    mutating func didFinish(identifier: UUID, generation: UUID) -> Bool {
        guard self.generation == generation,
              pending.remove(identifier) != nil else { return false }
        return closeIfDrained()
    }

    mutating func cancel() {
        generation = nil
        inputClosed = false
        pending.removeAll(keepingCapacity: true)
    }

    private mutating func closeIfDrained() -> Bool {
        guard inputClosed, pending.isEmpty else { return false }
        cancel()
        return true
    }
}

/// AVSpeechUtterance itself stays non-Sendable. A delegate may read these two
/// immutable value fields on its callback queue, then pass only the UUIDs to
/// MainActor. Never transfer this NSObject in a Task or an actor message.
/// Utterances are ephemeral; their superclass's coding behavior is not a
/// persistence contract for speech text or settings.
final class AssistVoiceUtterance: AVSpeechUtterance {
    nonisolated let generation: UUID
    nonisolated let identifier: UUID

    override class var supportsSecureCoding: Bool { true }

    private static let generationKey = "AssistVoiceUtterance.generation"
    private static let identifierKey = "AssistVoiceUtterance.identifier"

    init(text: String, generation: UUID, identifier: UUID) {
        self.generation = generation
        self.identifier = identifier
        super.init(string: text)
    }

    required init?(coder: NSCoder) {
        guard let generation = coder.decodeObject(of: NSUUID.self, forKey: Self.generationKey) as UUID?,
              let identifier = coder.decodeObject(of: NSUUID.self, forKey: Self.identifierKey) as UUID?
        else { return nil }
        self.generation = generation
        self.identifier = identifier
        super.init(coder: coder)
    }

    override func encode(with coder: NSCoder) {
        super.encode(with: coder)
        coder.encode(generation as NSUUID, forKey: Self.generationKey)
        coder.encode(identifier as NSUUID, forKey: Self.identifierKey)
    }

    /// Preserve callback identity if a framework/client copies the utterance.
    /// This type accepts plain text only; copy all its public speech settings.
    override func copy(with zone: NSZone? = nil) -> Any {
        let result = AssistVoiceUtterance(
            text: speechString, generation: generation, identifier: identifier
        )
        result.voice = voice
        result.rate = rate
        result.pitchMultiplier = pitchMultiplier
        result.volume = volume
        result.prefersAssistiveTechnologySettings = prefersAssistiveTechnologySettings
        result.preUtteranceDelay = preUtteranceDelay
        result.postUtteranceDelay = postUtteranceDelay
        return result
    }
}
