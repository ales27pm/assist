import AVFoundation
import Dispatch
import Foundation
import Speech

/// A fake legacy API boundary used only by the expected-crash child process.
/// Its immutable callback deliberately lacks @Sendable, like the older SDK
/// callbacks that inferred MainActor isolation at their creation site. This is
/// intentionally unsafe and must never be used by the successful checks or app.
private final class LegacyAuthorizationCallback: @unchecked Sendable {
    private let receive: (SFSpeechRecognizerAuthorizationStatus) -> Void

    init(_ receive: @escaping (SFSpeechRecognizerAuthorizationStatus) -> Void) {
        self.receive = receive
    }

    func invoke() { receive(.authorized) }
}

/// The audio negative control preserves the legacy non-Sendable tap signature.
/// Like the authorization holder, it is confined to an expected-crash child.
private final class LegacyAudioCallback: @unchecked Sendable {
    private let receive: (AVAudioPCMBuffer, AVAudioTime) -> Void

    init(_ receive: @escaping (AVAudioPCMBuffer, AVAudioTime) -> Void) {
        self.receive = receive
    }

    func invoke() {
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 32)!
        buffer.frameLength = 32
        receive(buffer, AVAudioTime(sampleTime: 0, atRate: 16_000))
    }
}

/// The old audio closure captured only a Sendable sink, yet its legacy callback
/// type could still infer MainActor isolation from the closure's creation site.
private struct LegacySendableAudioSink: Sendable {
    func append(_ buffer: AVAudioPCMBuffer) {
        precondition(buffer.frameLength == 32)
        print("FAIL: the legacy tap unexpectedly entered its Sendable sink.")
        exit(0)
    }
}

@MainActor
private final class LegacyVoiceReceiver {
    var received = false
}

/// Only the named serial queue may access the mutable fields after init. The
/// checked continuation returns a value snapshot, never a buffer or this probe.
/// This narrow unchecked wrapper can be removed when the SDK supplies a
/// Sendable audio-buffer contract and a checked queue-confined test container.
private final class AudioTapProbe: @unchecked Sendable {
    private let queue: DispatchQueue
    private let marker = DispatchSpecificKey<UInt8>()
    private var currentBuffer: AVAudioPCMBuffer?
    private var beforeCount = 0
    private var frameOrder: [AVAudioFrameCount] = []

    init(queue: DispatchQueue) {
        self.queue = queue
        queue.setSpecific(key: marker, value: 1)
    }

    private func checkQueue() {
        dispatchPrecondition(condition: .onQueue(queue))
        precondition(DispatchQueue.getSpecific(key: marker) == 1,
                     "The audio append must stay on the original tap queue.")
    }

    func begin(_ buffer: AVAudioPCMBuffer) {
        checkQueue()
        currentBuffer = buffer
        beforeCount = frameOrder.count
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        checkQueue()
        precondition(currentBuffer === buffer,
                     "The tap must append the exact callback buffer synchronously.")
        precondition(buffer.floatChannelData![0][0] == Float(buffer.frameLength),
                     "The callback buffer contents must be available during append.")
        frameOrder.append(buffer.frameLength)
    }

    func end() {
        checkQueue()
        precondition(frameOrder.count == beforeCount + 1,
                     "The audio append must finish before the callback returns.")
        currentBuffer = nil
    }

    func snapshot() -> [AVAudioFrameCount] {
        checkQueue()
        return frameOrder
    }
}

@main
struct VoiceCallbackChecks {
    private static func watchdog() {
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
            print("FAIL: voice callback checks timed out.")
            exit(90)
        }
    }

    @MainActor
    private static func authorization(rawValue: Int, expected: Bool) async {
        let actual = await withCheckedContinuation { continuation in
            // Form the factory on MainActor, exactly as the app owner does.
            let callback = AssistVoiceCallbacks.authorization { allowed in
                MainActor.assertIsolated()
                continuation.resume(returning: allowed)
            }
            DispatchQueue.global().async {
                dispatchPrecondition(condition: .notOnQueue(.main))
                callback(SFSpeechRecognizerAuthorizationStatus(rawValue: rawValue)!)
            }
        }
        precondition(actual == expected, "Speech authorization mapping changed.")
    }

    @MainActor
    private static func microphone(expected: Bool) async {
        let actual = await withCheckedContinuation { continuation in
            let callback = AssistVoiceCallbacks.microphone { allowed in
                MainActor.assertIsolated()
                continuation.resume(returning: allowed)
            }
            DispatchQueue.global().async {
                dispatchPrecondition(condition: .notOnQueue(.main))
                callback(expected)
            }
        }
        precondition(actual == expected, "Microphone permission mapping changed.")
    }

    @MainActor
    private static func recognition(withError: Bool) async {
        let actual = await withCheckedContinuation { continuation in
            let callback = AssistVoiceCallbacks.recognition { snapshot in
                MainActor.assertIsolated()
                continuation.resume(returning: snapshot)
            }
            DispatchQueue.global().async {
                dispatchPrecondition(condition: .notOnQueue(.main))
                // Framework objects are created and read on the callback queue.
                // No real recognizer, request, privacy prompt or microphone runs.
                let error: NSError? = withError
                    ? NSError(domain: "AssistVoiceCallbackChecks", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "Synthetic recognition failure."])
                    : nil
                callback(nil, error)
            }
        }
        let expected = AssistVoiceRecognitionSnapshot(
            text: nil,
            isFinal: false,
            message: withError ? "Synthetic recognition failure." : nil
        )
        precondition(actual == expected,
                     "Recognition callbacks must preserve a Sendable result/error snapshot.")
    }

    @MainActor
    private static func audioTap() async {
        let queue = DispatchQueue(label: "AssistVoiceCallbackChecks.audio")
        let probe = AudioTapProbe(queue: queue)
        let callback = AssistVoiceCallbacks.audioTap { buffer in probe.append(buffer) }
        let expected = (1...128).map { AVAudioFrameCount($0 * 16) }
        let actual = await withCheckedContinuation { continuation in
            queue.async {
                dispatchPrecondition(condition: .notOnQueue(.main))
                let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
                var sampleTime: AVAudioFramePosition = 0
                for frameCount in expected {
                    // Buffers and timestamps remain on the tap queue throughout.
                    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)!
                    buffer.frameLength = frameCount
                    buffer.floatChannelData![0][0] = Float(frameCount)
                    let time = AVAudioTime(sampleTime: sampleTime, atRate: 16_000)
                    probe.begin(buffer)
                    callback(buffer, time)
                    probe.end()
                    sampleTime += AVAudioFramePosition(frameCount)
                }
                continuation.resume(returning: probe.snapshot())
            }
        }
        precondition(actual == expected, "Audio frames must append once and in callback order.")
    }

    @MainActor
    private static func negativeAuthorization() async throws {
        let receiver = LegacyVoiceReceiver()
        let legacy = LegacyAuthorizationCallback { authorization in
            let allowed = authorization == .authorized
            // Match the original defect: the outer callback only prepares a
            // value and hops to MainActor. Its inferred entry check traps before
            // this inner Task can make the hop. No explicit actor assertion.
            Task { @MainActor in
                receiver.received = allowed
                print("FAIL: the legacy authorization unexpectedly reached its MainActor task.")
                exit(0)
            }
        }
        DispatchQueue.global().async { legacy.invoke() }
        try await Task.sleep(for: .seconds(20))
    }

    @MainActor
    private static func negativeAudioTap() async throws {
        let sink = LegacySendableAudioSink()
        // There is no actor-owned state in this closure, only a Sendable sink.
        // Its non-Sendable contextual type still inherits the creation actor.
        let legacy = LegacyAudioCallback { [sink] buffer, _ in sink.append(buffer) }
        DispatchQueue.global().async { legacy.invoke() }
        try await Task.sleep(for: .seconds(20))
    }

    @MainActor
    static func main() async throws {
        watchdog()
        if CommandLine.arguments.contains("--negative-authorization") {
            try await negativeAuthorization()
            return
        }
        if CommandLine.arguments.contains("--negative-audio-tap") {
            try await negativeAudioTap()
            return
        }
        await authorization(rawValue: SFSpeechRecognizerAuthorizationStatus.authorized.rawValue, expected: true)
        await authorization(rawValue: SFSpeechRecognizerAuthorizationStatus.denied.rawValue, expected: false)
        await authorization(rawValue: SFSpeechRecognizerAuthorizationStatus.restricted.rawValue, expected: false)
        await authorization(rawValue: SFSpeechRecognizerAuthorizationStatus.notDetermined.rawValue, expected: false)
        await microphone(expected: true)
        await microphone(expected: false)
        await recognition(withError: false)
        await recognition(withError: true)
        await audioTap()
        print("PASS: 9 native voice callback checks; MainActor receivers and 128 synchronous ordered audio frames.")
    }
}
