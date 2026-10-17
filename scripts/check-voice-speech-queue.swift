import AVFoundation
import Dispatch
import Foundation

/// No AVSpeechSynthesizer, audio session, microphone or privacy prompt is used.
@main
struct VoiceSpeechQueueChecks {
    private static func closeEmpty() {
        var queue = AssistVoiceSpeechQueue()
        precondition(!queue.isActive && queue.pendingCount == 0)
        precondition(queue.enqueue() == nil && !queue.finishInput())
        queue.begin(generation: UUID())
        precondition(queue.isActive && queue.pendingCount == 0)
        precondition(queue.finishInput())
        precondition(!queue.isActive && !queue.finishInput() && queue.enqueue() == nil)
        print("PASS: empty input closes once; inactive queues reject new chunks.")
    }

    private static func gapsBetweenChunks() {
        var queue = AssistVoiceSpeechQueue()
        let generation = UUID()
        queue.begin(generation: generation)
        let first = queue.enqueue()!
        precondition(!queue.didFinish(identifier: first, generation: generation))
        precondition(queue.isActive && queue.pendingCount == 0)
        let second = queue.enqueue()!
        precondition(second != first && queue.pendingCount == 1)
        precondition(!queue.didFinish(identifier: second, generation: generation))
        precondition(queue.isActive && queue.pendingCount == 0)
        precondition(queue.finishInput() && !queue.isActive)
        print("PASS: drained gaps between chunks stay active until finishInput.")
    }

    private static func orderedCompletion() {
        var queue = AssistVoiceSpeechQueue()
        let generation = UUID()
        queue.begin(generation: generation)
        let first = queue.enqueue()!
        let second = queue.enqueue()!
        precondition(!queue.finishInput() && queue.isActive && queue.pendingCount == 2)
        precondition(queue.enqueue() == nil)
        precondition(!queue.didFinish(identifier: first, generation: generation))
        precondition(queue.pendingCount == 1)
        precondition(!queue.didFinish(identifier: first, generation: generation))
        precondition(queue.pendingCount == 1)
        precondition(queue.didFinish(identifier: second, generation: generation))
        precondition(!queue.isActive && queue.pendingCount == 0)
        precondition(!queue.didFinish(identifier: second, generation: generation))
        print("PASS: closed input drains in order and ignores duplicate callbacks.")
    }

    private static func outOfOrderCompletion() {
        var queue = AssistVoiceSpeechQueue()
        let generation = UUID()
        queue.begin(generation: generation)
        let identifiers = (0..<3).map { _ in queue.enqueue()! }
        precondition(Set(identifiers).count == 3)
        precondition(!queue.finishInput())
        precondition(!queue.didFinish(identifier: identifiers[2], generation: generation))
        precondition(!queue.didFinish(identifier: UUID(), generation: generation))
        precondition(queue.pendingCount == 2)
        precondition(!queue.didFinish(identifier: identifiers[0], generation: generation))
        precondition(queue.didFinish(identifier: identifiers[1], generation: generation))
        precondition(!queue.isActive && queue.pendingCount == 0)
        print("PASS: out-of-order finishes close only after every known chunk completes.")
    }

    private static func cancelAndReset() {
        var queue = AssistVoiceSpeechQueue()
        let oldGeneration = UUID()
        queue.begin(generation: oldGeneration)
        let oldIdentifier = queue.enqueue()!
        queue.cancel()
        precondition(!queue.isActive && queue.pendingCount == 0)
        precondition(!queue.didFinish(identifier: oldIdentifier, generation: oldGeneration))
        precondition(!queue.finishInput() && queue.enqueue() == nil)

        let newGeneration = UUID()
        queue.begin(generation: newGeneration)
        let newIdentifier = queue.enqueue()!
        precondition(newIdentifier != oldIdentifier)
        precondition(!queue.didFinish(identifier: oldIdentifier, generation: oldGeneration))
        precondition(!queue.didFinish(identifier: newIdentifier, generation: oldGeneration))
        precondition(!queue.didFinish(identifier: oldIdentifier, generation: newGeneration))
        precondition(queue.pendingCount == 1 && queue.isActive)
        precondition(!queue.finishInput())
        precondition(queue.didFinish(identifier: newIdentifier, generation: newGeneration))
        print("PASS: cancel/reset reject stale generation and identifier combinations.")
    }

    private static func beginReplacesPending() {
        var queue = AssistVoiceSpeechQueue()
        let generation = UUID()
        queue.begin(generation: generation)
        let oldIdentifier = queue.enqueue()!
        // Even a caller reusing its generation cannot reuse chunk identity.
        queue.begin(generation: generation)
        let newIdentifier = queue.enqueue()!
        precondition(newIdentifier != oldIdentifier && queue.pendingCount == 1)
        precondition(!queue.didFinish(identifier: oldIdentifier, generation: generation))
        precondition(queue.pendingCount == 1 && !queue.finishInput())
        precondition(queue.didFinish(identifier: newIdentifier, generation: generation))
        print("PASS: begin replaces pending work and old identifiers remain invalid.")
    }

    private static func utteranceMetadataAndCopy() throws {
        let generation = UUID()
        let identifier = UUID()
        let utterance = AssistVoiceUtterance(
            text: "Bonjour, comment ça va?", generation: generation, identifier: identifier
        )
        utterance.rate = 0.4
        utterance.pitchMultiplier = 1.2
        utterance.volume = 0.7
        utterance.prefersAssistiveTechnologySettings = false
        utterance.preUtteranceDelay = 0.15
        utterance.postUtteranceDelay = 0.25
        precondition(utterance.generation == generation && utterance.identifier == identifier)
        precondition(utterance.speechString == "Bonjour, comment ça va?")

        let copy = utterance.copy() as! AssistVoiceUtterance
        precondition(copy !== utterance)
        precondition(copy.generation == generation && copy.identifier == identifier)
        precondition(copy.speechString == utterance.speechString)
        precondition(copy.rate == utterance.rate && copy.pitchMultiplier == utterance.pitchMultiplier)
        precondition(copy.volume == utterance.volume)
        precondition(copy.prefersAssistiveTechnologySettings == utterance.prefersAssistiveTechnologySettings)
        precondition(copy.preUtteranceDelay == utterance.preUtteranceDelay)
        precondition(copy.postUtteranceDelay == utterance.postUtteranceDelay)
        print("PASS: utterance initialization and copying preserve UUID identity and speech settings.")

        let archive = try NSKeyedArchiver.archivedData(withRootObject: utterance, requiringSecureCoding: true)
        let decoded = try NSKeyedUnarchiver.unarchivedObject(ofClass: AssistVoiceUtterance.self, from: archive)!
        precondition(decoded.generation == generation && decoded.identifier == identifier)
        // This exercises the required initializer for our metadata only. The
        // macOS base AVSpeechUtterance itself does not round-trip speechString;
        // production objects are ephemeral and are never persisted this way.
        print("PASS: required secure decoding preserves both identity fields.")
    }

    private static func callbackValueSnapshot() {
        let generation = UUID()
        let identifier = UUID()
        let values = DispatchQueue(label: "AssistVoiceSpeechQueueChecks.callback").sync {
            // Construct and read the non-Sendable object on this queue only.
            let utterance = AssistVoiceUtterance(
                text: "Test", generation: generation, identifier: identifier
            )
            return (utterance.generation, utterance.identifier)
        }
        precondition(values.0 == generation && values.1 == identifier)
        print("PASS: callback boundary returns UUID values without transferring the utterance.")
    }

    static func main() {
        closeEmpty()
        gapsBetweenChunks()
        orderedCompletion()
        outOfOrderCompletion()
        cancelAndReset()
        beginReplacesPending()
        do {
            try utteranceMetadataAndCopy()
        } catch {
            print("FAIL: utterance secure-coding check failed: \(error.localizedDescription)")
            exit(1)
        }
        callbackValueSnapshot()
        print("PASS: 9 native speech queue checks; no speech synthesis or permissions used.")
    }
}
