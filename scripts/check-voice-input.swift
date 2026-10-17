import AVFoundation
import Dispatch
import Foundation

/// Synthetic buffers only: this executable never opens an audio engine, asks
/// for permissions, recognizes speech, records audio, or writes sample data.
@main
struct VoiceInputChecks {
    private static func floatBuffer(
        channels: AVAudioChannelCount = 1,
        frames: AVAudioFrameCount,
        capacity: AVAudioFrameCount? = nil,
        interleaved: Bool = false,
        sampleRate: Double = 48_000
    ) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: channels,
            interleaved: interleaved
        )!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity ?? frames)!
        buffer.frameLength = frames
        for channel in 0..<Int(channels) {
            for frame in 0..<Int(buffer.frameCapacity) {
                buffer.floatChannelData![channel][frame * buffer.stride] = 0
            }
        }
        return buffer
    }

    private static func assertLevels(_ snapshot: AssistVoiceInputSnapshot) {
        precondition(snapshot.recentPeak.isFinite && (0...1).contains(snapshot.recentPeak))
        precondition(snapshot.peak.isFinite && (0...1).contains(snapshot.peak))
    }

    private static func emptyAndSilence() {
        let meter = AssistVoiceInputMeter()
        precondition(meter.snapshot() == AssistVoiceInputSnapshot(
            bufferCount: 0, frameCount: 0, sampleRate: 0, channelCount: 0,
            measuredSampleCount: 0, unsupportedBufferCount: 0,
            recentPeak: 0, peak: 0, firstBufferDelayMs: nil
        ))
        let buffer = floatBuffer(frames: 128)
        meter.observe(buffer)
        let snapshot = meter.snapshot()
        precondition(snapshot.bufferCount == 1 && snapshot.frameCount == 128)
        precondition(snapshot.sampleRate == 48_000 && snapshot.channelCount == 1)
        precondition(snapshot.measuredSampleCount == 128 && snapshot.unsupportedBufferCount == 0)
        precondition(snapshot.recentPeak == 0 && snapshot.peak == 0)
        precondition(snapshot.firstBufferDelayMs != nil && snapshot.firstBufferDelayMs! >= 0)
        print("PASS: empty input differs from measured silence; first buffer metadata is available.")
    }

    private static func signalAndCapacity() {
        let meter = AssistVoiceInputMeter()
        let buffer = floatBuffer(frames: 64, capacity: 256, sampleRate: 16_000)
        buffer.floatChannelData![0][63] = -0.625
        // An unused capacity tail must not affect the measured level.
        for frame in 64..<256 { buffer.floatChannelData![0][frame] = 1 }
        meter.observe(buffer)
        let first = meter.snapshot()
        precondition(first.recentPeak == 0.625 && first.peak == 0.625)
        precondition(first.frameCount == 64 && first.measuredSampleCount == 64)
        let quiet = floatBuffer(frames: 32, sampleRate: 48_000)
        meter.observe(quiet)
        let final = meter.snapshot()
        precondition(final.bufferCount == 2 && final.frameCount == 96)
        precondition(final.measuredSampleCount == 96)
        precondition(final.recentPeak == 0 && final.peak == 0.625)
        precondition(final.sampleRate == 16_000 && final.channelCount == 1)
        precondition(final.firstBufferDelayMs == first.firstBufferDelayMs)
        print("PASS: signal, recent/global peaks, frameLength, and first-format metadata stay distinct.")
    }

    private static func stereoAndStride() {
        for interleaved in [false, true] {
            let meter = AssistVoiceInputMeter()
            let buffer = floatBuffer(channels: 2, frames: 32, interleaved: interleaved)
            precondition(buffer.stride == (interleaved ? 2 : 1))
            buffer.floatChannelData![1][31 * buffer.stride] = -0.875
            meter.observe(buffer)
            let snapshot = meter.snapshot()
            precondition(snapshot.channelCount == 2 && snapshot.frameCount == 32)
            precondition(snapshot.measuredSampleCount == 64)
            precondition(snapshot.recentPeak == 0.875 && snapshot.peak == 0.875)
        }
        print("PASS: right-channel signal is detected in planar and interleaved Float32 PCM.")
    }

    private static func integerFormats() {
        for interleaved in [false, true] {
            for commonFormat in [AVAudioCommonFormat.pcmFormatInt16, .pcmFormatInt32] {
                let format = AVAudioFormat(
                    commonFormat: commonFormat,
                    sampleRate: 44_100,
                    channels: 2,
                    interleaved: interleaved
                )!
                let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 64)!
                buffer.frameLength = 16
                let meter = AssistVoiceInputMeter()
                if commonFormat == .pcmFormatInt16 {
                    for channel in 0..<2 {
                        for frame in 0..<64 {
                            buffer.int16ChannelData![channel][frame * buffer.stride] = 0
                        }
                    }
                    buffer.int16ChannelData![1][15 * buffer.stride] = Int16.min
                } else {
                    for channel in 0..<2 {
                        for frame in 0..<64 {
                            buffer.int32ChannelData![channel][frame * buffer.stride] = 0
                        }
                    }
                    buffer.int32ChannelData![1][15 * buffer.stride] = Int32.min
                }
                meter.observe(buffer)
                let snapshot = meter.snapshot()
                precondition(snapshot.recentPeak == 1 && snapshot.peak == 1)
                precondition(snapshot.measuredSampleCount == 32 && snapshot.frameCount == 16)
                precondition(snapshot.unsupportedBufferCount == 0)
                assertLevels(snapshot)
            }
        }
        print("PASS: planar/interleaved Int16 and Int32 normalize minimum values without overflow.")
    }

    private static func nonfiniteAndClipping() {
        let meter = AssistVoiceInputMeter()
        let buffer = floatBuffer(frames: 6)
        let values: [Float] = [.nan, .infinity, -.infinity, -4, 0.25, 0]
        for index in values.indices { buffer.floatChannelData![0][index] = values[index] }
        meter.observe(buffer)
        let first = meter.snapshot()
        precondition(first.measuredSampleCount == 3 && first.recentPeak == 1 && first.peak == 1)
        for index in values.indices { buffer.floatChannelData![0][index] = .nan }
        meter.observe(buffer)
        let final = meter.snapshot()
        precondition(final.measuredSampleCount == 3 && final.unsupportedBufferCount == 0)
        precondition(final.recentPeak == 1 && final.peak == 1)
        assertLevels(final)
        print("PASS: NaN/infinity are ignored, finite overrange levels are bounded, no false silence.")
    }

    private static func boundedScan() {
        let meter = AssistVoiceInputMeter()
        let buffer = floatBuffer(channels: 2, frames: 8_192)
        buffer.floatChannelData![1][8_191] = 0.75
        meter.observe(buffer)
        let snapshot = meter.snapshot()
        precondition(snapshot.frameCount == 8_192 && snapshot.measuredSampleCount == 2_048)
        precondition(snapshot.recentPeak == 0.75)
        print("PASS: scan is bounded to 1,024 positions per channel and includes the last valid frame.")
    }

    private static func unsupportedFormat() {
        let meter = AssistVoiceInputMeter()
        let signal = floatBuffer(frames: 8)
        signal.floatChannelData![0][0] = 0.5
        meter.observe(signal)
        let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat64, sampleRate: 48_000, channels: 1, interleaved: false
        )!
        let unsupported = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16)!
        unsupported.frameLength = 16
        meter.observe(unsupported)
        let snapshot = meter.snapshot()
        precondition(snapshot.bufferCount == 2 && snapshot.frameCount == 24)
        precondition(snapshot.unsupportedBufferCount == 1 && snapshot.measuredSampleCount == 8)
        precondition(snapshot.recentPeak == 0.5 && snapshot.peak == 0.5)
        unsupported.frameLength = 0
        meter.observe(unsupported)
        let emptyUnsupported = meter.snapshot()
        precondition(emptyUnsupported.bufferCount == 3 && emptyUnsupported.frameCount == 24)
        precondition(emptyUnsupported.unsupportedBufferCount == 2)
        precondition(emptyUnsupported.measuredSampleCount == 8 && emptyUnsupported.recentPeak == 0.5)
        print("PASS: unsupported Float64 buffers count as unmeasured input and preserve measured levels.")
    }

    private static func concurrentReaders() {
        let meter = AssistVoiceInputMeter()
        let observations = 10_000
        DispatchQueue.concurrentPerform(iterations: 4) { worker in
            if worker == 0 {
                // The buffer is created, mutated and measured on this producer
                // only. Reader workers receive the Sendable meter, never PCM.
                let buffer = floatBuffer(frames: 32)
                for index in 0..<observations {
                    buffer.floatChannelData![0][0] = Float(index % 4) / 4
                    meter.observe(buffer)
                }
            } else {
                var previousBuffers = 0
                var previousFrames = 0
                var previousSamples = 0
                for _ in 0..<observations {
                    let snapshot = meter.snapshot()
                    precondition(snapshot.bufferCount >= previousBuffers)
                    precondition(snapshot.frameCount >= previousFrames)
                    precondition(snapshot.measuredSampleCount >= previousSamples)
                    assertLevels(snapshot)
                    previousBuffers = snapshot.bufferCount
                    previousFrames = snapshot.frameCount
                    previousSamples = snapshot.measuredSampleCount
                    // Cross-field equality is intentionally checked only after
                    // the producer has stopped: a live snapshot is not a lock.
                }
            }
        }
        let final = meter.snapshot()
        precondition(final.bufferCount == observations)
        precondition(final.frameCount == observations * 32)
        precondition(final.measuredSampleCount == observations * 32)
        precondition(final.unsupportedBufferCount == 0)
        precondition(final.recentPeak == 0.75 && final.peak == 0.75)
        print("PASS: one producer and three concurrent readers settle to exact final counters.")
    }

    static func main() {
        DispatchQueue.global().asyncAfter(deadline: .now() + 30) {
            print("FAIL: voice input checks timed out.")
            exit(90)
        }
        emptyAndSilence()
        signalAndCapacity()
        stereoAndStride()
        integerFormats()
        nonfiniteAndClipping()
        boundedScan()
        unsupportedFormat()
        concurrentReaders()
        print("PASS: 8 native voice input checks; no audio capture or privacy permissions used.")
    }
}
