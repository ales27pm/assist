import AVFoundation
import Foundation
import Synchronization

/// Single tap producer / single worker consumer. The fixed allocation is owned
/// for the entire tap lifetime. Acquire/release cursors prevent either side
/// touching a slot still owned by the other; no lock, allocation, Task or ML
/// work occurs in append(). A saturated ring fails the session, never drops
/// speech silently. The owner removes the tap before releasing this object.
final class AssistFluidAudioInput: @unchecked Sendable {
    static let capacity = 131_072
    let sampleRate: Double
    private let channels: Int
    private let samples: UnsafeMutablePointer<Float>
    private let written = Atomic<UInt64>(0)
    private let consumed = Atomic<UInt64>(0)
    private let open = Atomic<Bool>(true)
    private let failed = Atomic<Bool>(false)
    // Main requests adoption; only the single PCM worker consumes this marker.
    // Unlike an actor call launched from Main, it cannot overtake append/VAD.
    private let captureRequested = Atomic<Bool>(false)
    let meter: AssistVoiceInputMeter

    nonisolated init(format: AVAudioFormat, meter: AssistVoiceInputMeter) {
        sampleRate = format.sampleRate
        channels = Int(format.channelCount)
        self.meter = meter
        samples = .allocate(capacity: Self.capacity)
        samples.initialize(repeating: 0, count: Self.capacity)
    }
    deinit { samples.deinitialize(count: Self.capacity); samples.deallocate() }

    nonisolated func append(_ buffer: AVAudioPCMBuffer) {
        guard open.load(ordering: .acquiring), !failed.load(ordering: .relaxed) else { return }
        meter.observe(buffer)
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }
        guard buffer.format.sampleRate == sampleRate,
              Int(buffer.format.channelCount) == channels, (1...2).contains(channels),
              count <= Self.capacity, buffer.stride > 0 else { fail(); return }
        let write = written.load(ordering: .relaxed)
        let read = consumed.load(ordering: .acquiring)
        guard write >= read, write - read <= UInt64(Self.capacity - count) else { fail(); return }
        switch buffer.format.commonFormat {
        case .pcmFormatFloat32:
            guard let data = buffer.floatChannelData else { fail(); return }
            copy(data, count: count, stride: buffer.stride, write: write) { $0 }
        case .pcmFormatInt16:
            guard let data = buffer.int16ChannelData else { fail(); return }
            copy(data, count: count, stride: buffer.stride, write: write) { Float($0) / 32_768 }
        case .pcmFormatInt32:
            guard let data = buffer.int32ChannelData else { fail(); return }
            copy(data, count: count, stride: buffer.stride, write: write) { Float($0) / 2_147_483_648 }
        default: fail(); return
        }
        guard !failed.load(ordering: .relaxed) else { return }
        written.store(write + UInt64(count), ordering: .releasing)
    }

    private nonisolated func copy<T>(_ data: UnsafePointer<UnsafeMutablePointer<T>>, count: Int,
                                     stride: Int, write: UInt64, normalize: (T) -> Float) {
        for frame in 0..<count {
            var value: Float = 0
            for channel in 0..<channels {
                let sample = normalize(data[channel][frame * stride])
                guard sample.isFinite else { fail(); return }
                value += min(1, max(-1, sample)) / Float(channels)
            }
            samples[Int((write + UInt64(frame)) % UInt64(Self.capacity))] = value
        }
    }
    private nonisolated func fail() { failed.store(true, ordering: .releasing) }
    nonisolated func requestCapture() -> Bool {
        guard open.load(ordering: .acquiring), !failed.load(ordering: .acquiring) else { return false }
        captureRequested.store(true, ordering: .releasing)
        return true
    }
    nonisolated func takeCaptureRequest() -> Bool {
        captureRequested.exchange(false, ordering: .acquiringAndReleasing)
    }
    nonisolated func close() { open.store(false, ordering: .releasing) }
    nonisolated var hasFailed: Bool { failed.load(ordering: .acquiring) }
    nonisolated var isClosed: Bool { !open.load(ordering: .acquiring) }

    /// Worker only, at most 4,096 source-rate frames per allocation.
    nonisolated func read() -> [Float] {
        let read = consumed.load(ordering: .relaxed)
        let write = written.load(ordering: .acquiring)
        let count = min(4_096, Int(write - read))
        guard count > 0 else { return [] }
        var result = [Float](repeating: 0, count: count)
        for index in 0..<count { result[index] = samples[Int((read + UInt64(index)) % UInt64(Self.capacity))] }
        consumed.store(read + UInt64(count), ordering: .releasing)
        return result
    }
}

/// Each processor is actor confined; only this worker feeds append/adoption.
/// Its protocol also lets the no-microphone harness suspend the real worker at
/// an inference boundary and verify command ordering/cancellation.
protocol AssistFluidInputProcessor: Actor {
    func append(_ samples: [Float], sampleRate: Double) async
    func adoptCapture() -> Bool
    func finishInput() async
}

enum AssistFluidInputWorker {
    nonisolated static func run(
        ring: AssistFluidAudioInput, processor: any AssistFluidInputProcessor,
        didAdopt: @escaping @Sendable (Bool) async -> Void,
        failure: @escaping @Sendable () async -> Void
    ) async {
        while !Task.isCancelled {
            if ring.hasFailed { await failure(); return }
            if ring.takeCaptureRequest() {
                let accepted = await processor.adoptCapture()
                guard !Task.isCancelled else { return }
                await didAdopt(accepted)
            }
            guard !Task.isCancelled else { return }
            let values = ring.read()
            if !values.isEmpty { await processor.append(values, sampleRate: ring.sampleRate) }
            else if ring.isClosed { await processor.finishInput(); return }
            else {
                do { try await Task.sleep(for: .milliseconds(10)) } catch { return }
            }
        }
    }
}

/// The converter invokes this callback synchronously on its worker actor.
/// Its buffer never escapes convert(); the atomic flag is the sole mutation
/// shared with AVFoundation's legacy Sendable input callback.
private final class AssistFluidConverterInput: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer?
    let ending: Bool
    let consumed = Atomic<Bool>(false)
    init(_ buffer: AVAudioPCMBuffer?, ending: Bool) { self.buffer = buffer; self.ending = ending }
    nonisolated func callback() -> @Sendable (AVAudioPacketCount, UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        { [self] _, status in
            if let buffer, !consumed.exchange(true, ordering: .relaxed) {
                status.pointee = .haveData; return buffer
            }
            status.pointee = ending ? .endOfStream : .noDataNow
            return nil
        }
    }
}

/// Worker-actor confined, persistent resampling preserves filter state across
/// tap packets. No stateless per-packet resampler, file I/O or inference in tap.
final class AssistFluidInputResampler {
    private let source: AVAudioFormat
    private let target = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
    private let converter: AVAudioConverter
    init(sampleRate: Double) throws {
        guard (8_000...96_000).contains(sampleRate),
              let source = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let converter = AVAudioConverter(from: source, to: target) else { throw Self.error() }
        self.source = source; self.converter = converter
    }
    func convert(_ samples: [Float]) throws -> [Float] {
        guard !samples.isEmpty, samples.count <= 4_096,
              let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(samples.count)) else { throw Self.error() }
        input.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { input.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        return try render(input, ending: false).samples
    }
    func finish() throws -> [Float] {
        var result: [Float] = []
        for _ in 0..<8 {
            let output = try render(nil, ending: true)
            result.append(contentsOf: output.samples)
            if output.status == .endOfStream { return result }
        }
        throw Self.error()
    }
    private func render(_ input: AVAudioPCMBuffer?, ending: Bool) throws -> (samples: [Float], status: AVAudioConverterOutputStatus) {
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 9_216) else { throw Self.error() }
        let holder = AssistFluidConverterInput(input, ending: ending)
        var error: NSError?
        let status = converter.convert(to: output, error: &error, withInputFrom: holder.callback())
        if let error { throw error }
        guard status != .error else { throw Self.error() }
        let count = Int(output.frameLength)
        return (count > 0 ? Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: count)) : [], status)
    }
    private static func error() -> NSError { NSError(domain: "AssistFluidInput", code: 1, userInfo: [NSLocalizedDescriptionKey: "Le rééchantillonnage local du microphone a échoué."]) }
}
