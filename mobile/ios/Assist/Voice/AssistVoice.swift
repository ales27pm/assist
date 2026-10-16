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
    init(_ request: SFSpeechAudioBufferRecognitionRequest) { self.request = request }
    func append(_ buffer: AVAudioPCMBuffer) { request.append(buffer) }
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
    private var observers: [NSObjectProtocol] = []
    private var eventHandler: ((String) -> Void)?
    private var startCompletion: ((String?, NSError?) -> Void)?
    private var pendingForegroundAction: (() -> Void)?
    private var phase = "idle"
    private var sessionId: String?
    private var generation = UUID()
    private var latestTranscript = ""
    private var utteranceIdentity: ObjectIdentifier?
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
        startCompletion = completion
        phase = "requesting"
        emitState()
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: requestMicrophone(token)
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { [weak self] authorization in
                let allowed = authorization == .authorized
                Task { @MainActor [weak self] in
                    guard let self, self.generation == token, self.phase == "requesting" else { return }
                    if allowed { self.requestMicrophone(token) }
                    else { self.fail("La permission de reconnaissance vocale est requise.", code: "E_VOICE_SPEECH_PERMISSION") }
                }
            }
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
        guard !invalidated else { completion(nil, Self.error("E_VOICE_INVALIDATED", "La voix est fermée.")); return }
        guard UIApplication.shared.applicationState == .active else {
            completion(nil, Self.error("E_VOICE_BACKGROUND", "Reviens dans Assist pour commencer une lecture.")); return
        }
        guard validID(id), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            completion(nil, Self.error("E_VOICE_TEXT", "Texte ou identifiant vocal invalide.")); return
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
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try audio.setActive(true)
            audioSessionActive = true
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = voice
            utteranceIdentity = ObjectIdentifier(utterance)
            phase = "speaking"
            emitState()
            synthesizer.speak(utterance)
            completion(statusJSON(), nil)
        } catch {
            fail("La lecture vocale n’a pas pu démarrer : \(error.localizedDescription)", code: "E_VOICE_AUDIO")
            completion(nil, Self.error("E_VOICE_AUDIO", "La lecture vocale n’a pas pu démarrer."))
        }
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
            AVAudioApplication.requestRecordPermission { [weak self] allowed in
                Task { @MainActor [weak self] in
                    guard let self, self.generation == token, self.phase == "requesting" else { return }
                    if allowed { self.beginCapture(token) }
                    else { self.fail("La permission du microphone est requise.", code: "E_VOICE_MIC_PERMISSION") }
                }
            }
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
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.record, mode: .measurement)
            try audio.setActive(true)
            audioSessionActive = true
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
            let sink = AssistVoiceAudioSink(localRequest)
            request = localRequest
            recognitionTask = recognizer.recognitionTask(with: localRequest) { [weak self] result, error in
                // Only immutable, Sendable values cross the callback boundary.
                let text = result?.bestTranscription.formattedString
                let isFinal = result?.isFinal ?? false
                let message = error?.localizedDescription
                Task { @MainActor [weak self] in
                    guard let self, self.generation == token,
                          self.phase == "listening" || self.phase == "finishing" else { return }
                    if let text {
                        self.latestTranscript = text
                        self.emit(kind: "transcript", text: text, isFinal: isFinal)
                    }
                    if isFinal { self.finishRecognition(emitFinal: false) }
                    else if let message { self.fail("La dictée locale s’est arrêtée : \(message)", code: "E_VOICE_RECOGNITION") }
                }
            }
            // Apple's append API accepts buffers from an audio tap. No actor
            // state, model, blocking work or per-buffer Task is touched here.
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                sink.append(buffer)
            }
            hasTap = true
            engine.prepare()
            try engine.start()
            phase = "listening"
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
        audioEngine?.stop()
        if hasTap { audioEngine?.inputNode.removeTap(onBus: 0); hasTap = false }
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
        utteranceIdentity = nil
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
        observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
            let isOwnCategoryChange = name == AVAudioSession.routeChangeNotification &&
                (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) == AVAudioSession.RouteChangeReason.categoryChange.rawValue
            guard !isOwnCategoryChange else { return }
            // This observer explicitly runs on the main operation queue. Handle
            // it synchronously so an old route event cannot stop a newer turn.
            MainActor.assumeIsolated { [weak self] in
                guard let self else { return }
                if name == UIApplication.didBecomeActiveNotification {
                    let action = self.pendingForegroundAction
                    self.pendingForegroundAction = nil
                    if self.phase == "requesting" { action?() }
                    return
                }
                // System permission sheets temporarily deactivate the app.
                // Preserve that request, but never start its microphone until
                // didBecomeActive. Actual background always invalidates it.
                if name == UIApplication.willResignActiveNotification && self.phase == "requesting" { return }
                guard self.phase != "idle" else { return }
                self.cancelCurrent()
            }
        })
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
        if !recognitionAvailable { status["reason"] = "La dictée locale fr-CA ou ses permissions est indisponible. Aucun service distant ne sera utilisé." }
        else if !synthesisAvailable { status["reason"] = "Installe une voix française canadienne dans les réglages de parole iOS." }
        return encode(status)
    }

    private func emitState() { emit(kind: "state") }

    private func emit(kind: String, text: String? = nil, isFinal: Bool? = nil, message: String? = nil) {
        guard let sessionId else { return }
        var event: [String: Any] = ["sessionId": sessionId, "kind": kind, "phase": phase]
        if let text { event["text"] = text }
        if let isFinal { event["isFinal"] = isFinal }
        if let message { event["message"] = message }
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
        let identity = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in
            guard let self, self.utteranceIdentity == identity, self.phase == "speaking" else { return }
            self.cancelCurrent()
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let identity = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in
            guard let self, self.utteranceIdentity == identity, self.phase == "speaking" else { return }
            self.cancelCurrent()
        }
    }
}
