import AVFoundation
import Dispatch
import Synchronization

/// Aggregate diagnostics only. No audio samples or transcript are retained.
struct AssistVoiceInputSnapshot: Sendable, Equatable {
    let bufferCount: Int
    let frameCount: Int
    let sampleRate: Double
    let channelCount: Int
    let measuredSampleCount: Int
    let unsupportedBufferCount: Int
    let recentPeak: Float
    let peak: Float
    let firstBufferDelayMs: Double?
}

/// One audio-tap producer, any number of snapshot readers. Every field is
/// atomic, but a live snapshot can span two observations. Stop/remove the tap
/// before taking the final snapshot to obtain complete, settled counters.
///
/// Levels are normalized to 0...1 and describe a bounded sample of each buffer,
/// not a guaranteed peak of every PCM frame. At most 1,024 positions per channel
/// are inspected, spread over frameLength; unused capacity is never inspected.
/// Unsupported buffers and nonfinite samples are never counted as measured
/// silence. recentPeak changes only when a buffer has a finite measured sample.
final class AssistVoiceInputMeter: Sendable {
    private let startedAtNanoseconds: UInt64
    private let buffers = Atomic<Int>(0)
    private let frames = Atomic<Int>(0)
    private let sampleRateBits = Atomic<UInt64>(0)
    private let channels = Atomic<Int>(0)
    private let measuredSamples = Atomic<Int>(0)
    private let unsupportedBuffers = Atomic<Int>(0)
    private let recentPeakBits = Atomic<UInt32>(0)
    private let peakBits = Atomic<UInt32>(0)
    private let firstBufferDelayNanoseconds = Atomic<UInt64>(UInt64.max)

    nonisolated init() {
        startedAtNanoseconds = DispatchTime.now().uptimeNanoseconds
    }

    /// Call synchronously from the sole tap producer. This method does not
    /// create tasks, take locks, retain PCM, perform I/O, or log per buffer.
    nonisolated func observe(_ buffer: AVAudioPCMBuffer) {
        let oldBufferCount = buffers.load(ordering: .relaxed)
        if oldBufferCount == 0 {
            let now = DispatchTime.now().uptimeNanoseconds
            sampleRateBits.store(buffer.format.sampleRate.bitPattern, ordering: .relaxed)
            channels.store(Int(buffer.format.channelCount), ordering: .relaxed)
            firstBufferDelayNanoseconds.store(
                now >= startedAtNanoseconds ? now - startedAtNanoseconds : 0,
                ordering: .relaxed
            )
        }

        let frameLength = Int(buffer.frameLength)
        frames.store(
            Self.addingWithoutOverflow(frames.load(ordering: .relaxed), frameLength),
            ordering: .relaxed
        )

        let channelCount = Int(buffer.format.channelCount)
        let stride = buffer.stride
        let measurement: (count: Int, peak: Float)?

        switch buffer.format.commonFormat {
        case .pcmFormatFloat32:
            measurement = buffer.floatChannelData.map {
                Self.measure($0, channels: channelCount, frames: frameLength, stride: stride) {
                    $0
                }
            }
        case .pcmFormatInt16:
            measurement = buffer.int16ChannelData.map {
                Self.measure($0, channels: channelCount, frames: frameLength, stride: stride) {
                    Float($0) / 32_768
                }
            }
        case .pcmFormatInt32:
            measurement = buffer.int32ChannelData.map {
                Self.measure($0, channels: channelCount, frames: frameLength, stride: stride) {
                    Float($0) / 2_147_483_648
                }
            }
        default:
            measurement = nil
        }

        if let measurement {
            measuredSamples.store(
                Self.addingWithoutOverflow(
                    measuredSamples.load(ordering: .relaxed), measurement.count
                ),
                ordering: .relaxed
            )
            if measurement.count > 0 {
                recentPeakBits.store(measurement.peak.bitPattern, ordering: .relaxed)
                let previousPeak = Float(bitPattern: peakBits.load(ordering: .relaxed))
                peakBits.store(max(previousPeak, measurement.peak).bitPattern, ordering: .relaxed)
            }
        } else {
            unsupportedBuffers.store(
                Self.addingWithoutOverflow(unsupportedBuffers.load(ordering: .relaxed), 1),
                ordering: .relaxed
            )
        }

        // Publish initialization and this observation after the other stores.
        // There is exactly one writer, so no read/modify/write retry is needed.
        buffers.store(Self.addingWithoutOverflow(oldBufferCount, 1), ordering: .releasing)
    }

    nonisolated func snapshot() -> AssistVoiceInputSnapshot {
        let bufferCount = buffers.load(ordering: .acquiring)
        let delay = firstBufferDelayNanoseconds.load(ordering: .relaxed)
        return AssistVoiceInputSnapshot(
            bufferCount: bufferCount,
            frameCount: frames.load(ordering: .relaxed),
            sampleRate: Double(bitPattern: sampleRateBits.load(ordering: .relaxed)),
            channelCount: channels.load(ordering: .relaxed),
            measuredSampleCount: measuredSamples.load(ordering: .relaxed),
            unsupportedBufferCount: unsupportedBuffers.load(ordering: .relaxed),
            recentPeak: Float(bitPattern: recentPeakBits.load(ordering: .relaxed)),
            peak: Float(bitPattern: peakBits.load(ordering: .relaxed)),
            firstBufferDelayMs: delay == UInt64.max ? nil : Double(delay) / 1_000_000
        )
    }

    @inline(__always)
    private nonisolated static func addingWithoutOverflow(_ count: Int, _ increment: Int) -> Int {
        count > Int.max - increment ? Int.max : count + increment
    }

    @inline(__always)
    private nonisolated static func measure<Sample>(
        _ data: UnsafePointer<UnsafeMutablePointer<Sample>>,
        channels: Int,
        frames: Int,
        stride: Int,
        normalized: (Sample) -> Float
    ) -> (count: Int, peak: Float) {
        guard channels > 0, frames > 0, stride > 0 else { return (0, 0) }
        let positions = min(frames, 1_024)
        var count = 0
        var peak: Float = 0
        for channel in 0..<channels {
            let samples = data[channel]
            for position in 0..<positions {
                let frame = positions == 1 ? 0 : position * (frames - 1) / (positions - 1)
                let value = normalized(samples[frame * stride])
                guard value.isFinite else { continue }
                count += 1
                peak = max(peak, min(abs(value), 1))
            }
        }
        return (count, peak)
    }
}
