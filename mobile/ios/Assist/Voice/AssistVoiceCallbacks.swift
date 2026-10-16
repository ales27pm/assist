import AVFoundation
import Foundation
import Speech

/// Framework objects are read on their callback queue; only these values hop
/// into the main-actor conversation coordinator.
struct AssistVoiceRecognitionSnapshot: Sendable, Equatable {
    let text: String?
    let isFinal: Bool
    let message: String?
}

/// Legacy Objective-C callback types do not always carry @Sendable. Forming an
/// unannotated callback in AssistVoice's @MainActor methods makes Swift 6 check
/// that actor at callback entry, before an inner Task can hop to it. Construct
/// explicitly Sendable callbacks here, outside any actor, instead.
enum AssistVoiceCallbacks {
    nonisolated static func authorization(
        _ receive: @escaping @MainActor @Sendable (Bool) -> Void
    ) -> @Sendable (SFSpeechRecognizerAuthorizationStatus) -> Void {
        { authorization in
            let allowed = authorization == .authorized
            Task { @MainActor in receive(allowed) }
        }
    }

    nonisolated static func microphone(
        _ receive: @escaping @MainActor @Sendable (Bool) -> Void
    ) -> @Sendable (Bool) -> Void {
        { allowed in
            Task { @MainActor in receive(allowed) }
        }
    }

    nonisolated static func recognition(
        _ receive: @escaping @MainActor @Sendable (AssistVoiceRecognitionSnapshot) -> Void
    ) -> @Sendable (SFSpeechRecognitionResult?, (any Error)?) -> Void {
        { result, error in
            let snapshot = AssistVoiceRecognitionSnapshot(
                text: result?.bestTranscription.formattedString,
                isFinal: result?.isFinal ?? false,
                message: error?.localizedDescription
            )
            Task { @MainActor in receive(snapshot) }
        }
    }

    nonisolated static func audioTap(
        _ append: @escaping @Sendable (AVAudioPCMBuffer) -> Void
    ) -> @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void {
        // This must remain synchronous: no Task, actor hop, or PCM transfer.
        { buffer, _ in append(buffer) }
    }
}
