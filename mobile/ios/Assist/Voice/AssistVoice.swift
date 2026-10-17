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

/// Apple-only, half-duplex speech. Session configuration, ownership and callbacks
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
    private var generation = UUID()
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
        guard recognizer?.supportsOnDeviceRecognition == true, recognizer?.isAvailable == true else {
            completion(nil, Self.error("E_VOICE_UNAVAILABLE", "La dictée locale en français canadien est indisponible sur cet appareil.")); return
        }
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
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            completion(nil, Self.error("E_VOICE_TEXT", "Le texte de lecture est vide.")); return
        }
        beginSpeech(id) { value, error in
            guard error == nil else { completion(value, error); return }
            enqueueSpeech(text, utteranceId: id) { value, error in
                guard error == nil else { completion(value, error); return }
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
        guard validID(id) else {
            completion(nil, Self.error("E_VOICE_ID", "Identifiant vocal invalide.")); return
        }
        guard phase == "idle" || phase == "speaking" else {
            completion(nil, Self.error("E_VOICE_BUSY", "Termine la dictée avant la lecture.")); return
        }
        guard let voice = canadianVoice() else {
            completion(nil, Self.error("E_VOICE_UNAVAILABLE", "Installe une voix française canadienne dans les réglages de parole iOS.")); return
        }
        cancelCurrent()
        sessionId = id
        do {
            try activateAudioSession(capturing: false)
            speechVoice = voice
            speechQueue.begin(generation: generation)
            phase = "speaking"
            emitState()
            completion(statusJSON(), nil)
        } catch {
            fail("La lecture vocale n’a pas pu démarrer : \(error.localizedDescription)", code: "E_VOICE_AUDIO")
            completion(nil, Self.error("E_VOICE_AUDIO", "La lecture vocale n’a pas pu démarrer."))
        }
    }

    @objc(enqueueSpeech:utteranceId:completion:)
    func enqueueSpeech(_ text: String, utteranceId id: String, completion: (String?, NSError?) -> Void) {
        guard phase == "speaking", sessionId == id, let voice = speechVoice else {
            completion(nil, Self.error("E_VOICE_STALE", "Cette lecture n’est plus active.")); return
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf8.count <= 24_000, let identifier = speechQueue.enqueue() else {
            completion(nil, Self.error("E_VOICE_TEXT", "Ce segment vocal ne peut pas être ajouté.")); return
        }
        let utterance = AssistVoiceUtterance(text: text, generation: generation, identifier: identifier)
        utterance.voice = voice
        synthesizer.speak(utterance)
        completion(statusJSON(), nil)
    }

    @objc(finishSpeech:completion:)
    func finishSpeech(_ id: String, completion: (String?, NSError?) -> Void) {
        guard phase == "speaking", sessionId == id else {
            completion(nil, Self.error("E_VOICE_STALE", "Cette lecture n’est plus active.")); return
        }
        if speechQueue.finishInput() { cancelCurrent() }
        completion(statusJSON(), nil)
    }

    private func activateAudioSession(capturing: Bool) throws {
        let audio = AVAudioSession.sharedInstance()
        // Once microphone permission exists, keep the same category/mode across
        // alternating playback and dictation. No input engine runs during TTS.
        // Read-only users retain playback without requesting mic permission.
        if capturing || AVAudioApplication.shared.recordPermission == .granted {
            try audio.setCategory(.playAndRecord, mode: .measurement,
                                  options: [.defaultToSpeaker, .duckOthers])
        } else {
            try audio.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        }
        try audio.setActive(true)
        audioSessionActive = true
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
        guard let recognizer, recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else {
            fail("La dictée locale en français canadien est indisponible.", code: "E_VOICE_UNAVAILABLE"); return
        }
        do {
            try activateAudioSession(capturing: true)
            let audio = AVAudioSession.sharedInstance()
            let engine = AVAudioEngine()
            audioEngine = engine
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw Self.error("E_VOICE_AUDIO", "Aucune entrée microphone n’est disponible.")
            }
            let localRequest = SFSpeechAudioBufferRecognitionRequest()
            localRequest.requiresOnDeviceRecognition = true
            localRequest.shouldReportPartialResults = true
            localRequest.taskHint = .dictation
            let meter = AssistVoiceInputMeter()
            inputMeter = meter
            inputStartedAt = .now
            inputStoppedAt = nil
            inputPort = audio.currentRoute.inputs.first?.portType.rawValue ?? "none"
            let sink = AssistVoiceAudioSink(localRequest, meter: meter)
            request = localRequest
            recognitionTask = recognizer.recognitionTask(with: localRequest, resultHandler: AssistVoiceCallbacks.recognition { [weak self] snapshot in
                guard let self, self.generation == token,
                      self.phase == "listening" || self.phase == "finishing" else { return }
                if let text = snapshot.text {
                    self.latestTranscript = text
                    self.emit(kind: "transcript", text: text, isFinal: snapshot.isFinal)
                }
                if snapshot.isFinal { self.finishRecognition(emitFinal: false) }
                else if snapshot.message != nil {
                    self.captureInputDiagnostics(errorDomain: snapshot.errorDomain, errorCode: snapshot.errorCode)
                    let observation = self.inputMeter?.snapshot()
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
                    self.fail(message, code: "E_VOICE_RECOGNITION")
                }
            })
            // Apple's append API accepts buffers from an audio tap. No actor
            // state, model, blocking work or per-buffer Task is touched here.
            input.installTap(onBus: 0, bufferSize: 1024, format: format, block: AssistVoiceCallbacks.audioTap { buffer in
                sink.append(buffer)
            })
            hasTap = true
            engine.prepare()
            try engine.start()
            phase = "listening"
            inputTask = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                    guard let self, self.generation == token, self.phase == "listening" else { return }
                    self.captureInputDiagnostics()
                    self.emit(kind: "input")
                }
            }
            emitState()
            settleStart(statusJSON(), nil)
        } catch {
            fail("Le microphone n’a pas pu démarrer : \(error.localizedDescription)", code: "E_VOICE_AUDIO")
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
        generation = UUID()
        pendingForegroundAction = nil
        finishingTask?.cancel()
        finishingTask = nil
        stopCapture()
        recognitionTask?.cancel()
        recognitionTask = nil
        request = nil
        audioEngine = nil
        speechQueue.cancel()
        speechVoice = nil
        synthesizer.stopSpeaking(at: .immediate)
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
        settleStart(nil, Self.error(code, message))
        emit(kind: "error", message: message)
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
            // This observer explicitly runs on the main operation queue. Handle
            // it synchronously so an old route event cannot stop a newer turn.
            MainActor.assumeIsolated { [weak owner] in
                owner?.handleNotification(name, routeReason: routeReason, interruptionType: interruptionType)
            }
        }
    }

    private func handleNotification(
        _ name: Notification.Name, routeReason: UInt?, interruptionType: UInt?
    ) {
        if name == AVAudioSession.routeChangeNotification &&
            routeReason == AVAudioSession.RouteChangeReason.categoryChange.rawValue { return }
        if name == UIApplication.didBecomeActiveNotification {
            let action = pendingForegroundAction
            pendingForegroundAction = nil
            if phase == "requesting" { action?() }
            return
        }
        // Permission sheets may deactivate the app; actual background cancels.
        if name == UIApplication.willResignActiveNotification && phase == "requesting" { return }
        guard phase != "idle" else { return }
        if name == AVAudioSession.interruptionNotification || name == AVAudioSession.routeChangeNotification {
            guard audioSessionActive else { return }
            // Ending an earlier interruption is not a new failure of a turn.
            if name == AVAudioSession.interruptionNotification &&
                interruptionType == AVAudioSession.InterruptionType.ended.rawValue { return }
            fail("La session audio a été interrompue ou son périphérique a changé. Relance le mode vocal.",
                 code: "E_VOICE_INTERRUPTED")
            return
        }
        cancelCurrent()
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
            "locale": "fr-CA", "phase": phase
        ]
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
        var event: [String: Any] = ["sessionId": sessionId, "kind": kind, "phase": phase]
        if let text { event["text"] = text }
        if let isFinal { event["isFinal"] = isFinal }
        if let message { event["message"] = message }
        if let lastInputDiagnostics { event["diagnostics"] = lastInputDiagnostics }
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
            guard let self, self.generation == token, self.phase == "speaking" else { return }
            if self.speechQueue.didFinish(identifier: identifier, generation: token) { self.cancelCurrent() }
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        guard let utterance = utterance as? AssistVoiceUtterance else { return }
        let token = utterance.generation
        Task { @MainActor [weak self] in
            guard let self, self.generation == token, self.phase == "speaking" else { return }
            self.cancelCurrent()
        }
    }
}
