import AVFoundation
import Dispatch
import Foundation
import Synchronization

@MainActor
private final class PlaybackProbe {
    var lifetime = AssistVoiceDuplexLifetime()
    var drain = AssistVoicePlaybackDrain()
    var completions = 0
    let releases = Atomic<Int>(0)
}

@main
struct VoiceDuplexChecks {
    private static func buffer(_ format: AVAudioCommonFormat, frames: Int, channels: Int = 1, interleaved: Bool = false, rate: Double = 22_050) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(commonFormat: format, sampleRate: rate, channels: AVAudioChannelCount(channels), interleaved: interleaved)!
        let result = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
        result.frameLength = AVAudioFrameCount(frames)
        let list = UnsafeMutableAudioBufferListPointer(result.mutableAudioBufferList)
        for entry in list where entry.mDataByteSize > 0 { memset(entry.mData!, 0, Int(entry.mDataByteSize)) }
        return result
    }

    @MainActor
    private static func identitiesAndDrain() {
        var lifetime = AssistVoiceDuplexLifetime()
        let input = lifetime.recognition
        let output = lifetime.playback
        lifetime.retirePlayback()
        precondition(lifetime.recognition == input && lifetime.playback != output)
        lifetime.retirePlayback(retainingInput: true)
        precondition(lifetime.adoptInput() && !lifetime.adoptInput())
        precondition(lifetime.recognition == input)
        lifetime.reset()
        precondition(lifetime.recognition != input && !lifetime.retained)
        precondition(!AssistVoiceDuplexLifetime.containsSpeechText(" … "))
        precondition(AssistVoiceDuplexLifetime.containsSpeechText("Non, arrête!"))
        var drain = AssistVoicePlaybackDrain()
        drain.begin(UUID())
        let first = UUID(), second = UUID()
        precondition(drain.schedule(first, frames: 512) && drain.schedule(second, frames: 256))
        precondition(!drain.didPlay(first) && !drain.isComplete)
        drain.finishProduction()
        precondition(!drain.isComplete && drain.didPlay(second))
        precondition(!drain.didPlay(second))
        drain.cancel()
        precondition(!drain.didPlay(first) && !drain.isComplete)
        print("PASS: handoff preserves input token, retires output, and completion waits for production plus playback.")
    }

    @MainActor
    private static func longChunkSequence() {
        var queue = AssistVoiceSpeechQueue()
        var drain = AssistVoicePlaybackDrain()
        let generation = UUID()
        queue.begin(generation: generation)
        let identifiers = (0..<64).map { _ in queue.enqueue()! }
        precondition(!queue.finishInput())
        for (index, identifier) in identifiers.enumerated() {
            drain.begin(identifier)
            let packets = (0..<128).map { _ in UUID() }
            for packet in packets { precondition(drain.schedule(packet, frames: 1_024)) }
            drain.finishProduction()
            precondition(!drain.isComplete)
            for packet in packets { _ = drain.didPlay(packet) }
            precondition(drain.isComplete && drain.queuedFrames == 0)
            precondition(queue.didFinish(identifier: identifier, generation: generation) == (index == identifiers.count - 1))
        }
        precondition(!queue.isActive)
        drain.begin(UUID())
        precondition(!drain.schedule(UUID(), frames: AssistVoicePlaybackDrain.maximumQueuedFrames + 1))
        print("PASS: 64 rapidly produced chunks drain independently; total response length cannot fill the PCM budget.")
    }

    @MainActor
    private static func playbackCallbackAfterStop() async {
        let probe = PlaybackProbe()
        let token = probe.lifetime.playback
        let callback = AssistVoiceCallbacks.playback(release: {
            _ = probe.releases.wrappingAdd(1, ordering: .relaxed)
        }) {
            MainActor.assertIsolated()
            if probe.lifetime.playback == token { probe.completions += 1 }
        }
        probe.lifetime.retirePlayback()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().async {
                callback(.dataPlayedBack)
                callback(.dataPlayedBack)
                Task { @MainActor in continuation.resume() }
            }
        }
        precondition(probe.completions == 0 && probe.releases.load(ordering: .relaxed) == 1)
        print("PASS: explicit Sendable playback callback runs off MainActor; duplicate callbacks after stop cannot complete old audio.")
    }

    @MainActor
    private static func actualStoppedPlayer() async {
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        engine.connect(player, to: engine.mainMixerNode, format: format)
        let samples = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 128)!
        samples.frameLength = 128
        samples.floatChannelData![0].initialize(repeating: 0, count: 128)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            player.scheduleBuffer(samples, completionCallbackType: .dataPlayedBack) { _ in continuation.resume() }
            player.stop()
        }
        print("PASS: actual AVAudioPlayerNode.stop releases a scheduled dataPlayedBack callback without starting hardware.")
    }

    @MainActor
    private static func formats() async throws {
        for common in [AVAudioCommonFormat.pcmFormatFloat32, .pcmFormatInt16, .pcmFormatInt32] {
            for interleaved in [false, true] {
                let messages: [AssistVoicePCMMessage] = await withCheckedContinuation { continuation in
                    var received: [AssistVoicePCMMessage] = []
                    let transfer = AssistVoicePCMTransfer { message in
                        received.append(message)
                        if received.count == 2 { continuation.resume(returning: received) }
                    }
                    let callback = transfer.callback()
                    DispatchQueue.global().async {
                        let pcm = buffer(common, frames: 256, channels: 2, interleaved: interleaved)
                        let list = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
                        let entry = list[interleaved ? 0 : 1]
                        let index = interleaved ? 1 : 0
                        switch common {
                        case .pcmFormatFloat32: entry.mData!.assumingMemoryBound(to: Float.self)[index] = 0.5
                        case .pcmFormatInt16: entry.mData!.assumingMemoryBound(to: Int16.self)[index] = 16_384
                        default: entry.mData!.assumingMemoryBound(to: Int32.self)[index] = 1_073_741_824
                        }
                        callback(pcm)
                        callback(buffer(common, frames: 0))
                    }
                }
                let sorted = messages.sorted { ($0.sequence ?? -1) < ($1.sequence ?? -1) }
                guard case .samples(let sequence, let values, let rate, _) = sorted[0] else { preconditionFailure() }
                precondition(sequence == 0 && values.count == 256 && values[0] == 0.25 && rate == 22_050)
                let converter = AssistVoicePCMConverter()
                let converted = try converter.convert(values, sampleRate: rate)
                let tail = try converter.finish()
                precondition(converted?.format.sampleRate == 48_000)
                let total = Int(converted?.frameLength ?? 0) + tail.reduce(0) { $0 + Int($1.frameLength) }
                precondition(abs(total - Int(256.0 * 48_000 / rate)) < 160)
            }
        }
        print("PASS: planar/interleaved stereo Float32/Int16/Int32 fold safely and convert to 48 kHz mono.")
    }

    @MainActor
    private static func finePacketBudget() async {
        let count = 1_300 // ~15 seconds of 256-frame source callbacks at 22.05 kHz.
        let observed = await withCheckedContinuation { continuation in
            var samples = 0
            var failures = 0
            var ended = false
            let transfer = AssistVoicePCMTransfer { message in
                switch message {
                case .samples: samples += 1
                case .failure: failures += 1
                case .end: ended = true
                }
                if ended && samples + failures == count { continuation.resume(returning: (samples, failures)) }
            }
            let callback = transfer.callback()
            DispatchQueue.global().async {
                let pcm = buffer(.pcmFormatFloat32, frames: 256)
                for _ in 0..<count { callback(pcm) }
                callback(buffer(.pcmFormatFloat32, frames: 0))
            }
        }
        precondition(observed.0 == count && observed.1 == 0)
        print("PASS: 1,300 fine-grained callbacks fit the bounded transfer without false saturation.")
    }

    @MainActor
    private static func monitorRetries() {
        var rapid = AssistVoiceMonitorRetry()
        precondition(rapid.reserve(now: 1) == 0)
        precondition(rapid.reserve(now: 1.1) == 0.25)
        precondition(rapid.reserve(now: 1.2) == 0.5)
        precondition(rapid.reserve(now: 1.3) == nil)
        var slow = AssistVoiceMonitorRetry()
        for index in 0..<16 { precondition(slow.reserve(now: Double(index) * 10) == 0) }
        precondition(slow.reserve(now: 149) == nil) // reject a backwards clock value
        print("PASS: rapid monitor failure loops back off and stop; legitimate empty cycles beyond 60 seconds remain bounded.")
    }

    @MainActor
    private static func terminalOrdering() async {
        let messages: [AssistVoicePCMMessage] = await withCheckedContinuation { continuation in
            var received: [AssistVoicePCMMessage] = []
            let transfer = AssistVoicePCMTransfer { message in
                received.append(message)
                if received.count == 33 { continuation.resume(returning: received) }
            }
            let callback = transfer.callback()
            DispatchQueue.global().async {
                // Simulated synth delegate completion does not close PCM. The
                // bridge deliberately exposes no delegate-driven finish API.
                let group = DispatchGroup()
                for _ in 0..<32 {
                    group.enter()
                    DispatchQueue.global().async {
                        callback(buffer(.pcmFormatFloat32, frames: 64))
                        group.leave()
                    }
                }
                group.wait()
                callback(buffer(.pcmFormatFloat32, frames: 0))
            }
        }
        let ordered = messages.sorted { ($0.sequence ?? -1) < ($1.sequence ?? -1) }
        precondition(ordered.compactMap(\.sequence) == Array(0...32))
        guard case .end(sequence: 32) = ordered.last! else { preconditionFailure() }
        print("PASS: concurrent accepted PCM packets precede terminal ordinal; delegate completion cannot truncate them.")
    }

    @MainActor
    private static func converterDraining() throws {
        for rate in [8_000.0, 16_000, 22_050, 24_000, 44_100, 48_000, 96_000] {
            let converter = AssistVoicePCMConverter()
            var total = 0
            let count = 24
            for _ in 0..<count {
                let pcm = try converter.convert([Float](repeating: 0.1, count: 1_024), sampleRate: rate)
                total += Int(pcm?.frameLength ?? 0)
            }
            total += try converter.finish().reduce(0) { $0 + Int($1.frameLength) }
            let expected = Int(Double(count * 1_024) * 48_000 / rate)
            precondition(abs(total - expected) < 160)
        }
        print("PASS: multi-packet resampling at 8–96 kHz drains to endOfStream within its finite tail budget.")
    }

    @MainActor
    private static func unsupportedAndBounded() async {
        for common in [AVAudioCommonFormat.pcmFormatFloat64, .pcmFormatFloat32] {
            let failed = await withCheckedContinuation { continuation in
                let transfer = AssistVoicePCMTransfer { message in
                    if case .failure = message { continuation.resume(returning: true) }
                }
                let callback = transfer.callback()
                DispatchQueue.global().async {
                    let pcm = buffer(common, frames: common == .pcmFormatFloat64 ? 32 : 65_536)
                    for _ in 0..<20 { callback(pcm) }
                }
            }
            precondition(failed)
        }
        print("PASS: unsupported formats and over-budget production fail once instead of retaining unbounded PCM.")
    }

    @MainActor
    static func main() async throws {
        DispatchQueue.global().asyncAfter(deadline: .now() + 30) { exit(90) }
        identitiesAndDrain()
        longChunkSequence()
        await playbackCallbackAfterStop()
        await actualStoppedPlayer()
        try await formats()
        await finePacketBudget()
        monitorRetries()
        await terminalOrdering()
        try converterDraining()
        await unsupportedAndBounded()
        print("PASS: 10 native duplex checks; no engine start, microphone, speech recognition or real TTS.")
    }
}
