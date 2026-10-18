import AVFoundation
import Dispatch
import Foundation

/// A controllable VAD/inference boundary for the ACTUAL production worker.
/// Only the model processor is substituted; ring/worker/capture policy are real.
private actor RetainedInputProbe: AssistFluidInputProcessor {
    private var capture = AssistFluidCaptureWindow(monitoring: true)
    private var order: [String] = []
    private var firstAppend = true
    private var appendStarted = false
    private var startedWaiter: CheckedContinuation<Void, Never>?
    private var releaseWaiter: CheckedContinuation<Void, Never>?
    private var adoptionWaiter: CheckedContinuation<Void, Never>?
    private var adopted = false
    private var failed = false
    private var hadPartial = false
    func append(_ samples: [Float], sampleRate: Double) async {
        precondition(sampleRate == 16_000)
        if firstAppend {
            firstAppend = false
            order.append("append-start")
            appendStarted = true
            startedWaiter?.resume(); startedWaiter = nil
            await withCheckedContinuation { releaseWaiter = $0 }
            order.append("append-end")
        }
        do {
            _ = try capture.append(samples, probability: samples.first == 0.2 ? 0.9 : 0.1)
            if capture.reservePartial() { hadPartial = true }
        } catch { failed = true }
    }
    func adoptCapture() -> Bool {
        order.append("adopt")
        capture.adoptCapture()
        if capture.reservePartial() { hadPartial = true }
        return true
    }
    func acknowledged(_ accepted: Bool) {
        precondition(accepted)
        order.append("ack")
        adopted = true
        adoptionWaiter?.resume(); adoptionWaiter = nil
    }
    func finishInput() async {
        do { try capture.finish(tail: []) } catch { failed = true }
        order.append("finish")
    }
    func fail() { failed = true }
    func waitForAppend() async {
        if !appendStarted { await withCheckedContinuation { startedWaiter = $0 } }
    }
    func releaseAppend() { releaseWaiter?.resume(); releaseWaiter = nil }
    func waitForAdoption() async {
        if !adopted { await withCheckedContinuation { adoptionWaiter = $0 } }
    }
    func result() -> (order: [String], samples: [Float], partial: Bool, failed: Bool) {
        (order, capture.samples, hadPartial, failed)
    }
}

/// An actual suspended text-stream producer, with a controllable final drain.
private actor RetiringSpeechProbe {
    private let stream: AsyncStream<String>
    private let continuation: AsyncStream<String>.Continuation
    private var worker: Task<Void, Never>?
    private var requested = false
    private var requestedWaiter: CheckedContinuation<Void, Never>?
    private var drainWaiter: CheckedContinuation<Void, Never>?
    private var loopEnded = false

    init() {
        let pair = AsyncStream.makeStream(of: String.self)
        stream = pair.stream; continuation = pair.continuation
    }
    func start() {
        worker = Task { [self] in
            for await _ in stream { }
            await withCheckedContinuation { drainWaiter = $0 }
            loopEnded = true
        }
    }
    func cancel() async {
        requested = true
        continuation.finish()
        requestedWaiter?.resume(); requestedWaiter = nil
        await worker?.value
    }
    func waitForCancellation() async {
        if !requested { await withCheckedContinuation { requestedWaiter = $0 } }
    }
    func finishDrain() async {
        while drainWaiter == nil { await Task.yield() }
        drainWaiter?.resume(); drainWaiter = nil
    }
    func stopped() -> Bool { loopEnded }
}

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
    private static func retainedCapturePolicy() throws {
        let shortWord = [Float](repeating: 0.2, count: 1_920)
        let silence = [Float](repeating: 0, count: 4_096)
        // TTS monitoring has heard a short word, but no two-window onset.
        var afterWord = AssistFluidCaptureWindow(monitoring: true)
        try assertOnset(&afterWord, shortWord, probability: 0.9, expected: false)
        precondition(!afterWord.reservePartial())
        afterWord.adoptCapture()
        afterWord.adoptCapture() // duplicate handoff cannot erase the onset
        for _ in 0..<9 { try assertOnset(&afterWord, silence, probability: 0.1, expected: false) }
        precondition(!afterWord.speechStarted && afterWord.reservePartial())
        precondition(!afterWord.reservePartial())
        let pendingVADTail: [Float] = [0.15, 0.16, 0.17]
        try afterWord.finish(tail: pendingVADTail)
        precondition(Array(afterWord.samples.prefix(shortWord.count)) == shortWord)
        precondition(Array(afterWord.samples.suffix(pendingVADTail.count)) == pendingVADTail)
        // The common path adopts first, then receives a sub-window "oui".
        var beforeWord = AssistFluidCaptureWindow(monitoring: true)
        beforeWord.adoptCapture()
        _ = try beforeWord.append(shortWord, probability: 0.9)
        for _ in 0..<4 { _ = try beforeWord.append(silence, probability: 0.1) }
        precondition(beforeWord.reservePartial() && !beforeWord.speechStarted)
        precondition(Array(beforeWord.samples.prefix(shortWord.count)) == shortWord)
        // An already-qualified onset keeps its existing samples/decode cursor.
        var qualified = AssistFluidCaptureWindow(monitoring: true)
        for _ in 0..<4 { _ = try qualified.append(silence, probability: 0.1) }
        for _ in 0..<2 { _ = try qualified.append(silence, probability: 0.9) }
        precondition(qualified.speechStarted && qualified.reservePartial())
        let saved = qualified.samples
        qualified.adoptCapture()
        precondition(qualified.samples == saved && !qualified.reservePartial())
        print("PASS retained TTS→capture before/after short word, VAD tail, idempotence & qualified onset")
    }
    private static func retainedWorkerHandoff(cancelled: Bool) async {
        let word = [Float](repeating: 0.2, count: 1_920)
        let input = buffer(word, rate: 16_000)
        let ring = AssistFluidAudioInput(format: input.format, meter: AssistVoiceInputMeter())
        let probe = RetainedInputProbe()
        ring.append(input)
        let worker = Task {
            await AssistFluidInputWorker.run(ring: ring, processor: probe, didAdopt: { accepted in
                await probe.acknowledged(accepted)
            }, failure: { await probe.fail() })
        }
        await probe.waitForAppend()
        precondition(ring.requestCapture())
        let suspended = await probe.result()
        precondition(suspended.order == ["append-start"], "Handoff overtook in-flight VAD")
        if cancelled { worker.cancel(); ring.close() }
        await probe.releaseAppend()
        if cancelled {
            await worker.value
            let result = await probe.result()
            precondition(result.order == ["append-start", "append-end"] && !result.failed)
            precondition(!ring.requestCapture(), "A closed input must not accept a late handoff")
            print("PASS cancellation during actual worker append prevents adoption ACK / late capture")
            return
        }
        await probe.waitForAdoption()
        let silence = buffer([Float](repeating: 0, count: 4_096), rate: 16_000)
        for _ in 0..<9 { ring.append(silence) }
        ring.close()
        await worker.value
        let result = await probe.result()
        precondition(!result.failed && !ring.hasFailed && result.partial)
        precondition(result.order == ["append-start", "append-end", "adopt", "ack", "finish"])
        precondition(Array(result.samples.prefix(word.count)) == word)
        precondition(result.samples.count == word.count + 9 * 4_096)
        precondition(!ring.takeCaptureRequest() && !ring.requestCapture())
        print("PASS actual worker serializes retained capture after suspended VAD and keeps short onset through EOS")
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
    private static func retiredSpeechOwnership() async {
        var owner = AssistFluidSpeechSessionOwner<RetiringSpeechProbe>()
        let old = RetiringSpeechProbe()
        await old.start()
        owner.install(old)
        let retired = owner.retire(old)
        precondition(retired === old && owner.current == nil,
                     "Retiring the current response must release the runtime's strong reference")
        let cancellation = Task { await retired?.cancel() }
        await old.waitForCancellation()
        let beforeDrain = await old.stopped()
        precondition(!beforeDrain, "Cancellation must wait for producer drain")
        let newer = RetiringSpeechProbe()
        owner.install(newer)
        let late = owner.retire(old)
        precondition(late === old && owner.current === newer,
                     "A delayed old retirement cannot erase the next response")
        await old.finishDrain()
        await cancellation.value
        let afterDrain = await old.stopped()
        precondition(afterDrain, "Cancellation must close the actual text-stream loop")
        precondition(owner.current === newer)
        var object: RetiringSpeechProbe? = RetiringSpeechProbe()
        weak let weakObject = object
        owner.install(object!)
        object = nil
        precondition(weakObject != nil)
        _ = owner.retire()
        precondition(weakObject == nil, "No retired producer reference remains in the runtime owner")
        print("PASS exact speech retirement clears ownership, awaits producer stop, and preserves a newer response")
    }

    private static func retiredSpeechShutdownBarrier() async throws {
        var owner = AssistFluidSpeechSessionOwner<RetiringSpeechProbe>()
        var barrier = AssistFluidSpeechRetirementBarrier()
        let old = RetiringSpeechProbe()
        await old.start()
        owner.install(old)
        let retired = owner.retire(old)!
        let retirement = Task { await retired.cancel() }
        barrier.append(retirement)
        await old.waitForCancellation()
        precondition(owner.current == nil)
        let oldStillRunning = await old.stopped()
        precondition(!oldStillRunning, "The regression requires a retired producer still inside inference")

        // Mirrors the full shutdown's admission boundary. No sleep or polling:
        // without a pending retirement, restart deterministically passes while
        // the old producer is held at its explicit final-drain continuation.
        let pending = barrier.take()
        let restart = Task {
            await pending?.value
            return await old.stopped()
        }
        if pending == nil {
            let admittedSafely = await restart.value
            precondition(admittedSafely,
                         "Restart passed shutdown while a retired speech prediction was still running")
        }
        precondition(barrier.take() == nil, "Full shutdown must take ownership of the pending retirements")
        await old.finishDrain()
        let admittedSafely = await restart.value
        precondition(admittedSafely, "Restart must follow the retired producer's complete exit")

        // Several retirements, including one completing out of order, remain
        // joined until the full shutdown takes them. A later shutdown gets a
        // new independent snapshot rather than overwriting the earlier one.
        let first = RetiringSpeechProbe()
        let second = RetiringSpeechProbe()
        await first.start(); await second.start()
        let firstRetirement = Task { await first.cancel() }
        let secondRetirement = Task { await second.cancel() }
        barrier.append(firstRetirement)
        barrier.append(secondRetirement)
        await first.waitForCancellation(); await second.waitForCancellation()
        let all = barrier.take()
        precondition(all != nil && barrier.take() == nil)
        await second.finishDrain()
        await secondRetirement.value
        await first.finishDrain()
        await all?.value
        let firstStopped = await first.stopped()
        let secondStopped = await second.stopped()
        precondition(firstStopped && secondStopped)

        let source = try String(contentsOfFile: "mobile/ios/Assist/Voice/AssistVoice.swift", encoding: .utf8)
        let stopStart = source.range(of: "private func stopSpeechOutput(")!
        let stopEnd = source.range(of: "private func finishSpeechNaturally", range: stopStart.upperBound..<source.endIndex)!
        precondition(source[stopStart.lowerBound..<stopEnd.lowerBound].contains("fluidSpeechRetirements.append(retirement)"))
        let shutdownStart = source.range(of: "private func cancelCurrent(")!
        let shutdownEnd = source.range(of: "private func fail(", range: shutdownStart.upperBound..<source.endIndex)!
        let shutdown = String(source[shutdownStart.lowerBound..<shutdownEnd.lowerBound])
        let take = shutdown.range(of: "let speechRetirements = fluidSpeechRetirements.take()")!
        let joined = shutdown.range(of: "await speechRetirements?.value")!
        let runtime = shutdown.range(of: "await runtime?.cancel()")!
        precondition(take.lowerBound < joined.lowerBound && joined.lowerBound < runtime.lowerBound,
                     "Production shutdown must join retired speech before releasing/reusing the runtime")
        print("PASS shutdown joins retired speech after owner removal before admitting a fresh model runtime")
    }
    static func main() async throws {
        ringCopyAndWrap(); ringOverflow(); ringCloseAndFormat(); stereo(); concurrentSPSC()
        try resampling(); try onsetAndPreroll(); try nonconsecutiveAndShort(); try shortCaptureSurvivesEOT(); try boundedUtteranceAndMailbox()
        try retainedCapturePolicy()
        await retainedWorkerHandoff(cancelled: false)
        await retainedWorkerHandoff(cancelled: true)
        await retiredSpeechOwnership()
        try await retiredSpeechShutdownBarrier()
        print("PASS 15 Fluid voice adapter checks · synthetic PCM, no microphone/model/iPhone qualification")
    }
}
