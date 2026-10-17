import AVFoundation
import Dispatch
import Foundation

/// Synthetic PCM only. No engine, microphone, speech recognizer, model load,
/// file import or inference; these checks do not prove iPhone audio behavior.
@main
struct FluidVoiceChecks {
    private static func buffer(_ samples: [Float], rate: Double = 48_000, channels: AVAudioChannelCount = 1,
                               interleaved: Bool = false) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate,
                                   channels: channels, interleaved: interleaved)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))!
        buffer.frameLength = AVAudioFrameCount(samples.count)
        for channel in 0..<Int(channels) {
            for index in samples.indices { buffer.floatChannelData![channel][index * buffer.stride] = samples[index] }
        }
        return buffer
    }
    private static func drain(_ ring: AssistFluidAudioInput) -> [Float] {
        var all: [Float] = []
        while true {
            let next = ring.read()
            if next.isEmpty { return all }
            all.append(contentsOf: next)
        }
    }
    private static func ringCopyAndWrap() {
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let ring = AssistFluidAudioInput(format: format, meter: AssistVoiceInputMeter())
        for cycle in 0..<200 {
            let values = (0..<1_024).map { Float(($0 + cycle) % 31) / 32 }
            ring.append(buffer(values))
            precondition(ring.read() == values, "SPSC ring altered order/wrapped samples")
        }
        precondition(!ring.hasFailed && ring.meter.snapshot().frameCount == 204_800)
        print("PASS ring value copy / wrap-around / metering")
    }
    private static func ringOverflow() {
        let input = buffer([Float](repeating: 0.2, count: 4_096))
        let ring = AssistFluidAudioInput(format: input.format, meter: AssistVoiceInputMeter())
        for _ in 0..<(AssistFluidAudioInput.capacity / 4_096) { ring.append(input) }
        precondition(!ring.hasFailed)
        ring.append(input)
        precondition(ring.hasFailed && drain(ring).count == AssistFluidAudioInput.capacity,
                     "Overflow must fail without overwriting queued speech")
        print("PASS ring bounded overflow fails without overwrite")
    }
    private static func ringCloseAndFormat() {
        let input = buffer([0.1, 0.2, 0.3])
        let ring = AssistFluidAudioInput(format: input.format, meter: AssistVoiceInputMeter())
        ring.append(input); ring.close(); ring.append(input)
        precondition(ring.isClosed && drain(ring) == [0.1, 0.2, 0.3])
        let changed = AssistFluidAudioInput(format: input.format, meter: AssistVoiceInputMeter())
        changed.append(buffer([0.1], rate: 44_100))
        precondition(changed.hasFailed && changed.read().isEmpty)
        let invalid = AssistFluidAudioInput(format: input.format, meter: AssistVoiceInputMeter())
        invalid.append(buffer([0.1, .nan]))
        precondition(invalid.hasFailed && invalid.read().isEmpty)
        print("PASS close preserves queued onset / stale writes blocked / format & nonfinite fail")
    }
    private static func stereo() {
        for interleaved in [false, true] {
            let value = buffer([0.25, -0.5], channels: 2, interleaved: interleaved)
            // Distinct channels test downmix, including interleaved stride.
            value.floatChannelData![1][0] = 0.75
            value.floatChannelData![1][value.stride] = 0.5
            let ring = AssistFluidAudioInput(format: value.format, meter: AssistVoiceInputMeter())
            ring.append(value)
            precondition(ring.read() == [0.5, 0], "Stereo tap PCM must downmix correctly")
        }
        print("PASS planar/interleaved stereo downmix")
    }
    private static func concurrentSPSC() {
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let ring = AssistFluidAudioInput(format: format, meter: AssistVoiceInputMeter())
        let available = DispatchSemaphore(value: 0)
        let consumed = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            for index in 0..<300 {
                let value = Float(index % 100) / 100
                ring.append(buffer([Float](repeating: value, count: 1_024)))
                available.signal()
                precondition(consumed.wait(timeout: .now() + 5) == .success)
            }
            ring.close(); group.leave()
        }
        for index in 0..<300 {
            precondition(available.wait(timeout: .now() + 5) == .success)
            precondition(ring.read() == [Float](repeating: Float(index % 100) / 100, count: 1_024))
            consumed.signal()
        }
        precondition(group.wait(timeout: .now() + 5) == .success && !ring.hasFailed)
        print("PASS independent producer/consumer ownership across wrap-around")
    }
    private static func converted(_ source: [Float], rate: Double, size: Int) throws -> [Float] {
        let converter = try AssistFluidInputResampler(sampleRate: rate)
        var output: [Float] = []
        var index = 0
        while index < source.count {
            let end = min(source.count, index + size)
            output.append(contentsOf: try converter.convert(Array(source[index..<end])))
            index = end
        }
        output.append(contentsOf: try converter.finish())
        return output
    }
    private static func resampling() throws {
        for (rate, count) in [(48_000.0, 3_072), (44_100.0, 3_528), (8_000.0, 1_024)] {
            let signal = (0..<count).map { Float(sin(2 * Double.pi * 440 * Double($0) / rate)) * 0.5 }
            let whole = try converted(signal, rate: rate, size: count)
            let segmented = try converted(signal, rate: rate, size: 128)
            precondition(whole.count == segmented.count, "Packet segmentation lost resampler tail")
            precondition(abs(whole.count - Int(Double(count) * 16_000 / rate)) <= 1)
            precondition(zip(whole, segmented).allSatisfy { abs($0 - $1) < 0.0001 })
            precondition(whole.contains { abs($0) > 0.1 })
        }
        print("PASS actual persistent AVAudioConverter 8/44.1/48→16 kHz segmentation & complete tail")
    }
    private static func assertOnset(_ capture: inout AssistFluidCaptureWindow, _ chunk: [Float],
                                    probability: Float, expected: Bool) throws {
        let onset = try capture.append(chunk, probability: probability)
        precondition(onset == expected)
    }
    private static func onsetAndPreroll() throws {
        var capture = AssistFluidCaptureWindow(monitoring: true)
        let silence = [Float](repeating: 0, count: 4_096)
        for _ in 0..<50 { try assertOnset(&capture, silence, probability: 0.1, expected: false) }
        let first = [Float](repeating: 0.2, count: 4_096)
        let second = [Float](repeating: 0.3, count: 4_096)
        try assertOnset(&capture, first, probability: 0.9, expected: false)
        try assertOnset(&capture, second, probability: 0.9, expected: true)
        precondition(capture.samples.count == 16_384 && Array(capture.samples.suffix(8_192)) == first + second)
        precondition(capture.reservePartial() && !capture.reservePartial())
        try assertOnset(&capture, second, probability: 0.9, expected: false)
        print("PASS bounded monitor preroll preserves both onset windows / one promotion")
    }
    private static func nonconsecutiveAndShort() throws {
        var capture = AssistFluidCaptureWindow()
        let chunk = [Float](repeating: 0.2, count: 4_096)
        try assertOnset(&capture, chunk, probability: 0.9, expected: false)
        try assertOnset(&capture, chunk, probability: 0.1, expected: false)
        try assertOnset(&capture, chunk, probability: 0.9, expected: false)
        precondition(!capture.speechStarted)
        var short = AssistFluidCaptureWindow()
        try short.finish(tail: [0.1, 0.2])
        precondition(short.samples == [0.1, 0.2], "Final STT must keep sub-VAD-window actual speech")
        print("PASS separated VAD spikes do not promote / short EOS keeps actual samples")
    }
    private static func shortCaptureSurvivesEOT() throws {
        var capture = AssistFluidCaptureWindow()
        let firstWord = [Float](repeating: 0.2, count: 1_920)
        try assertOnset(&capture, firstWord, probability: 0.9, expected: false)
        let silence = [Float](repeating: 0, count: 4_096)
        for _ in 0..<9 { try assertOnset(&capture, silence, probability: 0.1, expected: false) }
        try capture.finish(tail: [])
        precondition(!capture.speechStarted)
        precondition(capture.reservePartial(), "Normal capture needs an ASR hypothesis without two full VAD windows")
        precondition(!capture.reservePartial(), "Repeated observations cannot duplicate a decode request")
        precondition(capture.samples.count == firstWord.count + 9 * silence.count)
        precondition(Array(capture.samples.prefix(firstWord.count)) == firstWord,
                     "A short user capture must survive EOT silence beyond the monitor preroll")
        print("PASS sub-VAD-window word survives more than two seconds of EOT silence")
    }
    private static func boundedUtteranceAndMailbox() throws {
        var capture = AssistFluidCaptureWindow()
        let chunk = [Float](repeating: 0.2, count: 4_096)
        _ = try capture.append(chunk, probability: 1)
        _ = try capture.append(chunk, probability: 1)
        while capture.samples.count <= AssistFluidCaptureWindow.maximumSamples - chunk.count {
            _ = try capture.append(chunk, probability: 1)
        }
        do { _ = try capture.append(chunk, probability: 1); preconditionFailure("Unbounded utterance accepted") }
        catch AssistFluidCaptureWindow.Failure.tooLong { }
        let before = capture.samples.count
        precondition(before <= AssistFluidCaptureWindow.maximumSamples)
        var box = AssistFluidDecodeMailbox()
        for index in 0..<500 { box.replace(samples: [Float(index)], final: false) }
        precondition(box.take()?.samples == [499] && box.take() == nil)
        box.complete()
        // Decode A has completed, then awaits its MainActor callback. A
        // reentrant append claims B; A's delayed launch cannot also claim C.
        box.replace(samples: [1], final: false)
        precondition(box.take()?.samples == [1])
        box.replace(samples: [2], final: false)
        precondition(box.take() == nil, "Reentrant callback started concurrent prediction")
        box.complete()
        precondition(box.take()?.samples == [2])
        box.complete()
        box.replace(samples: [7], final: true)
        box.replace(samples: [8], final: false)
        let final = box.take()
        precondition(final?.samples == [7] && final?.final == true)
        box.complete()
        box.replace(samples: [9], final: true); box.cancel()
        precondition(box.take() == nil)
        print("PASS finite utterance / latest decode coalescing / final priority / cancel clears PCM")
    }
    static func main() throws {
        ringCopyAndWrap(); ringOverflow(); ringCloseAndFormat(); stereo(); concurrentSPSC()
        try resampling(); try onsetAndPreroll(); try nonconsecutiveAndShort(); try shortCaptureSurvivesEOT(); try boundedUtteranceAndMailbox()
        print("PASS 10 Fluid voice adapter checks · synthetic PCM, no microphone/model/iPhone qualification")
    }
}
