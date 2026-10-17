import AVFoundation
import Foundation
import Synchronization

/// Generated TTS only. Microphone PCM is never copied into this transfer.
enum AssistVoicePCMMessage: Sendable {
    case samples(sequence: Int, values: [Float], sampleRate: Double, reservedBytes: Int)
    case end(sequence: Int)
    case failure(String)

    var sequence: Int? {
        switch self {
        case .samples(let sequence, _, _, _), .end(let sequence): return sequence
        case .failure: return nil
        }
    }
    var reservedBytes: Int {
        if case .samples(_, _, _, let bytes) = self { return bytes }
        return 0
    }
}

/// A bounded bridge from a legacy synthesis callback to its main-actor owner.
/// Only immutable value samples cross that boundary. Its reservations remain
/// held until playback ends, including callbacks released by player.stop().
final class AssistVoicePCMTransfer: Sendable {
    static let maximumBytes = 4 * 1_024 * 1_024
    static let maximumPackets = 2_048
    static let maximumFramesPerPacket = 65_536

    private let active = Atomic<Bool>(true)
    private let failed = Atomic<Bool>(false)
    // The closed bit and next ordinal share one atomic modification order.
    private let stream = Atomic<UInt64>(0)
    private let bytes = Atomic<Int>(0)
    private let packets = Atomic<Int>(0)
    private let receive: @MainActor @Sendable (AssistVoicePCMMessage) -> Void

    nonisolated init(receive: @escaping @MainActor @Sendable (AssistVoicePCMMessage) -> Void) {
        self.receive = receive
    }

    nonisolated func invalidate() { active.store(false, ordering: .releasing) }

    nonisolated func release(_ count: Int) {
        guard count > 0 else { return }
        _ = bytes.wrappingSubtract(count, ordering: .acquiringAndReleasing)
        _ = packets.wrappingSubtract(1, ordering: .acquiringAndReleasing)
    }

    private nonisolated func claim(ending: Bool) -> Int? {
        let closed = UInt64(1) << 63
        while active.load(ordering: .acquiring) {
            let prior = stream.load(ordering: .acquiring)
            guard prior & closed == 0 else { return nil }
            let next = (prior + 1) | (ending ? closed : 0)
            if stream.compareExchange(expected: prior, desired: next,
                                      ordering: .acquiringAndReleasing).exchanged {
                return Int(prior)
            }
        }
        return nil
    }

    /// The callback is explicitly formed outside any actor. It is a synthesis
    /// callback, not an audio-render callback; bounded allocation is intentional.
    nonisolated func callback() -> @Sendable (AVAudioBuffer) -> Void {
        { [self] buffer in
            guard active.load(ordering: .acquiring) else { return }
            guard let pcm = buffer as? AVAudioPCMBuffer else {
                fail("Le moteur vocal a fourni un format audio non pris en charge."); return
            }
            let frames = Int(pcm.frameLength)
            guard let index = claim(ending: frames == 0) else {
                if frames > 0 && active.load(ordering: .acquiring) {
                    fail("Audio reçu après la fin du segment de synthèse.")
                }
                return
            }
            if frames == 0 { deliver(.end(sequence: index)); return }
            let channelCount = Int(pcm.format.channelCount)
            let rate = pcm.format.sampleRate
            guard frames <= Self.maximumFramesPerPacket,
                  (1...2).contains(channelCount), (8_000...96_000).contains(rate),
                  pcm.stride > 0 else {
                fail("Le segment audio dépasse les limites du lecteur local."); return
            }
            let reservation = frames * MemoryLayout<Float>.stride
            let oldBytes = bytes.wrappingAdd(reservation, ordering: .acquiringAndReleasing).oldValue
            let oldPackets = packets.wrappingAdd(1, ordering: .acquiringAndReleasing).oldValue
            guard oldBytes <= Self.maximumBytes - reservation, oldPackets < Self.maximumPackets else {
                release(reservation)
                fail("Le lecteur vocal local est saturé. Reprends le mode vocal."); return
            }
            let values: [Float]?
            switch pcm.format.commonFormat {
            case .pcmFormatFloat32:
                values = Self.copy(pcm, as: Float.self, frames: frames, channels: channelCount) { $0 }
            case .pcmFormatInt16:
                values = Self.copy(pcm, as: Int16.self, frames: frames, channels: channelCount) { Float($0) / 32_768 }
            case .pcmFormatInt32:
                values = Self.copy(pcm, as: Int32.self, frames: frames, channels: channelCount) { Float($0) / 2_147_483_648 }
            default: values = nil
            }
            guard let values else {
                release(reservation)
                fail("Le moteur vocal a fourni des échantillons audio invalides."); return
            }
            guard active.load(ordering: .acquiring) else { release(reservation); return }
            deliver(.samples(sequence: index, values: values, sampleRate: rate, reservedBytes: reservation))
        }
    }

    private nonisolated func deliver(_ message: AssistVoicePCMMessage) {
        let receive = receive
        Task { @MainActor in receive(message) }
    }

    private nonisolated func fail(_ message: String) {
        guard !failed.exchange(true, ordering: .acquiringAndReleasing) else { return }
        active.store(false, ordering: .releasing)
        deliver(.failure(message))
    }

    private nonisolated static func copy<Sample>(
        _ buffer: AVAudioPCMBuffer, as: Sample.Type,
        frames: Int, channels: Int, normalize: (Sample) -> Float
    ) -> [Float]? {
        let data = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let interleaved = buffer.format.isInterleaved
        guard data.count == (interleaved ? 1 : channels) else { return nil }
        for index in data.indices {
            let samples = frames * (interleaved ? channels : 1)
            guard data[index].mData != nil,
                  Int(data[index].mDataByteSize) >= samples * MemoryLayout<Sample>.stride else { return nil }
        }
        var values = [Float](repeating: 0, count: frames)
        for frame in 0..<frames {
            var value: Float = 0
            for channel in 0..<channels {
                let entry = data[interleaved ? 0 : channel]
                let offset = interleaved ? frame * channels + channel : frame
                let sample = normalize(entry.mData!.assumingMemoryBound(to: Sample.self)[offset])
                guard sample.isFinite else { return nil }
                value += min(1, max(-1, sample)) / Float(channels)
            }
            values[frame] = value
        }
        return values
    }
}

/// This immutable input buffer is accessed only during a synchronous convert
/// call on its owner. Atomic consumption makes the legacy callback Sendable
/// without transferring or mutating AVAudioPCMBuffer between actors. Remove
/// this wrapper when the SDK supplies a Sendable converter-input contract.
private final class AssistVoiceConverterInput: @unchecked Sendable {
    private let buffer: AVAudioPCMBuffer?
    private let consumed = Atomic<Bool>(false)
    private let ending: Bool

    init(buffer: AVAudioPCMBuffer?, ending: Bool) { self.buffer = buffer; self.ending = ending }

    nonisolated func callback() -> @Sendable (AVAudioPacketCount, UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        { [self] _, status in
            if let buffer, !consumed.exchange(true, ordering: .relaxed) {
                status.pointee = .haveData
                return buffer
            }
            status.pointee = ending ? .endOfStream : .noDataNow
            return nil
        }
    }
}

/// All AVFoundation objects here remain on MainActor. Source rate may change
/// between utterances; a format change within an utterance fails explicitly.
@MainActor
final class AssistVoicePCMConverter {
    let outputFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    private var converter: AVAudioConverter?
    private var sourceRate: Double?

    func convert(_ values: [Float], sampleRate: Double) throws -> AVAudioPCMBuffer? {
        guard !values.isEmpty, values.count <= AssistVoicePCMTransfer.maximumFramesPerPacket,
              (8_000...96_000).contains(sampleRate) else { throw Self.error() }
        let source = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
        if let sourceRate, sourceRate != sampleRate { throw Self.error() }
        if converter == nil {
            sourceRate = sampleRate
            converter = AVAudioConverter(from: source, to: outputFormat)
        }
        guard let converter,
              let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(values.count))
        else { throw Self.error() }
        input.frameLength = AVAudioFrameCount(values.count)
        values.withUnsafeBufferPointer { pointer in
            input.floatChannelData![0].update(from: pointer.baseAddress!, count: values.count)
        }
        let capacity = AVAudioFrameCount(ceil(Double(values.count) * 48_000 / sampleRate) + 512)
        return try render(converter, input: input, capacity: capacity, ending: false).buffer
    }

    /// Drain the resampler fully before publishing production completion. A
    /// finite bound prevents a faulty converter from retaining or looping forever.
    func finish() throws -> [AVAudioPCMBuffer] {
        guard let converter else { return [] }
        var tail: [AVAudioPCMBuffer] = []
        for _ in 0..<8 {
            let output = try render(converter, input: nil, capacity: 1_024, ending: true)
            if let buffer = output.buffer { tail.append(buffer) }
            if output.status == .endOfStream { return tail }
        }
        throw Self.error()
    }

    private func render(
        _ converter: AVAudioConverter, input: AVAudioPCMBuffer?, capacity: AVAudioFrameCount, ending: Bool
    ) throws -> (buffer: AVAudioPCMBuffer?, status: AVAudioConverterOutputStatus) {
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { throw Self.error() }
        let source = AssistVoiceConverterInput(buffer: input, ending: ending)
        var error: NSError?
        let result = converter.convert(to: output, error: &error, withInputFrom: source.callback())
        if result == .error || error != nil { throw error ?? Self.error() }
        return (output.frameLength == 0 ? nil : output, result)
    }

    private static func error() -> NSError {
        NSError(domain: "Assist.Voice.PCM", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Le format de synthèse vocale ne peut pas être converti."])
    }
}
