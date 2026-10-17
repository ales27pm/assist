import AVFoundation
import Foundation
import Speech
import UIKit

/// A narrowly shared reference for Apple's documented audio-tap append pattern.
/// The reference never changes; append runs only on the tap, and the owner stops
/// the engine/removes that tap before ending or releasing the request. Remove
/// this wrapper once the Speech SDK declares the request's Sendable contract.
private final class AssistVoiceAudioSink: @unchecked Sendable {
    let request: SFSpeechAudioBufferRecognitionRequest
    let meter: AssistVoiceInputMeter
    init(_ request: SFSpeechAudioBufferRecognitionRequest, meter: AssistVoiceInputMeter) {
        self.request = request
        self.meter = meter
    }
    func append(_ buffer: AVAudioPCMBuffer) {
        meter.observe(buffer)
        request.append(buffer)
    }
}

/// Apple-only duplex speech. Session configuration, ownership and callbacks
/// are main-actor confined. The audio tap uses Apple's documented append API;
/// PCM buffers never cross into Swift tasks or JavaScript.
@MainActor
@objc(AssistVoice)
final class AssistVoice: NSObject, AVSpeechSynthesizerDelegate {
    private let locale = Locale(identifier: "fr-CA")
    private let synthesizer = AVSpeechSynthesizer()
    private var recognizer: SFSpeechRecognizer?
    private var audioEngine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var finishingTask: Task<Void, Never>?
    private var inputTask: Task<Void, Never>?
    private var inputMeter: AssistVoiceInputMeter?
    private var inputStartedAt: ContinuousClock.Instant?
    private var inputStoppedAt: ContinuousClock.Instant?
    private var inputPort = ""
    private var lastInputDiagnostics: [String: Any]?
    private var observers: [NSObjectProtocol] = []
    private var eventHandler: ((String) -> Void)?
    private var startCompletion: ((String?, NSError?) -> Void)?
    private var pendingForegroundAction: (() -> Void)?
    private var phase = "idle"
    private var sessionId: String?
    private var lifetime = AssistVoiceDuplexLifetime()
    private var generation: UUID { lifetime.recognition }
    private var speechGeneration: UUID { lifetime.playback }
    private var player: AVAudioPlayerNode?
    private var retainedInputTask: Task<Void, Never>?
    private var cachedRecognition: AssistVoiceRecognitionSnapshot?
    private var monitorRetry = AssistVoiceMonitorRetry()
    private var monitorRetryTask: Task<Void, Never>?
    private var pendingAudioError: String?
    private var routeBaseline: AssistVoiceRouteBaseline?
    private var ownedCategoryTransition: (generation: UUID, value: AssistVoiceOwnedCategoryTransition)?
    private var tapInputFormat: AssistVoiceRouteFormat?
    private var configuringGeneration: UUID?
    private var pendingRouteChecks: [(reason: UInt?, previous: AssistVoiceRouteIdentity?, current: AssistVoiceRouteIdentity)] = []
    private var routeProgressTask: Task<Void, Never>?
    private var routeProgress = AssistVoiceRouteProgressWatch()
    private var audioDiagnostics = AssistVoiceAudioDiagnostics()
    private var lastMonitoring = false
    private var queuedSpeech: [(identifier: UUID, text: String)] = []
    private var queuedSpeechBytes = 0
    private var currentUtterance: AssistVoiceUtterance?
    private var producerWatchdogTask: Task<Void, Never>?
    private var pcmTransfer: AssistVoicePCMTransfer?
    private var pcmConverter: AssistVoicePCMConverter?
    private var pcmDrain = AssistVoicePlaybackDrain()
    private var pcmMessages: [Int: AssistVoicePCMMessage] = [:]
    private var nextPCMSequence = 0
    private var latestTranscript = ""
    private var speechQueue = AssistVoiceSpeechQueue()
    private var speechVoice: AVSpeechSynthesisVoice?
    private var hasTap = false
    private var audioSessionActive = false
    private var invalidated = false

    override init() {
        super.init()
        if let candidate = SFSpeechRecognizer(locale: locale),
           candidate.locale.identifier.replacingOccurrences(of: "_", with: "-").lowercased() == "fr-ca" {
            recognizer = candidate
        }
        synthesizer.delegate = self
        observe(UIApplication.willResignActiveNotification)
        observe(UIApplication.didEnterBackgroundNotification)
        observe(UIApplication.didBecomeActiveNotification)
        observe(AVAudioSession.interruptionNotification)
        observe(AVAudioSession.routeChangeNotification)
    }

    @objc(setEventHandler:)
    func setEventHandler(_ handler: @escaping (String) -> Void) {
        eventHandler = handler
    }

    /// Querying capabilities must never request either privacy permission.
    @objc(status:)
    func status(_ completion: (String?, NSError?) -> Void) {
        completion(statusJSON(), nil)
    }

    @objc(getVoicePreferences:)
    func getVoicePreferences(_ completion: (String?, NSError?) -> Void) {
        let value = UserDefaults.standard.object(forKey: "assist.voice.readResponses") as? Bool ?? true
        completion(encode(["readResponses": value]), nil)
    }

    @objc(setVoicePreferences:completion:)
    func setVoicePreferences(_ readResponses: Bool, completion: (String?, NSError?) -> Void) {
        UserDefaults.standard.set(readResponses, forKey: "assist.voice.readResponses")
        completion(encode(["readResponses": readResponses]), nil)
    }

    @objc(startListening:completion:)
    func startListening(_ id: String, completion: @escaping (String?, NSError?) -> Void) {
        guard !invalidated else { completion(nil, Self.error("E_VOICE_INVALIDATED", "La voix est fermée.")); return }
        guard UIApplication.shared.applicationState == .active else {
            completion(nil, Self.error("E_VOICE_BACKGROUND", "Reviens dans Assist pour commencer une dictée.")); return
        }
        guard validID(id) else { completion(nil, Self.error("E_VOICE_ID", "Identifiant vocal invalide.")); return }
        guard phase == "idle" || phase == "speaking" else {
            completion(nil, Self.error("E_VOICE_BUSY", "Une dictée est déjà en cours.")); return
        }
        if let pendingAudioError {
            completion(nil, Self.error("E_VOICE_INTERRUPTED", pendingAudioError)); return
        }
        guard recognizer?.supportsOnDeviceRecognition == true, recognizer?.isAvailable == true else {
            completion(nil, Self.error("E_VOICE_UNAVAILABLE", "La dictée locale en français canadien est indisponible sur cet appareil.")); return
        }
        audioDiagnostics = AssistVoiceAudioDiagnostics()
        if adoptRetainedInput(id, completion: completion) { return }
        cancelCurrent()
        let token = generation
        sessionId = id
        latestTranscript = ""
        inputMeter = nil
        inputStartedAt = nil
        inputStoppedAt = nil
        lastInputDiagnostics = nil
        startCompletion = completion
        phase = "requesting"
        emitState()
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: requestMicrophone(token)
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization(AssistVoiceCallbacks.authorization { [weak self] allowed in
                guard let self, self.generation == token, self.phase == "requesting" else { return }
                if allowed { self.requestMicrophone(token) }
                else { self.fail("La permission de reconnaissance vocale est requise.", code: "E_VOICE_SPEECH_PERMISSION") }
            })
        default: fail("La permission de reconnaissance vocale est refusée. Autorise-la dans les réglages iOS.", code: "E_VOICE_SPEECH_PERMISSION")
        }
    }

    @objc(stopListening:)
    func stopListening(_ completion: (String?, NSError?) -> Void) {
        if phase == "requesting" { cancelCurrent() }
        else if phase == "listening" {
            stopCapture()
            phase = "finishing"
            request?.endAudio()
            emitState()
            let token = generation
            // Apple's final callback is not guaranteed after audio/route failures.
            // Always leave finishing, even if no final result arrives.
            finishingTask = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                guard let self, self.generation == token, self.phase == "finishing" else { return }
                self.finishRecognition()
            }
        }
        completion(statusJSON(), nil)
    }

    @objc(cancel:)
    func cancel(_ completion: (String?, NSError?) -> Void) {
        // Muting and invalidating callback identities happens before settlement.
        cancelCurrent()
        completion(statusJSON(), nil)
    }

    @objc(speak:utteranceId:completion:)
    func speak(_ text: String, utteranceId id: String, completion: (String?, NSError?) -> Void) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf8.count <= 2_400 else {
            completion(nil, Self.error("E_VOICE_TEXT", "Le texte de lecture est vide ou dépasse la capacité du lecteur local.")); return
        }
        beginSpeech(id) { value, error in
            guard error == nil else { completion(value, error); return }
            enqueueSpeech(text, utteranceId: id) { value, error in
                guard error == nil else { cancelCurrent(); completion(value, error); return }
                finishSpeech(id, completion: completion)
            }
        }
    }

    @objc(beginSpeech:completion:)
    func beginSpeech(_ id: String, completion: (String?, NSError?) -> Void) {
        guard !invalidated else { completion(nil, Self.error("E_VOICE_INVALIDATED", "La voix est fermée.")); return }
        guard UIApplication.shared.applicationState == .active else {
            completion(nil, Self.error("E_VOICE_BACKGROUND", "Reviens dans Assist pour commencer une lecture.")); return
        }
        guard validID(id), phase == "idle" || phase == "speaking" else {
            completion(nil, Self.error("E_VOICE_BUSY", "Termine la dictée avant la lecture.")); return
        }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized,
              AVAudioApplication.shared.recordPermission == .granted,
              recognizer?.supportsOnDeviceRecognition == true, recognizer?.isAvailable == true else {
            completion(nil, Self.error("E_VOICE_PERMISSION", "Autorise la dictée locale et le microphone avant le mode vocal.")); return
        }
        guard let voice = canadianVoice() else {
            completion(nil, Self.error("E_VOICE_UNAVAILABLE", "Installe une voix française canadienne dans les réglages de parole iOS.")); return
        }
        cancelCurrent()
        audioDiagnostics = AssistVoiceAudioDiagnostics()
        sessionId = id
        speechVoice = voice
        latestTranscript = ""
        cachedRecognition = nil
        monitorRetry = AssistVoiceMonitorRetry()
        do {
            try activateAudioSession()
            try makeDuplexEngine(token: generation)
            speechQueue.begin(generation: speechGeneration)
            phase = "speaking"
            lastMonitoring = isMonitoring
            emitState()
            completion(statusJSON(), nil)
        } catch {
            let code = (error as NSError).userInfo["code"] as? String == "E_VOICE_INTERRUPTED" ? "E_VOICE_INTERRUPTED" : "E_VOICE_AEC"
            let message = "La conversation avec annulation d’écho n’a pas pu démarrer : \(error.localizedDescription)"
            fail(message, code: code)
            completion(nil, Self.error(code, message))
        }
    }

    @objc(enqueueSpeech:utteranceId:completion:)
    func enqueueSpeech(_ text: String, utteranceId id: String, completion: (String?, NSError?) -> Void) {
        guard phase == "speaking", sessionId == id, speechVoice != nil else {
            completion(nil, Self.error("E_VOICE_STALE", "Cette lecture n’est plus active.")); return
        }
        let bytes = text.utf8.count
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              bytes <= 2_400, speechQueue.pendingCount < 64,
              queuedSpeechBytes <= 32_768 - bytes, let identifier = speechQueue.enqueue() else {
            completion(nil, Self.error("E_VOICE_TEXT", "Ce segment vocal dépasse la capacité du lecteur local.")); return
        }
        queuedSpeech.append((identifier, text))
        queuedSpeechBytes += bytes
        pumpSpeech()
        completion(statusJSON(), nil)
    }

    @objc(finishSpeech:completion:)
    func finishSpeech(_ id: String, completion: (String?, NSError?) -> Void) {
        guard phase == "speaking", sessionId == id else {
            completion(nil, Self.error("E_VOICE_STALE", "Cette lecture n’est plus active.")); return
        }
        if speechQueue.finishInput() { finishSpeechNaturally() }
        completion(statusJSON(), nil)
    }

    private func activateAudioSession() throws {
        let audio = AVAudioSession.sharedInstance()
        let token = generation
        let before = Self.routeIdentity(audio.currentRoute)
        try audio.setCategory(.playAndRecord, mode: .voiceChat,
                              options: [.defaultToSpeaker, .duckOthers])
        let categoryRoute = Self.routeIdentity(audio.currentRoute)
        try audio.setActive(true)
        guard generation == token, UIApplication.shared.applicationState == .active else {
            try? audio.setActive(false, options: [.notifyOthersOnDeactivation])
            throw Self.error("E_VOICE_INTERRUPTED", "Le démarrage audio a été interrompu.")
        }
        ownedCategoryTransition = (generation, AssistVoiceOwnedCategoryTransition(
            previous: [before, categoryRoute], target: Self.routeIdentity(audio.currentRoute)))
        audioSessionActive = true
    }

    private var isMonitoring: Bool {
        phase == "speaking" && hasTap && request != nil &&
        recognitionTask?.state == .running && audioEngine?.isRunning == true &&
        audioEngine?.inputNode.isVoiceProcessingEnabled == true
    }

    private func pumpSpeech() {
        guard phase == "speaking", currentUtterance == nil,
              !queuedSpeech.isEmpty, let voice = speechVoice else { return }
        let item = queuedSpeech.removeFirst()
        queuedSpeechBytes -= item.text.utf8.count
        let token = speechGeneration
        let utterance = AssistVoiceUtterance(text: item.text, generation: token, identifier: item.identifier)
        utterance.voice = voice
        currentUtterance = utterance
        pcmConverter = AssistVoicePCMConverter()
        pcmDrain.begin(item.identifier)
        nextPCMSequence = 0
        pcmMessages.removeAll(keepingCapacity: true)
        let transfer = AssistVoicePCMTransfer { [weak self] message in
            self?.receivePCM(message, generation: token, utterance: item.identifier)
        }
        pcmTransfer = transfer
        synthesizer.write(utterance, toBufferCallback: transfer.callback())
    }

    private func receivePCM(_ message: AssistVoicePCMMessage, generation token: UUID, utterance: UUID) {
        guard token == speechGeneration, phase == "speaking",
              currentUtterance?.identifier == utterance, let transfer = pcmTransfer else { return }
        if case .failure(let message) = message {
            fail(message, code: "E_VOICE_PCM"); return
        }
        guard let index = message.sequence, index >= nextPCMSequence,
              pcmMessages[index] == nil, pcmMessages.count < AssistVoicePCMTransfer.maximumPackets else {
            transfer.release(message.reservedBytes)
            fail("L’ordre des tampons de synthèse est invalide.", code: "E_VOICE_PCM"); return
        }
        pcmMessages[index] = message
        while let next = pcmMessages.removeValue(forKey: nextPCMSequence) {
            nextPCMSequence += 1
            do {
                switch next {
                case .samples(_, let values, let sampleRate, let bytes):
                    guard !pcmDrain.productionEnded else { throw Self.error("E_VOICE_PCM", "Audio reçu après la fin du segment.") }
                    if let output = try pcmConverter?.convert(values, sampleRate: sampleRate) {
                        try schedulePCM(output, reservedBytes: bytes, transfer: transfer, token: token, utterance: utterance)
                    } else { transfer.release(bytes) }
                case .end:
                    if !pcmDrain.productionEnded {
                        producerWatchdogTask?.cancel()
                        producerWatchdogTask = nil
                        for tail in try pcmConverter?.finish() ?? [] {
                            try schedulePCM(tail, reservedBytes: 0, transfer: transfer, token: token, utterance: utterance)
                        }
                        pcmDrain.finishProduction()
                        completeUtteranceIfDrained()
                    }
                case .failure: break
                }
            } catch {
                transfer.release(next.reservedBytes)
                fail("La lecture du segment audio a échoué : \(error.localizedDescription)", code: "E_VOICE_PCM")
                return
            }
        }
    }

    private func schedulePCM(
        _ buffer: AVAudioPCMBuffer, reservedBytes: Int, transfer: AssistVoicePCMTransfer,
        token: UUID, utterance: UUID
    ) throws {
        let identifier = UUID()
        guard let player, pcmDrain.schedule(identifier, frames: Int(buffer.frameLength)) else {
            throw Self.error("E_VOICE_PCM", "La file audio locale dépasse quinze secondes.")
        }
        let completion = AssistVoiceCallbacks.playback(release: { transfer.release(reservedBytes) }) { [weak self] in
            guard let self, self.speechGeneration == token,
                  self.phase == "speaking", self.currentUtterance?.identifier == utterance else { return }
            _ = self.pcmDrain.didPlay(identifier)
            self.completeUtteranceIfDrained()
        }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack, completionHandler: completion)
        if !player.isPlaying { player.play() }
    }

    private func completeUtteranceIfDrained() {
        guard phase == "speaking", pcmDrain.isComplete, let utterance = currentUtterance else { return }
        currentUtterance = nil
        pcmTransfer?.invalidate()
        pcmTransfer = nil
        pcmConverter = nil
        pcmDrain.cancel()
        if speechQueue.didFinish(identifier: utterance.identifier, generation: speechGeneration) {
            finishSpeechNaturally()
        } else { pumpSpeech() }
    }

    /// Invalidate BEFORE stop: AVAudioPlayerNode invokes completions when it
    /// discards scheduled buffers too. Those callbacks must never mean played.
    private func stopSpeechOutput(retainingInput: Bool = false) {
        lifetime.retirePlayback(retainingInput: retainingInput)
        producerWatchdogTask?.cancel()
        producerWatchdogTask = nil
        pcmTransfer?.invalidate()
        for message in pcmMessages.values { pcmTransfer?.release(message.reservedBytes) }
        pcmMessages.removeAll(keepingCapacity: true)
        currentUtterance = nil
        pcmTransfer = nil
        pcmConverter = nil
        pcmDrain.cancel()
        queuedSpeech.removeAll(keepingCapacity: true)
        queuedSpeechBytes = 0
        speechQueue.cancel()
        speechVoice = nil
        player?.volume = 0
        player?.stop()
        synthesizer.stopSpeaking(at: .immediate)
    }

    private func finishSpeechNaturally() {
        guard phase == "speaking" else { return }
        let retain = request != nil && recognitionTask != nil && audioEngine?.isRunning == true
        stopSpeechOutput(retainingInput: retain)
        phase = "idle"
        lastMonitoring = false
        emitState()
        sessionId = nil
        guard retain else { cancelCurrent(); return }
        let token = generation
        // Preserve an onset whose first STT partial trails the final speaker PCM.
        // The next startListening adopts this same request/task. Never run idle
        // microphone monitoring indefinitely if JS does not adopt it.
        retainedInputTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            guard let self, self.generation == token, self.lifetime.retained, self.phase == "idle" else { return }
            self.cancelCurrent()
        }
    }

    private func adoptRetainedInput(_ id: String, completion: (String?, NSError?) -> Void) -> Bool {
        guard phase == "idle", request != nil, audioEngine?.isRunning == true,
              lifetime.adoptInput() else { return false }
        retainedInputTask?.cancel()
        retainedInputTask = nil
        sessionId = id
        phase = "listening"
        lastMonitoring = false
        emitState()
        if let cachedRecognition { receiveCapture(cachedRecognition) }
        completion(statusJSON(), nil)
        return true
    }

    @objc func invalidate() {
        invalidated = true
        cancelCurrent()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        synthesizer.delegate = nil
        eventHandler = nil
    }

    private func requestMicrophone(_ token: UUID) {
        guard generation == token, phase == "requesting", !invalidated else { return }
        guard UIApplication.shared.applicationState == .active else {
            pendingForegroundAction = { [weak self] in self?.requestMicrophone(token) }
            return
        }
        switch AVAudioApplication.shared.recordPermission {
        case .granted: beginCapture(token)
        case .undetermined:
            AVAudioApplication.requestRecordPermission(completionHandler: AssistVoiceCallbacks.microphone { [weak self] allowed in
                guard let self, self.generation == token, self.phase == "requesting" else { return }
                if allowed { self.beginCapture(token) }
                else { self.fail("La permission du microphone est requise.", code: "E_VOICE_MIC_PERMISSION") }
            })
        default: fail("La permission du microphone est refusée. Autorise-la dans les réglages iOS.", code: "E_VOICE_MIC_PERMISSION")
        }
    }

    private func beginCapture(_ token: UUID) {
        guard generation == token, phase == "requesting", !invalidated else { return }
        guard UIApplication.shared.applicationState == .active else {
            pendingForegroundAction = { [weak self] in self?.beginCapture(token) }
            return
        }
        do {
            try activateAudioSession()
            try makeDuplexEngine(token: token)
            phase = "listening"
            emitState()
            settleStart(statusJSON(), nil)
        } catch {
            let code = (error as NSError).userInfo["code"] as? String == "E_VOICE_INTERRUPTED" ? "E_VOICE_INTERRUPTED" : "E_VOICE_AEC"
            fail("Le microphone avec annulation d’écho n’a pas pu démarrer : \(error.localizedDescription)", code: code)
        }
    }

    private func makeDuplexEngine(token: UUID) throws {
        guard generation == token, audioSessionActive, UIApplication.shared.applicationState == .active else {
            throw Self.error("E_VOICE_INTERRUPTED", "Le démarrage audio a été interrompu.")
        }
        configuringGeneration = token
        pendingRouteChecks.removeAll(keepingCapacity: true)
        defer {
            if configuringGeneration == token { configuringGeneration = nil }
            pendingRouteChecks.removeAll(keepingCapacity: true)
        }
        let engine = AVAudioEngine()
        var graphCommitted = false
        defer {
            // start() may complete after a reentrant cancellation released the
            // owner's reference. Stop this local instance on every failed build.
            if !graphCommitted { engine.stop() }
        }
        audioEngine = engine
        let player = AVAudioPlayerNode()
        self.player = player
        engine.attach(player)
        // Voice processing changes BOTH I/O nodes and must be enabled stopped.
        // All synthesized audio renders through this same VPIO output reference.
        try engine.inputNode.setVoiceProcessingEnabled(true)
        guard generation == token, audioEngine === engine, audioSessionActive,
              UIApplication.shared.applicationState == .active else {
            throw Self.error("E_VOICE_INTERRUPTED", "Le démarrage audio a été interrompu.")
        }
        guard engine.inputNode.isVoiceProcessingEnabled, engine.outputNode.isVoiceProcessingEnabled else {
            throw Self.error("E_VOICE_AEC", "Le traitement vocal avec annulation d’écho est indisponible.")
        }
        let playbackFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
        guard generation == token, audioEngine === engine, audioSessionActive,
              UIApplication.shared.applicationState == .active else {
            throw Self.error("E_VOICE_INTERRUPTED", "Le démarrage audio a été interrompu.")
        }
        try installRecognition(on: engine, token: token)
        guard generation == token, audioEngine === engine, audioSessionActive,
              UIApplication.shared.applicationState == .active else {
            throw Self.error("E_VOICE_INTERRUPTED", "Le démarrage audio a été interrompu.")
        }
        engine.prepare()
        try engine.start()
        guard generation == token, audioEngine === engine, audioSessionActive,
              UIApplication.shared.applicationState == .active else {
            throw Self.error("E_VOICE_INTERRUPTED", "Le démarrage audio a été interrompu.")
        }
        let committed = routeFacts(reason: 8, previous: nil, constructing: false)
        routeBaseline = AssistVoiceRouteBaseline(route: committed.current, input: committed.input,
                                                output: committed.output, player: committed.player)
        configuringGeneration = nil
        let health = routeFacts(reason: 8, previous: nil, constructing: false)
        guard health.decision == .accept else {
            recordRoute(health, source: "graph", decision: "failed-commit")
            throw Self.error("E_VOICE_AEC", "Le graphe audio avec annulation d’écho est inutilisable.")
        }
        recordRoute(health, source: "graph", decision: "committed")
        // Reentrant configuration notices may arrive before start returns. They
        // are checked against the committed graph, never ignored for a duration.
        for pending in pendingRouteChecks {
            let facts = routeFacts(reason: pending.reason, previous: pending.previous, constructing: false)
            guard generation == token, facts.current == pending.current, facts.decision == .accept else {
                recordRoute(facts, source: "route", decision: "failed-deferred")
                throw Self.error("E_VOICE_INTERRUPTED", "Le périphérique audio a changé pendant le démarrage.")
            }
            recordRoute(facts, source: "route", decision: "accepted-deferred")
            watchRouteProgress()
        }
        graphCommitted = true
    }

    private func installRecognition(on engine: AVAudioEngine, token: UUID) throws {
        guard generation == token, audioEngine === engine, audioSessionActive,
              UIApplication.shared.applicationState == .active else {
            throw Self.error("E_VOICE_INTERRUPTED", "La session de reconnaissance a été annulée.")
        }
        guard let recognizer, recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else {
            throw Self.error("E_VOICE_UNAVAILABLE", "La dictée locale fr-CA est indisponible.")
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw Self.error("E_VOICE_AUDIO", "Aucune entrée microphone n’est disponible.")
        }
        tapInputFormat = Self.routeFormat(format)
        let localRequest = SFSpeechAudioBufferRecognitionRequest()
        localRequest.requiresOnDeviceRecognition = true
        localRequest.shouldReportPartialResults = true
        localRequest.taskHint = .dictation
        let meter = AssistVoiceInputMeter()
        inputMeter = meter
        inputStartedAt = .now
        inputStoppedAt = nil
        lastInputDiagnostics = nil
        inputPort = AVAudioSession.sharedInstance().currentRoute.inputs.first?.portType.rawValue ?? "none"
        let sink = AssistVoiceAudioSink(localRequest, meter: meter)
        request = localRequest
        recognitionTask = recognizer.recognitionTask(with: localRequest, resultHandler: AssistVoiceCallbacks.recognition { [weak self] snapshot in
            guard let self, self.generation == token else { return }
            self.receiveRecognition(snapshot)
        })
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: AssistVoiceCallbacks.audioTap { buffer in
            sink.append(buffer)
        })
        hasTap = true
        inputTask?.cancel()
        inputTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                guard let self, self.generation == token,
                      self.phase == "listening" || self.phase == "speaking" || self.lifetime.retained else { return }
                self.captureInputDiagnostics()
                if self.phase == "listening" { self.emit(kind: "input") }
                if self.phase == "speaking", self.lastMonitoring != self.isMonitoring {
                    self.lastMonitoring = self.isMonitoring
                    self.emitState()
                }
            }
        }
    }

    private func receiveRecognition(_ snapshot: AssistVoiceRecognitionSnapshot) {
        if phase == "speaking" {
            if AssistVoiceDuplexLifetime.containsSpeechText(snapshot.text) {
                // No RMS-only trigger. The same local request/task already owns
                // the utterance onset, so promotion never drops its first audio.
                promoteInterruption()
                receiveCapture(snapshot)
            } else if snapshot.isFinal || (snapshot.errorDomain == "kAFAssistantErrorDomain" && snapshot.errorCode == 1110) {
                rearmMonitor()
            } else if snapshot.message != nil {
                fail("La surveillance vocale locale s’est arrêtée. Reprends le mode vocal.", code: "E_VOICE_MONITOR")
            }
            return
        }
        if phase == "idle", lifetime.retained {
            cachedRecognition = snapshot
            if let text = snapshot.text { latestTranscript = text }
            if !AssistVoiceDuplexLifetime.containsSpeechText(latestTranscript) && (snapshot.isFinal || snapshot.message != nil) {
                cancelCurrent()
            }
            return
        }
        if phase == "listening" || phase == "finishing" { receiveCapture(snapshot) }
    }

    private func receiveCapture(_ snapshot: AssistVoiceRecognitionSnapshot) {
        guard phase == "listening" || phase == "finishing" else { return }
        if let text = snapshot.text {
            latestTranscript = text
            emit(kind: "transcript", text: text, isFinal: snapshot.isFinal)
        }
        if snapshot.isFinal { finishRecognition(emitFinal: false) }
        else if snapshot.message != nil {
            captureInputDiagnostics(errorDomain: snapshot.errorDomain, errorCode: snapshot.errorCode)
            let observation = inputMeter?.snapshot()
            let message: String
            if observation?.frameCount == 0 {
                message = "Le microphone n’a transmis aucun audio. Réessaie la dictée."
            } else if let observation, observation.measuredSampleCount > 0, observation.peak < 0.000_01 {
                message = "Le micro reçoit un signal presque silencieux. Vérifie son entrée, puis réessaie."
            } else if snapshot.errorDomain == "kAFAssistantErrorDomain", snapshot.errorCode == 1110 {
                message = "La dictée locale n’a reconnu aucune parole. Réessaie en parlant après le démarrage du micro."
            } else {
                message = "La reconnaissance locale s’est arrêtée. Ton texte est conservé; tu peux réessayer."
            }
            fail(message, code: "E_VOICE_RECOGNITION")
        }
    }

    private func promoteInterruption() {
        guard phase == "speaking", let interrupted = sessionId else { return }
        let newCapture = "capture-" + UUID().uuidString
        // Preserve the ASR token, request, task, tap and engine. Retire output
        // identities before stopping, because stop also invokes PCM completions.
        stopSpeechOutput()
        phase = "listening"
        lastMonitoring = false
        sessionId = newCapture
        eventHandler?(encode([
            "sessionId": interrupted, "captureSessionId": newCapture,
            "kind": "interruption", "phase": "listening", "monitoring": false
        ]))
        emitState()
    }

    private func rearmMonitor() {
        guard phase == "speaking", let engine = audioEngine else { return }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized,
              AVAudioApplication.shared.recordPermission == .granted,
              let delay = monitorRetry.reserve(now: Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000) else {
            fail("La surveillance vocale locale s’est arrêtée. Reprends le mode vocal.", code: "E_VOICE_MONITOR")
            return
        }
        inputTask?.cancel()
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        recognitionTask?.cancel()
        recognitionTask = nil
        request = nil
        let recheckRouteProgress = routeProgressTask != nil
        routeProgressTask?.cancel()
        routeProgressTask = nil
        routeProgress.cancel()
        lifetime.rearmRecognition()
        lastMonitoring = false
        emitState()
        let token = generation
        let outputToken = speechGeneration
        monitorRetryTask = Task { @MainActor [weak self] in
            if delay > 0 {
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            }
            guard let self, self.generation == token, self.speechGeneration == outputToken,
                  self.phase == "speaking", self.audioEngine === engine else { return }
            do {
                try self.installRecognition(on: engine, token: token)
                // A new tap replaces the meter. Preserve a pending route check
                // against its counters instead of dropping it with the old ASR.
                if recheckRouteProgress || self.routeProgressTask != nil { self.watchRouteProgress() }
            }
            catch { self.fail("La surveillance vocale locale n’a pas pu redémarrer.", code: "E_VOICE_MONITOR") }
        }
    }

    private func finishRecognition(emitFinal: Bool = true) {
        guard phase == "listening" || phase == "finishing" else { return }
        if emitFinal { emit(kind: "transcript", text: latestTranscript, isFinal: true) }
        cancelCurrent()
    }

    private func stopCapture() {
        inputTask?.cancel()
        inputTask = nil
        audioEngine?.stop()
        if hasTap { audioEngine?.inputNode.removeTap(onBus: 0); hasTap = false }
        if inputStartedAt != nil, inputStoppedAt == nil { inputStoppedAt = .now }
        captureInputDiagnostics()
    }

    private func cancelCurrent() {
        lifetime.reset()
        routeProgressTask?.cancel()
        routeProgressTask = nil
        routeProgress.cancel()
        routeBaseline = nil
        ownedCategoryTransition = nil
        tapInputFormat = nil
        configuringGeneration = nil
        pendingRouteChecks.removeAll(keepingCapacity: true)
        stopSpeechOutput()
        pendingAudioError = nil
        monitorRetryTask?.cancel()
        monitorRetryTask = nil
        retainedInputTask?.cancel()
        retainedInputTask = nil
        cachedRecognition = nil
        pendingForegroundAction = nil
        finishingTask?.cancel()
        finishingTask = nil
        stopCapture()
        recognitionTask?.cancel()
        recognitionTask = nil
        request = nil
        audioEngine = nil
        player = nil
        lastMonitoring = false
        if audioSessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
            audioSessionActive = false
        }
        phase = "idle"
        settleStart(nil, Self.error("E_VOICE_CANCELLED", "La dictée a été annulée."))
        emitState()
        sessionId = nil
    }

    private func fail(_ message: String, code: String) {
        emit(kind: "error", message: message)
        settleStart(nil, Self.error(code, message))
        cancelCurrent()
    }

    private func settleStart(_ value: String?, _ error: NSError?) {
        let completion = startCompletion
        startCompletion = nil
        completion?(value, error)
    }

    private func observe(_ name: Notification.Name) {
        observers.append(NotificationCenter.default.addObserver(
            forName: name, object: nil, queue: .main,
            using: Self.mainNotificationHandler(owner: self, name: name)
        ))
    }

    nonisolated private static func mainNotificationHandler(
        owner: AssistVoice, name: Notification.Name
    ) -> @Sendable (Notification) -> Void {
        { [weak owner] notification in
            let routeReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            let interruptionType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let previousRoute = notification.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
            let previous = previousRoute.map(Self.routeIdentity)
            // This observer explicitly runs on the main operation queue. Handle
            // it synchronously so an old route event cannot stop a newer turn.
            MainActor.assumeIsolated { [weak owner] in
                owner?.handleNotification(name, routeReason: routeReason, interruptionType: interruptionType, previous: previous)
            }
        }
    }

    private func handleNotification(
        _ name: Notification.Name, routeReason: UInt?, interruptionType: UInt?, previous: AssistVoiceRouteIdentity?
    ) {
        if name == UIApplication.didBecomeActiveNotification {
            let action = pendingForegroundAction
            pendingForegroundAction = nil
            if phase == "requesting" { action?() }
            return
        }
        // Permission sheets may deactivate the app; actual background cancels.
        if name == UIApplication.willResignActiveNotification && phase == "requesting" { return }
        guard phase != "idle" || lifetime.retained || configuringGeneration != nil else { return }
        if name == AVAudioSession.routeChangeNotification {
            guard audioSessionActive else { return }
            let facts = routeFacts(reason: routeReason, previous: previous,
                                   constructing: configuringGeneration == generation)
            let decision = facts.decision
            recordRoute(facts, source: "route", decision: decision.rawValue)
            switch decision {
            case .accept:
                watchRouteProgress()
                emitState()
            case .deferUntilCommit:
                guard pendingRouteChecks.count < 8 else { failAudioInterruption(); return }
                pendingRouteChecks.append((routeReason, previous, facts.current))
            case .fail: failAudioInterruption()
            }
            return
        }
        if name == AVAudioSession.interruptionNotification {
            guard audioSessionActive else { return }
            let ended = interruptionType == AVAudioSession.InterruptionType.ended.rawValue
            recordRoute(routeFacts(reason: interruptionType, previous: nil, constructing: false),
                        source: "interruption", decision: ended ? "ended-no-resume" : "fail")
            if !ended { failAudioInterruption() }
            return
        }
        recordRoute(routeFacts(reason: nil, previous: nil, constructing: false), source: "lifecycle", decision: "cancel")
        cancelCurrent()
    }

    private func failAudioInterruption() {
        if lifetime.retained {
            cancelCurrent()
            pendingAudioError = "Le périphérique audio a changé ou la session a été interrompue. Reprends le mode vocal."
            return
        }
        fail("La session audio a été interrompue ou son périphérique a changé. Relance le mode vocal.",
             code: "E_VOICE_INTERRUPTED")
    }

    private nonisolated static func routeIdentity(_ route: AVAudioSessionRouteDescription) -> AssistVoiceRouteIdentity {
        AssistVoiceRouteIdentity(inputs: route.inputs.map { .init(type: $0.portType.rawValue, uid: $0.uid) },
                                 outputs: route.outputs.map { .init(type: $0.portType.rawValue, uid: $0.uid) })
    }

    private static func routeFormat(_ format: AVAudioFormat?) -> AssistVoiceRouteFormat {
        AssistVoiceRouteFormat(rate: format?.sampleRate ?? 0, channels: Int(format?.channelCount ?? 0),
                               commonFormat: format?.commonFormat.rawValue ?? 0, interleaved: format?.isInterleaved ?? false)
    }

    private func routeFacts(reason: UInt?, previous: AssistVoiceRouteIdentity?, constructing: Bool) -> AssistVoiceRouteFacts {
        let session = AVAudioSession.sharedInstance()
        return AssistVoiceRouteFacts(
            reason: reason, previous: previous, current: Self.routeIdentity(session.currentRoute), baseline: routeBaseline,
            ownedCategoryTransition: ownedCategoryTransition?.generation == generation ? ownedCategoryTransition?.value : nil,
            input: Self.routeFormat(audioEngine?.inputNode.outputFormat(forBus: 0)),
            output: Self.routeFormat(audioEngine?.outputNode.inputFormat(forBus: 0)),
            player: Self.routeFormat(player?.outputFormat(forBus: 0)), tapInput: tapInputFormat,
            appActive: UIApplication.shared.applicationState == .active, sessionActive: audioSessionActive,
            expectedSessionConfiguration: session.category == .playAndRecord && session.mode == .voiceChat,
            constructing: constructing, engineRunning: audioEngine?.isRunning == true,
            inputVoiceProcessing: audioEngine?.inputNode.isVoiceProcessingEnabled == true,
            outputVoiceProcessing: audioEngine?.outputNode.isVoiceProcessingEnabled == true)
    }

    private func recordRoute(_ facts: AssistVoiceRouteFacts, source: String, decision: String) {
        let frames = inputMeter?.snapshot().frameCount ?? 0
        let reason = (source == "route" || source == "interruption") ? facts.reason.map(String.init) ?? "none" : "none"
        let previous = facts.previous?.diagnosticTypes ?? "none"
        let line = "source=\(source) reason=\(reason) phase=\(phase) ports=\(facts.current.diagnosticTypes) previous=\(previous) same=\(facts.samePorts) run=\(facts.engineRunning) vp=\(facts.inputVoiceProcessing)/\(facts.outputVoiceProcessing) in=\(facts.input.rate)/\(facts.input.channels) out=\(facts.output.rate)/\(facts.output.channels) pcm=\(frames) decision=\(decision)"
        audioDiagnostics.append(line)
    }

    private func watchRouteProgress() {
        guard let meter = inputMeter, let engine = audioEngine else { return }
        routeProgressTask?.cancel()
        let token = generation
        let identity = routeProgress.begin(frameCount: meter.snapshot().frameCount)
        routeProgressTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(1_500)) } catch { return }
            guard let self,
                  let progressed = self.routeProgress.progressed(identifier: identity, frameCount: meter.snapshot().frameCount)
            else { return }
            self.routeProgressTask = nil
            self.routeProgress.cancel()
            guard self.generation == token, self.audioEngine === engine,
                  self.inputMeter === meter, self.hasTap,
                  self.phase == "listening" || self.phase == "speaking" || self.lifetime.retained else { return }
            let facts = self.routeFacts(reason: 8, previous: nil, constructing: false)
            let decision = facts.decision != .accept ? "fail-health" : progressed ? "progress" : "fail-no-progress"
            self.recordRoute(facts, source: "pcm-watch", decision: decision)
            guard facts.decision == .accept, progressed else {
                self.failAudioInterruption()
                return
            }
            self.emitState()
        }
    }

    private func canadianVoice() -> AVSpeechSynthesisVoice? {
        // Never substitute a fr-FR/default voice for the requested dialect.
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.replacingOccurrences(of: "_", with: "-").lowercased() == "fr-ca" }
            .sorted { $0.quality.rawValue > $1.quality.rawValue }.first
    }

    private func statusJSON() -> String {
        let voice = canadianVoice()
        let speechPermission = SFSpeechRecognizer.authorizationStatus()
        let micPermission = AVAudioApplication.shared.recordPermission
        let recognitionAvailable = !invalidated && recognizer?.supportsOnDeviceRecognition == true &&
            recognizer?.isAvailable == true && speechPermission != .denied && speechPermission != .restricted && micPermission != .denied
        let synthesisAvailable = !invalidated && voice != nil
        var status: [String: Any] = [
            "available": recognitionAvailable && synthesisAvailable,
            "recognitionAvailable": recognitionAvailable, "synthesisAvailable": synthesisAvailable,
            "locale": "fr-CA", "phase": phase, "monitoring": isMonitoring
        ]
        if !audioDiagnostics.lines.isEmpty { status["audioDiagnostics"] = audioDiagnostics.lines }
        if let voice { status["voiceName"] = voice.name }
        if let lastInputDiagnostics { status["diagnostics"] = lastInputDiagnostics }
        if !recognitionAvailable { status["reason"] = "La dictée locale fr-CA ou ses permissions est indisponible. Aucun service distant ne sera utilisé." }
        else if !synthesisAvailable { status["reason"] = "Installe une voix française canadienne dans les réglages de parole iOS." }
        return encode(status)
    }

    private func emitState() { emit(kind: "state") }

    private func captureInputDiagnostics(errorDomain: String? = nil, errorCode: Int? = nil) {
        guard let meter = inputMeter else { return }
        let value = meter.snapshot()
        let elapsed = inputStartedAt?.duration(to: inputStoppedAt ?? .now).components
        let elapsedMs = elapsed.map { Double($0.seconds) * 1_000 + Double($0.attoseconds) / 1e15 } ?? 0
        var diagnostics: [String: Any] = [
            "bufferCount": value.bufferCount, "frameCount": value.frameCount,
            "sampleRate": value.sampleRate, "channels": value.channelCount,
            "peak": value.peak, "level": value.recentPeak,
            "measured": value.measuredSampleCount > 0,
            "elapsedMs": max(0, elapsedMs), "inputPort": inputPort
        ]
        if let delay = value.firstBufferDelayMs { diagnostics["firstBufferDelayMs"] = delay }
        if let domain = errorDomain ?? lastInputDiagnostics?["errorDomain"] as? String {
            diagnostics["errorDomain"] = domain
        }
        if let code = errorCode ?? lastInputDiagnostics?["errorCode"] as? Int {
            diagnostics["errorCode"] = code
        }
        lastInputDiagnostics = diagnostics
    }

    private func emit(kind: String, text: String? = nil, isFinal: Bool? = nil, message: String? = nil) {
        guard let sessionId else { return }
        var event: [String: Any] = ["sessionId": sessionId, "kind": kind, "phase": phase, "monitoring": isMonitoring]
        if let text { event["text"] = text }
        if let isFinal { event["isFinal"] = isFinal }
        if let message { event["message"] = message }
        if let lastInputDiagnostics { event["diagnostics"] = lastInputDiagnostics }
        if (kind == "state" || kind == "error"), !audioDiagnostics.lines.isEmpty {
            event["audioDiagnostics"] = audioDiagnostics.lines
        }
        eventHandler?(encode(event))
    }

    private func encode(_ value: [String: Any]) -> String {
        // All keys and values are fixed JSON primitives, so serialization cannot
        // fail for framework objects or arbitrary values from JavaScript.
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return "{}" }
        return json
    }

    private func validID(_ id: String) -> Bool { !id.isEmpty && id.utf8.count <= 128 }

    private static func error(_ code: String, _ message: String) -> NSError {
        NSError(domain: "Assist.Voice", code: 1, userInfo: ["code": code, NSLocalizedDescriptionKey: message])
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        guard let utterance = utterance as? AssistVoiceUtterance else { return }
        let token = utterance.generation
        let identifier = utterance.identifier
        Task { @MainActor [weak self] in
            guard let self, self.speechGeneration == token, self.phase == "speaking",
                  self.currentUtterance?.identifier == identifier else { return }
            // Delegate and PCM callback queues have no documented relative
            // ordering. Only terminal PCM closes production. This deadline
            // detects a missing terminal without dropping a late final packet.
            guard !self.pcmDrain.productionEnded, self.producerWatchdogTask == nil else { return }
            self.producerWatchdogTask = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                guard let self, self.speechGeneration == token, self.phase == "speaking",
                      self.currentUtterance?.identifier == identifier,
                      !self.pcmDrain.productionEnded else { return }
                self.fail("La fin du segment vocal local n’a pas été reçue.", code: "E_VOICE_PCM")
            }
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        guard let utterance = utterance as? AssistVoiceUtterance else { return }
        let token = utterance.generation
        Task { @MainActor [weak self] in
            guard let self, self.speechGeneration == token, self.phase == "speaking" else { return }
            self.fail("La production vocale locale a été interrompue.", code: "E_VOICE_PCM")
        }
    }
}
