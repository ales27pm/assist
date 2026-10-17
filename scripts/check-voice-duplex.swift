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

@MainActor
private final class TeardownNotificationProbe {
    var ownership = AssistVoiceAudioSessionOwnership()
    var errors = 0
    var notifications = 0
    nonisolated func callback() -> @Sendable (Notification) -> Void {
        { [self] _ in
            MainActor.assumeIsolated {
                notifications += 1
                // Same ownership gate used by AssistVoice.handleNotification.
                if ownership.isActive { errors += 1 }
            }
        }
    }
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
    private static func routePolicy() {
        let input = AssistVoiceRouteIdentity.Port(type: "MicrophoneBuiltIn", uid: "private-input-A")
        let output = AssistVoiceRouteIdentity.Port(type: "Speaker", uid: "private-output-A")
        let route = AssistVoiceRouteIdentity(inputs: [input], outputs: [output])
        let differentDevice = AssistVoiceRouteIdentity(inputs: [.init(type: "MicrophoneBuiltIn", uid: "private-input-B")], outputs: [output])
        let empty = AssistVoiceRouteIdentity(inputs: [], outputs: [output])
        let format = AssistVoiceRouteFormat(rate: 48_000, channels: 1, commonFormat: 1, interleaved: false)
        let changedRate = AssistVoiceRouteFormat(rate: 44_100, channels: 1, commonFormat: 1, interleaved: false)
        let changedChannels = AssistVoiceRouteFormat(rate: 48_000, channels: 2, commonFormat: 1, interleaved: false)
        let baseline = AssistVoiceRouteBaseline(route: route, input: format, output: format, player: format)
        func evaluate(reason: UInt? = 8, current: AssistVoiceRouteIdentity? = nil,
                      previous: AssistVoiceRouteIdentity? = nil, committed: Bool = true,
                      owned: AssistVoiceOwnedCategoryTransition? = nil,
                      baselineOverride: AssistVoiceRouteBaseline? = nil,
                      check: ([String]) -> Void = { _ in },
                      input: AssistVoiceRouteFormat? = nil, output: AssistVoiceRouteFormat? = nil,
                      player: AssistVoiceRouteFormat? = nil, tap: AssistVoiceRouteFormat? = nil,
                      active: Bool = true, session: Bool = true, configured: Bool = true,
                      constructing: Bool = false, running: Bool = true, vpin: Bool = true,
                      vpout: Bool = true) -> AssistVoiceRouteDecision {
            let facts = AssistVoiceRouteFacts(reason: reason, previous: previous, current: current ?? route,
                baseline: committed ? baselineOverride ?? baseline : nil, ownedCategoryTransition: owned, input: input ?? format, output: output ?? format,
                player: player ?? format, tapInput: tap ?? format, appActive: active, sessionActive: session,
                expectedSessionConfiguration: configured, constructing: constructing, engineRunning: running,
                inputVoiceProcessing: vpin, outputVoiceProcessing: vpout)
            check(facts.rejectionCauses)
            return facts.decision
        }
        precondition(evaluate(previous: route) == .accept)
        precondition(evaluate() == .accept) // delayed notice without PreviousRouteKey uses committed baseline
        precondition(evaluate(reason: 3) == .accept)
        precondition(evaluate(current: differentDevice) == .fail)
        precondition(evaluate(previous: differentDevice) == .fail)
        precondition(route.diagnosticTypes == differentDevice.diagnosticTypes)
        print("PASS: internal configuration/category requires the same private I/O identities; matching types alone cannot hide a device change.")
        for reason: UInt? in [nil, 0, 1, 2, 4, 6, 7] { precondition(evaluate(reason: reason) == .fail) }
        precondition(evaluate(current: empty) == .fail)
        precondition(evaluate(active: false) == .fail)
        precondition(evaluate(session: false) == .fail)
        precondition(evaluate(configured: false) == .fail)
        print("PASS: unknown/hardware/lost-input notifications, inactive apps and changed session configurations remain fatal.")
        precondition(evaluate(running: false) == .fail)
        precondition(evaluate(vpin: false) == .fail)
        precondition(evaluate(vpout: false) == .fail)
        precondition(evaluate(input: changedRate) == .fail)
        precondition(evaluate(output: changedChannels) == .fail)
        precondition(evaluate(player: changedRate) == .fail)
        precondition(evaluate(tap: changedRate) == .fail)
        print("PASS: stopped engine, disabled AEC, and changed input/output/player/tap formats cannot be accepted as internal reconfiguration.")
        precondition(evaluate(committed: false) == .fail)
        precondition(evaluate(committed: false, constructing: true, running: false) == .deferUntilCommit)
        precondition(evaluate(previous: route) == .accept)
        precondition(evaluate(previous: differentDevice) == .fail)
        precondition(evaluate(active: false, constructing: true) == .fail)
        precondition(evaluate(reason: 2, constructing: true) == .fail)
        print("PASS: startup configuration is deferred until graph commit and rechecked; delayed notices use its baseline without an ignore window.")
        let beforeActivation = AssistVoiceRouteIdentity(inputs: [], outputs: [.init(type: "Receiver", uid: "private-receiver")])
        let owned = AssistVoiceOwnedCategoryTransition(previous: [beforeActivation], target: route)
        precondition(evaluate(reason: 3, previous: beforeActivation, owned: owned) == .accept)
        precondition(evaluate(reason: 8, previous: beforeActivation, owned: owned) == .fail)
        precondition(evaluate(reason: 3, previous: differentDevice, owned: owned) == .fail)
        precondition(evaluate(reason: 3, current: differentDevice, previous: beforeActivation, owned: owned) == .fail)
        precondition(evaluate(reason: 2, previous: beforeActivation, owned: owned) == .fail)
        print("PASS: delayed owned category changes may match the recorded pre-activation route; no unrecorded device or VPIO UID alias is exempted.")
        let unequalBaseline = AssistVoiceRouteBaseline(route: route, input: format, output: changedChannels, player: format)
        precondition(evaluate(baselineOverride: unequalBaseline, check: { precondition($0 == ["ioMismatch"]) },
                              output: changedChannels) == .fail)
        print("PASS: unequal VPIO client I/O formats fail even with matching committed baseline and tap.")
        let postStartBaseline = AssistVoiceRouteBaseline(route: route, input: changedChannels, output: changedChannels, player: format)
        precondition(evaluate(baselineOverride: postStartBaseline, check: { precondition($0 == ["tapMismatch"]) },
                              input: changedChannels, output: changedChannels) == .fail)
        let int16 = AssistVoiceRouteFormat(rate: 48_000, channels: 1, commonFormat: 3, interleaved: false)
        let interleaved = AssistVoiceRouteFormat(rate: 48_000, channels: 1, commonFormat: 1, interleaved: true)
        for changed in [int16, interleaved] {
            let changedBaseline = AssistVoiceRouteBaseline(route: route, input: changed, output: changed, player: format)
            precondition(evaluate(baselineOverride: changedBaseline, check: { precondition($0 == ["tapMismatch"]) },
                                  input: changed, output: changed) == .fail)
        }
        let playerBaseline = AssistVoiceRouteBaseline(route: route, input: format, output: format, player: changedRate)
        precondition(evaluate(baselineOverride: playerBaseline, check: { precondition($0 == ["playerPCM"]) },
                              player: changedRate) == .fail)
        precondition(evaluate(check: { precondition($0 == ["config"]) }, configured: false) == .fail)
        print("PASS: post-start tap channel/common-format/interleaving, canonical-player and session-configuration failures have independent causes.")
        let diagnosticFacts = AssistVoiceRouteFacts(reason: 8, previous: nil, current: route, baseline: baseline,
            ownedCategoryTransition: nil, input: format, output: format, player: changedRate, tapInput: interleaved,
            appActive: true, sessionActive: true, expectedSessionConfiguration: true, constructing: false,
            engineRunning: true, inputVoiceProcessing: true, outputVoiceProcessing: true)
        let lines = diagnosticFacts.diagnosticLines(source: "graph", phase: "requesting", decision: "failed-commit", frames: 0)
        precondition(diagnosticFacts.decision == .fail && lines.count == 2)
        precondition(lines[0].hasPrefix("causes=" + diagnosticFacts.rejectionCauses.joined(separator: ",")))
        precondition(lines[0].contains("app=1 session=1 config=1 base=1") && lines[0].contains("run=1 vp=1/1"))
        for field in ["in=48000.0/1/c1/i0", "tap=48000.0/1/c1/i1", "out=48000.0/1/c1/i0", "player=44100.0/1/c1/i0"] {
            precondition(lines[1].contains(field))
        }
        precondition(lines.allSatisfy { $0.utf16.count <= 400 && $0.utf8.allSatisfy { $0 < 128 } && !$0.contains("private-") })
        print("PASS: two bounded ASCII diagnostic lines use the decision's rejection causes and complete in/tap/out/player formats without identifiers.")
        var progress = AssistVoiceRouteProgressWatch()
        let firstNotice = progress.begin(frameCount: 0)
        precondition(progress.progressed(identifier: firstNotice, frameCount: 10) == true)
        let lastNotice = progress.begin(frameCount: 10)
        precondition(progress.progressed(identifier: firstNotice, frameCount: 10) == nil)
        precondition(progress.progressed(identifier: lastNotice, frameCount: 10) == false)
        precondition(progress.progressed(identifier: lastNotice, frameCount: 20) == true)
        progress.cancel()
        precondition(progress.progressed(identifier: lastNotice, frameCount: 20) == nil)
        print("PASS: PCM progress is measured after the latest accepted notice; stale timers cannot bless a subsequent freeze or cancellation.")
        var diagnostics = AssistVoiceAudioDiagnostics()
        for index in 0..<12 { diagnostics.append("reason=8 decision=accept counter=\(index) " + String(repeating: "x", count: 500) + "\n") }
        precondition(diagnostics.lines.count == 8)
        precondition(diagnostics.lines.allSatisfy { $0.count <= 400 && !$0.contains("\n") })
        precondition(!route.diagnosticTypes.contains("private-input") && !route.diagnosticTypes.contains("private-output"))
        print("PASS: diagnostic history is bounded to eight 400-character lines and hardware identities never enter port-type diagnostics.")
    }

    @MainActor
    private static func teardownNotifications() {
        let probe = TeardownNotificationProbe()
        let center = NotificationCenter()
        let name = Notification.Name("AssistVoiceSyntheticTeardown")
        let observer = center.addObserver(forName: name, object: nil, queue: nil, using: probe.callback())
        defer { center.removeObserver(observer) }
        probe.ownership.acquire()
        center.post(name: name, object: nil)
        precondition(probe.errors == 1) // negative control: the observer sees ownership
        probe.errors = 0
        precondition(probe.ownership.relinquish())
        for _ in ["stopSpeechOutput", "stopCapture", "cancelRecognition", "setActive(false)"] {
            center.post(name: name, object: nil)
        }
        precondition(probe.notifications == 5 && probe.errors == 0)
        precondition(!probe.ownership.relinquish() && !probe.ownership.isActive)
        print("PASS: real synchronous notifications at teardown boundaries see relinquished production ownership; deactivation is claimed once.")
    }

    @MainActor
    private static func teardownDeclaration(in source: String) throws -> Range<String.Index>? {
        // Arguments belong to the production lifecycle, not to this source
        // locator. Require exactly one declaration and retain the order checks.
        let pattern = #"(?m)^    private func cancelCurrent\([^\n]*\) \{$"#
        let matches = try NSRegularExpression(pattern: pattern).matches(
            in: source, range: NSRange(source.startIndex..<source.endIndex, in: source))
        guard matches.count == 1 else { return nil }
        return Range(matches[0].range, in: source)
    }

    @MainActor
    private static func teardownLocatorRegression() throws {
        for declaration in ["    private func cancelCurrent() {",
                            "    private func cancelCurrent(preservingFluidCache: Bool = true) {"] {
            let found = try teardownDeclaration(in: declaration + "\n        lifetime.reset()\n    }\n")
            precondition(found != nil)
        }
        let ambiguous = try teardownDeclaration(in: "    private func cancelCurrent() {\n    private func cancelCurrent(flag: Bool) {\n")
        precondition(ambiguous == nil)
        print("PASS: teardown locator handles lifecycle parameters and rejects ambiguous declarations.")
    }

    @MainActor
    private static func teardownSourceOrdering() throws {
        let path = "mobile/ios/Assist/Voice/AssistVoice.swift"
        let source = try String(contentsOfFile: path, encoding: .utf8)
        guard let start = try teardownDeclaration(in: source),
              let end = source.range(of: "    private func fail(", range: start.upperBound..<source.endIndex)
        else { preconditionFailure("Cannot locate production teardown") }
        let body = String(source[start.upperBound..<end.lowerBound])
        guard let fence = body.range(of: "let shouldDeactivate = audioSessionOwnership.relinquish()") else {
            preconditionFailure("Production teardown must relinquish session ownership")
        }
        for boundary in ["stopSpeechOutput()", "stopCapture()", "recognitionTask?.cancel()", "AVAudioSession.sharedInstance().setActive(false"] {
            guard let call = body.range(of: boundary) else { preconditionFailure("Missing production teardown boundary") }
            precondition(fence.upperBound < call.lowerBound)
        }
        precondition(body.contains("if shouldDeactivate {"))
        print("PASS: the production cancelCurrent source relinquishes ownership before every notifying stop and uses its captured deactivation claim.")
    }

    @MainActor
    private static func offlineWiringAndConversion() throws {
        for rate in [44_100.0, 48_000.0] {
            let engine = AVAudioEngine()
            let ioFormat = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
            let renderFormat = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2)!
            // Enter offline mode BEFORE accessing any I/O node. Never instantiate
            // inputNode, enable VPIO, or render to a microphone/output device.
            try engine.enableManualRenderingMode(.offline, format: renderFormat, maximumFrameCount: 1_024)
            defer { engine.stop(); engine.disableManualRenderingMode() }
            let player = AVAudioPlayerNode()
            engine.attach(player)
            let mixer = engine.mainMixerNode
            let canonical = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
            engine.connect(player, to: mixer, format: canonical)
            // Reproduce the wiring gap: the implicit mixer→output starts with
            // stereo render format, incompatible with this mono I/O fixture.
            precondition(engine.outputNode.inputFormat(forBus: 0).channelCount != ioFormat.channelCount)
            try AssistVoiceIOWiring.connectOutput(engine: engine, mixer: mixer, format: ioFormat)
            precondition(mixer.outputFormat(forBus: 0) == ioFormat)
            precondition(engine.outputNode.inputFormat(forBus: 0) == ioFormat)
            precondition(player.outputFormat(forBus: 0) == canonical)
            let pcm = AVAudioPCMBuffer(pcmFormat: canonical, frameCapacity: 4_800)!
            pcm.frameLength = 4_800
            for index in 0..<4_800 { pcm.floatChannelData![0][index] = Float(sin(Double(index) * .pi / 24)) * 0.2 }
            player.scheduleBuffer(pcm)
            engine.prepare()
            try engine.start()
            player.play()
            let output = AVAudioPCMBuffer(pcmFormat: renderFormat, frameCapacity: 1_024)!
            let expected = Int(rate / 10)
            var rendered = 0, lastSignal = -1, attempts = 0
            while rendered < expected + 1_024 && attempts < 32 {
                attempts += 1
                let status = try engine.renderOffline(1_024, to: output)
                if status == .cannotDoInCurrentContext { continue }
                precondition(status == .success && output.frameLength > 0)
                for channel in 0..<Int(output.format.channelCount) {
                    for frame in 0..<Int(output.frameLength) {
                        let sample = output.floatChannelData![channel][frame]
                        precondition(sample.isFinite)
                        if abs(sample) > 0.000_01 { lastSignal = max(lastSignal, rendered + frame) }
                    }
                }
                rendered += Int(output.frameLength)
            }
            precondition(rendered >= expected + 1_024 && abs(lastSignal - expected) < 512)
            precondition(engine.outputNode.inputFormat(forBus: 0) == ioFormat && player.outputFormat(forBus: 0) == canonical)
        }
        print("PASS: shared production wiring fixes a real offline implicit-stereo/client-mono gap and renders canonical 48-kHz PCM through 44.1/48-kHz mono client formats.")
    }

    @MainActor
    private static func wiringSourceOrdering() throws {
        let source = try String(contentsOfFile: "mobile/ios/Assist/Voice/AssistVoice.swift", encoding: .utf8)
        guard let start = source.range(of: "    private func makeDuplexEngine(token: UUID) throws {"),
              let end = source.range(of: "    private func installRecognition(", range: start.upperBound..<source.endIndex)
        else { preconditionFailure("Cannot locate production wiring") }
        let body = String(source[start.upperBound..<end.lowerBound])
        let ordered = ["setVoiceProcessingEnabled(true)", "let mixer = engine.mainMixerNode",
                       "engine.connect(player, to: mixer, format: playbackFormat)",
                       "let ioFormat = engine.inputNode.outputFormat(forBus: 0)",
                       "AssistVoiceIOWiring.connectOutput(engine: engine, mixer: mixer, format: ioFormat)",
                       "installRecognition(on: engine, token: token, expectedFormat: ioFormat)",
                       "engine.prepare()", "try engine.start()"]
        var cursor = body.startIndex
        for call in ordered {
            guard let match = body.range(of: call, range: cursor..<body.endIndex) else { preconditionFailure("Production wiring order changed") }
            cursor = match.upperBound
        }
        print("PASS: actual production wiring selects the client format after VPIO/mixer/player, shares it with the tap, and connects before prepare/start.")
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
        routePolicy()
        teardownNotifications()
        try teardownLocatorRegression()
        try teardownSourceOrdering()
        try offlineWiringAndConversion()
        try wiringSourceOrdering()
        print("PASS: 25 native duplex checks; offline engines only are started; no microphone, hardware output, recognition or real TTS.")
    }
}
