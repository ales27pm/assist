import AVFoundation
import Foundation
import FluidAudio
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

/// Local duplex speech with a pinned Apple or provisioned FluidAudio backend. Session configuration, ownership and callbacks
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
    private var voicePreview: AssistSpeechVoicePreview?
    private let speechVoicePreferenceKey = "assist.voice.speechVoiceId"
    private var hasTap = false
    private var audioSessionOwnership = AssistVoiceAudioSessionOwnership()
    private var audioSessionActive: Bool { audioSessionOwnership.isActive }
    private var invalidated = false
    private var fluidConfiguration: AssistAdvancedVoiceConfiguration?
    private var fluidRuntime: AssistFluidVoiceRuntime?
    private var fluidCachedRuntime: (configuration: AssistAdvancedVoiceConfiguration, runtime: AssistFluidVoiceRuntime)?
    private var advancedResourceMutation = false
    private var fluidPreparationTask: Task<Void, Never>?
    private var fluidShutdownTask: Task<Void, Never>?
    private var fluidInput: AssistFluidAudioInput?
    private var fluidInputTask: Task<Void, Never>?
    private var pendingFluidAdoption: UUID?
    private var fluidSpeechSession: PocketTtsSession?
    private var fluidSpeechTask: Task<Void, Never>?
    private var fluidSpeechInputClosed = false
    private var fluidSpeechChunkCount = 0
    private var fluidSpeechTextBytes = 0
    private var fluidFrameCredits = 0

    @objc func canChangeAdvancedVoiceResources() -> Bool {
        !advancedResourceMutation && phase == "idle" && !audioSessionActive && retainedInputTask == nil &&
        !lifetime.retained && voicePreview == nil && fluidPreparationTask == nil
    }

    @objc(releaseAdvancedVoiceRuntime:)
    func releaseAdvancedVoiceRuntime(_ completion: @escaping (Bool) -> Void) {
        guard canChangeAdvancedVoiceResources() else { completion(false); return }
        advancedResourceMutation = true
        let shutdown = fluidShutdownTask
        let cached = fluidCachedRuntime?.runtime
        fluidCachedRuntime = nil
        Task { @MainActor [weak self] in
            await shutdown?.value
            await cached?.cancel()
            guard let self else { completion(false); return }
            // Keep the admission barrier set while the bridge synchronously
            // enters the resource mutation and establishes its own busy flag.
            let idle = self.phase == "idle" && !self.audioSessionActive && !self.lifetime.retained
            completion(idle)
            self.advancedResourceMutation = false
        }
    }

    private static func sameConfiguration(_ left: AssistAdvancedVoiceConfiguration, _ right: AssistAdvancedVoiceConfiguration) -> Bool {
        left.pocketDirectory == right.pocketDirectory && left.asrDirectory == right.asrDirectory &&
        left.vadModelURL == right.vadModelURL && left.variant == right.variant
    }

    private var hasLocalInput: Bool {
        fluidRuntime != nil && fluidInput != nil || request != nil && recognitionTask != nil
    }


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
        observe(UIApplication.didReceiveMemoryWarningNotification)
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

    @objc(getSpeechVoices:)
    func getSpeechVoices(_ completion: (String?, NSError?) -> Void) {
        completion(speechVoiceCatalogJSON(), nil)
    }

    @objc(setSpeechVoice:completion:)
    func setSpeechVoice(_ voiceId: String, completion: (String?, NSError?) -> Void) {
        guard voiceId.isEmpty || eligibleSpeechVoices().contains(where: { $0.identifier == voiceId }) else {
            completion(nil, Self.error("E_VOICE_SELECTION", "Cette voix française canadienne n’est plus disponible.")); return
        }
        UserDefaults.standard.set(voiceId, forKey: speechVoicePreferenceKey)
        // An active response/preview owns its voice object until it finishes.
        completion(speechVoiceCatalogJSON(), nil)
    }

    @objc(previewSpeechVoice:segmentsJSON:sessionId:completion:)
    func previewSpeechVoice(_ voiceId: String, segmentsJSON: String, sessionId id: String,
                            completion: @escaping (String?, NSError?) -> Void) {
        guard !invalidated, UIApplication.shared.applicationState == .active else {
            completion(nil, Self.error("E_VOICE_BACKGROUND", "Reviens dans Assist pour écouter une voix.")); return
        }
        guard validID(id), !voiceId.isEmpty, voiceId.utf16.count <= 512 else {
            completion(nil, Self.error("E_VOICE_ID", "Identifiant de l’aperçu vocal invalide.")); return
        }
        guard !advancedResourceMutation, !AssistAdvancedVoiceResources.shared.isBusy,
              phase == "idle", !lifetime.retained, configuringGeneration == nil,
              audioEngine == nil, !audioSessionActive, voicePreview == nil else {
            completion(nil, Self.error("E_VOICE_BUSY", "Mets le mode vocal en pause avant d’écouter une voix.")); return
        }
        guard let voice = eligibleSpeechVoices().first(where: { $0.identifier == voiceId }) else {
            completion(nil, Self.error("E_VOICE_SELECTION", "Cette voix française canadienne n’est plus disponible.")); return
        }
        guard let segments = AssistSpeechPreviewPlan.segments(from: segmentsJSON) else {
            completion(nil, Self.error("E_VOICE_TEXT", "L’aperçu doit contenir de un à douze segments, pour un maximum de 8 192 octets.")); return
        }
        let token = UUID()
        let preview = AssistSpeechVoicePreview(sessionId: id, generation: token) { [weak self] outcome, error in
            if self?.voicePreview?.generation == token { self?.voicePreview = nil }
            if let error { completion(nil, error) }
            else { completion(AssistSpeechPreviewPlan.resultJSON(sessionId: id, outcome: outcome), nil) }
        }
        voicePreview = preview
        preview.start(voice: voice, segments: segments)
    }

    @objc(stopSpeechVoicePreview:completion:)
    func stopSpeechVoicePreview(_ id: String, completion: (String?, NSError?) -> Void) {
        let stopped = voicePreview?.sessionId == id
        if stopped { stopVoicePreview() }
        completion(encode(["sessionId": id, "stopped": stopped]), nil)
    }

    private func stopVoicePreview() {
        let preview = voicePreview
        voicePreview = nil
        preview?.cancel()
    }

    @objc(startListening:completion:)
    func startListening(_ id: String, completion: @escaping (String?, NSError?) -> Void) {
        guard !invalidated else { completion(nil, Self.error("E_VOICE_INVALIDATED", "La voix est fermée.")); return }
        guard UIApplication.shared.applicationState == .active else {
            completion(nil, Self.error("E_VOICE_BACKGROUND", "Reviens dans Assist pour commencer une dictée.")); return
        }
        guard validID(id) else { completion(nil, Self.error("E_VOICE_ID", "Identifiant vocal invalide.")); return }
        guard !advancedResourceMutation, !AssistAdvancedVoiceResources.shared.isBusy else {
            completion(nil, Self.error("E_VOICE_BUSY", "Attends la fin de la préparation des modèles vocaux.")); return
        }
        guard phase == "idle" || phase == "speaking" else {
            completion(nil, Self.error("E_VOICE_BUSY", "Une dictée est déjà en cours.")); return
        }
        if let pendingAudioError {
            completion(nil, Self.error("E_VOICE_INTERRUPTED", pendingAudioError)); return
        }
        let selectedConfiguration = AssistAdvancedVoiceResources.shared.configuration
        guard selectedConfiguration != nil || (recognizer?.supportsOnDeviceRecognition == true && recognizer?.isAvailable == true) else {
            completion(nil, Self.error("E_VOICE_UNAVAILABLE", "La dictée locale en français canadien est indisponible sur cet appareil.")); return
        }
        audioDiagnostics = AssistVoiceAudioDiagnostics()
        if adoptRetainedInput(id, completion: completion) { return }
        cancelCurrent()
        fluidConfiguration = selectedConfiguration
        let token = generation
        sessionId = id
        latestTranscript = ""
        inputMeter = nil
        inputStartedAt = nil
        inputStoppedAt = nil
        lastInputDiagnostics = nil
        startCompletion = completion
        phase = "requesting"
        recordPreparation("Vérification des autorisations", token: token)
        if fluidConfiguration != nil { requestMicrophone(token); return }
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
        if phase == "requesting" { cancelCurrent(preservingFluidCache: false) }
        else if phase == "listening" {
            stopCapture()
            phase = "finishing"
            request?.endAudio()
            // The worker drains the closed ring before requesting final STT.
            fluidInput?.close()
            emitState()
            let token = generation
            // Apple's final callback is not guaranteed after audio/route failures.
            // Always leave finishing, even if no final result arrives.
            finishingTask = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(self?.fluidRuntime == nil ? 3 : 15)) } catch { return }
                guard let self, self.generation == token, self.phase == "finishing" else { return }
                if self.fluidRuntime != nil {
                    self.fail("La transcription finale locale a dépassé son délai. Ton brouillon est conservé; reprends une phrase plus courte.", code: "E_VOICE_FLUID_TIMEOUT")
                } else { self.finishRecognition() }
            }
        }
        completion(statusJSON(), nil)
    }

    @objc(cancel:)
    func cancel(_ completion: (String?, NSError?) -> Void) {
        // Muting and invalidating callback identities happens before settlement.
        cancelCurrent(preservingFluidCache: false)
        completion(statusJSON(), nil)
    }

    @objc(speak:utteranceId:completion:)
    func speak(_ text: String, utteranceId id: String, completion: @escaping (String?, NSError?) -> Void) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf8.count <= 2_400 else {
            completion(nil, Self.error("E_VOICE_TEXT", "Le texte de lecture est vide ou dépasse la capacité du lecteur local.")); return
        }
        beginSpeech(id) { value, error in
            guard error == nil else { completion(value, error); return }
            self.enqueueSpeech(text, utteranceId: id) { value, error in
                guard error == nil else { self.cancelCurrent(); completion(value, error); return }
                self.finishSpeech(id, completion: completion)
            }
        }
    }

    @objc(beginSpeech:completion:)
    func beginSpeech(_ id: String, completion: @escaping (String?, NSError?) -> Void) {
        guard !invalidated else { completion(nil, Self.error("E_VOICE_INVALIDATED", "La voix est fermée.")); return }
        guard UIApplication.shared.applicationState == .active else {
            completion(nil, Self.error("E_VOICE_BACKGROUND", "Reviens dans Assist pour commencer une lecture.")); return
        }
        guard validID(id), phase == "idle" || phase == "speaking" else {
            completion(nil, Self.error("E_VOICE_BUSY", "Termine la dictée avant la lecture.")); return
        }
        guard !advancedResourceMutation, !AssistAdvancedVoiceResources.shared.isBusy else {
            completion(nil, Self.error("E_VOICE_BUSY", "Attends la fin de la préparation des modèles vocaux.")); return
        }
        let selectedConfiguration = AssistAdvancedVoiceResources.shared.configuration
        guard AVAudioApplication.shared.recordPermission == .granted,
              selectedConfiguration != nil || (SFSpeechRecognizer.authorizationStatus() == .authorized &&
              recognizer?.supportsOnDeviceRecognition == true && recognizer?.isAvailable == true) else {
            completion(nil, Self.error("E_VOICE_PERMISSION", "Autorise la dictée locale et le microphone avant le mode vocal.")); return
        }
        let voice = canadianVoice()
        guard selectedConfiguration != nil || voice != nil else {
            completion(nil, Self.error("E_VOICE_UNAVAILABLE", "Installe une voix française canadienne dans les réglages de parole iOS.")); return
        }
        cancelCurrent()
        audioDiagnostics = AssistVoiceAudioDiagnostics()
        sessionId = id
        fluidConfiguration = selectedConfiguration
        speechVoice = voice
        latestTranscript = ""
        cachedRecognition = nil
        monitorRetry = AssistVoiceMonitorRetry()
        if selectedConfiguration != nil {
            phase = "requesting"
            startCompletion = completion
            emitState()
            prepareFluid(token: generation, speaking: true)
            return
        }
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
        guard phase == "speaking", sessionId == id, speechVoice != nil || fluidSpeechSession != nil else {
            completion(nil, Self.error("E_VOICE_STALE", "Cette lecture n’est plus active.")); return
        }
        if fluidSpeechSession != nil { enqueueFluidSpeech(text, completion: completion); return }
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
        if let fluidSpeechSession {
            fluidSpeechInputClosed = true
            fluidSpeechSession.finish()
        } else if speechQueue.finishInput() { finishSpeechNaturally() }
        completion(statusJSON(), nil)
    }

    private func prepareFluid(token: UUID, speaking: Bool) {
        guard fluidPreparationTask == nil, let configuration = fluidConfiguration else { return }
        let shutdown = fluidShutdownTask
        if shutdown != nil { recordPreparation("Fin du chargement précédent", token: token) }
        fluidPreparationTask = Task { @MainActor [weak self] in
            await shutdown?.value
            guard let self, self.generation == token, self.phase == "requesting", !Task.isCancelled else { return }
            do {
                let runtime: AssistFluidVoiceRuntime
                let receive: @MainActor @Sendable (AssistFluidVoiceEvent) -> Void = { [weak self] event in
                    self?.receiveFluid(event, token: token)
                }
                if let cached = self.fluidCachedRuntime, Self.sameConfiguration(cached.configuration, configuration) {
                    self.recordPreparation("Réutilisation des modèles vocaux", token: token)
                    runtime = cached.runtime
                    self.fluidCachedRuntime = nil
                    await runtime.resetCapture(monitoring: speaking, receive: receive)
                } else {
                    self.fluidCachedRuntime = nil
                    // `os_proc_available_memory` is an estimate of the app's
                    // remaining allocation budget, not a reservation or a
                    // prediction of this stack's actual allocation. Do not
                    // preemptively reject the full local stack from that value:
                    // the staged local loader reports the failing component if
                    // iOS actually refuses an allocation.
                    guard ProcessInfo.processInfo.thermalState != .serious,
                          ProcessInfo.processInfo.thermalState != .critical else {
                        throw Self.error("E_VOICE_THERMAL", "L’iPhone est trop chaud pour charger les modèles vocaux avancés. Laisse-le refroidir ou choisis Apple.")
                    }
                    runtime = try await AssistFluidVoiceRuntime(
                        configuration: configuration, monitoring: speaking,
                        progress: { [weak self] stage, detail in
                            let suffix = detail.map { " · \($0)" } ?? ""
                            self?.recordPreparation("Chargement de \(stage.label)\(suffix)", token: token)
                        }, receive: receive)
                }
                guard self.generation == token, self.phase == "requesting", !Task.isCancelled else {
                    await runtime.cancel(); return
                }
                self.fluidRuntime = runtime
                if speaking {
                    self.recordPreparation("Préparation de la voix Estelle", token: token)
                    let session = try await runtime.makeSpeechSession()
                    guard self.generation == token, self.phase == "requesting", !Task.isCancelled else {
                        await runtime.cancel(); return
                    }
                    self.fluidSpeechSession = session
                }
                self.completeFluidPreparation(token: token, speaking: speaking)
            } catch {
                guard self.generation == token, self.phase == "requesting", !Task.isCancelled else { return }
                self.fluidPreparationTask = nil
                if let failure = error as? AssistFluidLoadFailure {
                    self.audioDiagnostics.append(failure.diagnosticLine)
                    self.fail(failure.localizedDescription, code: "E_VOICE_FLUID_LOAD")
                    return
                }
                let native = error as NSError
                let code = native.userInfo["code"] as? String ?? "E_VOICE_FLUID_LOAD"
                let message = code == "E_VOICE_THERMAL" ? native.localizedDescription :
                    "Les modèles vocaux locaux n’ont pas pu être chargés. Vérifie les ressources dans Réglages."
                self.fail(message, code: code)
            }
        }
    }

    private func completeFluidPreparation(token: UUID, speaking: Bool) {
        guard generation == token, phase == "requesting", fluidRuntime != nil else { return }
        guard UIApplication.shared.applicationState == .active else {
            pendingForegroundAction = { [weak self] in self?.completeFluidPreparation(token: token, speaking: speaking) }
            return
        }
        fluidPreparationTask = nil
        do {
            recordPreparation("Démarrage du microphone et de l’annulation d’écho", token: token)
            try activateAudioSession()
            try makeDuplexEngine(token: token)
            phase = speaking ? "speaking" : "listening"
            if speaking { startFluidSpeechFrames() }
            lastMonitoring = isMonitoring
            emitState()
            settleStart(statusJSON(), nil)
        } catch {
            fail("Le graphe audio local avec annulation d’écho n’a pas pu démarrer : \(error.localizedDescription)", code: "E_VOICE_AEC")
        }
    }

    private func receiveFluid(_ event: AssistFluidVoiceEvent, token: UUID) {
        guard generation == token, fluidRuntime != nil else { return }
        switch event {
        case .onset:
            if phase == "speaking" { promoteInterruption() }
        case .transcript(let text, let final):
            receiveRecognition(AssistVoiceRecognitionSnapshot(text: text, isFinal: final, message: nil))
        case .failure(let message):
            fail(message, code: "E_VOICE_FLUID")
        }
    }

    private func enqueueFluidSpeech(_ text: String, completion: (String?, NSError?) -> Void) {
        let bytes = text.utf8.count
        guard let session = fluidSpeechSession, !fluidSpeechInputClosed,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              bytes <= 2_400, fluidSpeechChunkCount < 64,
              fluidSpeechTextBytes <= 32_768 - bytes else {
            completion(nil, Self.error("E_VOICE_TEXT", "Ce segment dépasse la capacité du lecteur local.")); return
        }
        fluidSpeechChunkCount += 1
        fluidSpeechTextBytes += bytes
        session.enqueue(text)
        completion(statusJSON(), nil)
    }

    private func startFluidSpeechFrames() {
        guard let session = fluidSpeechSession else { return }
        let token = speechGeneration
        let identifier = UUID()
        currentUtterance = AssistVoiceUtterance(text: "", generation: token, identifier: identifier)
        pcmConverter = AssistVoicePCMConverter()
        pcmDrain.begin(identifier)
        fluidFrameCredits = 0
        // One Pocket session spans every prosodic chunk of this response. Both
        // Mimi state and the resampler remain continuous across enqueue calls.
        fluidSpeechTask = Task { @MainActor [weak self] in
            do {
                for try await frame in session.frames {
                    try Task.checkCancellation()
                    guard let self, self.speechGeneration == token,
                          self.phase == "speaking", self.currentUtterance?.identifier == identifier else { return }
                    guard !frame.samples.isEmpty, frame.samples.count <= 1_920,
                          frame.samples.allSatisfy({ $0.isFinite }) else {
                        throw Self.error("E_VOICE_PCM", "Trame PocketTTS invalide.")
                    }
                    self.fluidFrameCredits += 1
                    if let buffer = try self.pcmConverter?.convert(frame.samples, sampleRate: 24_000) {
                        let credits = self.fluidFrameCredits
                        self.fluidFrameCredits = 0
                        try self.scheduleFluidPCM(buffer, token: token, identifier: identifier,
                                                  session: session, credits: credits)
                    }
                }
                guard let self, !Task.isCancelled, self.speechGeneration == token,
                      self.phase == "speaking", self.currentUtterance?.identifier == identifier else { return }
                guard self.fluidSpeechInputClosed else {
                    throw Self.error("E_VOICE_PCM", "La synthèse locale s’est arrêtée avant la fin de la réponse.")
                }
                let tails = try self.pcmConverter?.finish() ?? []
                for (index, tail) in tails.enumerated() {
                    let credits = index == tails.count - 1 ? self.fluidFrameCredits : 0
                    if credits > 0 { self.fluidFrameCredits = 0 }
                    try self.scheduleFluidPCM(tail, token: token, identifier: identifier,
                                              session: session, credits: credits)
                }
                if self.fluidFrameCredits > 0 {
                    let credits = self.fluidFrameCredits
                    self.fluidFrameCredits = 0
                    for _ in 0..<credits { await session.acknowledgePlaybackFrame() }
                }
                self.pcmDrain.finishProduction()
                self.finishFluidSpeechIfDrained()
            } catch {
                guard let self, !Task.isCancelled, self.speechGeneration == token, self.phase == "speaking" else { return }
                self.fail("La synthèse PocketTTS locale s’est arrêtée. Reprends le mode vocal.", code: "E_VOICE_FLUID_TTS")
            }
        }
    }

    private func scheduleFluidPCM(_ buffer: AVAudioPCMBuffer, token: UUID, identifier: UUID,
                                  session: PocketTtsSession, credits: Int) throws {
        let bufferId = UUID()
        guard let player, pcmDrain.schedule(bufferId, frames: Int(buffer.frameLength)) else {
            throw Self.error("E_VOICE_PCM", "La file audio locale dépasse quinze secondes.")
        }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack,
                              completionHandler: AssistVoiceCallbacks.playback(release: {
            // This exact old session receives its own credit, even when stop
            // discards the buffer. Never credit a later response's generation.
            Task { for _ in 0..<credits { await session.acknowledgePlaybackFrame() } }
        }) { [weak self] in
            guard let self, self.speechGeneration == token, self.phase == "speaking",
                  self.currentUtterance?.identifier == identifier else { return }
            _ = self.pcmDrain.didPlay(bufferId)
            self.finishFluidSpeechIfDrained()
        })
        if !player.isPlaying { player.play() }
    }

    private func finishFluidSpeechIfDrained() {
        guard fluidSpeechSession != nil, pcmDrain.isComplete, phase == "speaking" else { return }
        finishSpeechNaturally()
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
        audioSessionOwnership.acquire()
    }

    private var isMonitoring: Bool {
        phase == "speaking" && hasTap && hasLocalInput &&
        (fluidRuntime != nil || recognitionTask?.state == .running) && audioEngine?.isRunning == true &&
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
        fluidSpeechTask?.cancel()
        fluidSpeechTask = nil
        let retiredSession = fluidSpeechSession
        fluidSpeechSession = nil
        fluidSpeechInputClosed = false
        fluidSpeechChunkCount = 0
        fluidSpeechTextBytes = 0
        fluidFrameCredits = 0
        // Capture the exact retired producer. A delayed cleanup must never
        // look up and cancel a later session in a reused warm runtime.
        if let retiredSession { Task { await retiredSession.cancel() } }
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
        let retain = hasLocalInput && audioEngine?.isRunning == true
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
            self.cancelCurrent(preservingFluidCache: false)
        }
    }

    private func adoptRetainedInput(_ id: String, completion: @escaping (String?, NSError?) -> Void) -> Bool {
        guard phase == "idle", hasLocalInput, audioEngine?.isRunning == true,
              lifetime.adoptInput() else { return false }
        retainedInputTask?.cancel()
        retainedInputTask = nil
        sessionId = id
        phase = "listening"
        lastMonitoring = false
        if let ring = fluidInput {
            // The worker may be suspended in VAD. Queue the transition behind
            // that append instead of racing it with a new actor Task from Main.
            let adoption = UUID()
            let token = generation
            pendingFluidAdoption = adoption
            startCompletion = completion
            retainedInputTask = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                guard let self, self.generation == token, self.fluidInput === ring,
                      self.pendingFluidAdoption == adoption else { return }
                self.fail("La reprise du microphone local a dépassé son délai. Relance le mode vocal.", code: "E_VOICE_FLUID_ADOPTION")
            }
            if !ring.requestCapture() {
                fail("La capture vocale retenue n’est plus disponible. Reprends le mode vocal.", code: "E_VOICE_FLUID_ADOPTION")
            }
        } else {
            emitState()
            if let cachedRecognition { receiveCapture(cachedRecognition) }
            completion(statusJSON(), nil)
        }
        return true
    }

    private func completeFluidAdoption(on ring: AssistFluidAudioInput, token: UUID, accepted: Bool) {
        guard generation == token, fluidInput === ring, pendingFluidAdoption != nil,
              phase == "listening" || phase == "finishing" else { return }
        pendingFluidAdoption = nil
        retainedInputTask?.cancel()
        retainedInputTask = nil
        guard accepted else {
            fail("La capture vocale retenue n’a pas pu être reprise. Relance le mode vocal.", code: "E_VOICE_FLUID_ADOPTION")
            return
        }
        // The worker has made capture active. Settle before replaying a
        // retained final: its natural cancelCurrent must not reject this start.
        settleStart(statusJSON(), nil)
        // Completion itself may synchronously cancel/invalidate the module.
        guard generation == token, fluidInput === ring,
              phase == "listening" || phase == "finishing" else { return }
        emitState()
        let snapshot = cachedRecognition
        cachedRecognition = nil
        if let snapshot { receiveCapture(snapshot) }
    }

    @objc func invalidate() {
        invalidated = true
        cancelCurrent(preservingFluidCache: false)
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
        if fluidConfiguration != nil {
            prepareFluid(token: token, speaking: false)
            return
        }
        do {
            recordPreparation("Démarrage du microphone et de l’annulation d’écho", token: token)
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
        let mixer = engine.mainMixerNode
        engine.connect(player, to: mixer, format: playbackFormat)
        // Construct the mixer/player first: a lazy main mixer otherwise follows
        // hardware output at start and may renegotiate the VPIO client format.
        let ioFormat = engine.inputNode.outputFormat(forBus: 0)
        try AssistVoiceIOWiring.connectOutput(engine: engine, mixer: mixer, format: ioFormat)
        guard generation == token, audioEngine === engine, audioSessionActive,
              UIApplication.shared.applicationState == .active else {
            throw Self.error("E_VOICE_INTERRUPTED", "Le démarrage audio a été interrompu.")
        }
        try installRecognition(on: engine, token: token, expectedFormat: ioFormat)
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

    private func installRecognition(on engine: AVAudioEngine, token: UUID, expectedFormat: AVAudioFormat? = nil) throws {
        guard generation == token, audioEngine === engine, audioSessionActive,
              UIApplication.shared.applicationState == .active else {
            throw Self.error("E_VOICE_INTERRUPTED", "La session de reconnaissance a été annulée.")
        }
        let input = engine.inputNode
        let currentFormat = input.outputFormat(forBus: 0)
        let format = expectedFormat ?? currentFormat
        guard Self.routeFormat(format).isValid else {
            throw Self.error("E_VOICE_AUDIO", "Aucune entrée microphone PCM n’est disponible.")
        }
        guard Self.routeFormat(format) == Self.routeFormat(currentFormat) else {
            throw Self.error("E_VOICE_AUDIO", "Le format du microphone a changé pendant la construction du graphe vocal.")
        }
        tapInputFormat = Self.routeFormat(format)
        if let runtime = fluidRuntime {
            let meter = AssistVoiceInputMeter()
            inputMeter = meter
            inputStartedAt = .now
            inputStoppedAt = nil
            lastInputDiagnostics = nil
            inputPort = AVAudioSession.sharedInstance().currentRoute.inputs.first?.portType.rawValue ?? "none"
            let ring = AssistFluidAudioInput(format: format, meter: meter)
            fluidInput = ring
            input.installTap(onBus: 0, bufferSize: 1024, format: format,
                             block: AssistVoiceCallbacks.audioTap { ring.append($0) })
            hasTap = true
            fluidInputTask = Task.detached { [weak self] in
                await AssistFluidInputWorker.run(ring: ring, processor: runtime, didAdopt: { [weak self] accepted in
                    await self?.completeFluidAdoption(on: ring, token: token, accepted: accepted)
                }, failure: { [weak self] in
                    await self?.receiveFluid(.failure("Le tampon du microphone local est saturé ou son format a changé."), token: token)
                })
            }
            startInputObservation(token: token)
            return
        }
        guard let recognizer, recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else {
            throw Self.error("E_VOICE_UNAVAILABLE", "La dictée locale fr-CA est indisponible.")
        }
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
        startInputObservation(token: token)
    }

    private func startInputObservation(token: UUID) {
        inputTask?.cancel()
        inputTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                guard let self, self.generation == token,
                      self.phase == "listening" || self.phase == "speaking" || self.lifetime.retained else { return }
                self.captureInputDiagnostics()
                if self.phase == "listening", self.pendingFluidAdoption == nil { self.emit(kind: "input") }
                if self.phase == "speaking", self.lastMonitoring != self.isMonitoring {
                    self.lastMonitoring = self.isMonitoring
                    self.emitState()
                }
            }
        }
    }

    private func receiveRecognition(_ snapshot: AssistVoiceRecognitionSnapshot) {
        if pendingFluidAdoption != nil {
            cachedRecognition = snapshot
            if let text = snapshot.text { latestTranscript = text }
            return
        }
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

    private func cancelCurrent(preservingFluidCache: Bool = true) {
        lifetime.reset()
        pendingFluidAdoption = nil
        // stop/player/engine/deactivation may synchronously notify. Observers
        // must see no owned audio session before any of those boundaries.
        let shouldDeactivate = audioSessionOwnership.relinquish()
        stopVoicePreview()
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
        if preservingFluidCache, let runtime = fluidRuntime, let configuration = fluidConfiguration {
            fluidCachedRuntime = (configuration, runtime)
        } else if !preservingFluidCache { fluidCachedRuntime = nil }
        let preparation = fluidPreparationTask
        preparation?.cancel()
        fluidPreparationTask = nil
        fluidInput?.close()
        let inputWorker = fluidInputTask
        inputWorker?.cancel()
        fluidInputTask = nil
        fluidInput = nil
        fluidConfiguration = nil
        let runtime = fluidRuntime
        if runtime != nil || preparation != nil {
            let prior = fluidShutdownTask
            fluidShutdownTask = Task {
                await prior?.value
                await preparation?.value
                await runtime?.cancel()
                await inputWorker?.value
            }
        }
        fluidRuntime = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        request = nil
        audioEngine = nil
        player = nil
        lastMonitoring = false
        if shouldDeactivate {
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        }
        phase = "idle"
        settleStart(nil, Self.error("E_VOICE_CANCELLED", "La dictée a été annulée."))
        emitState()
        sessionId = nil
    }

    private func fail(_ message: String, code: String) {
        emit(kind: "error", message: message)
        settleStart(nil, Self.error(code, message))
        cancelCurrent(preservingFluidCache: false)
    }

    private func settleStart(_ value: String?, _ error: NSError?) {
        let completion = startCompletion
        startCompletion = nil
        completion?(value, error)
    }

    /// Only the current pending start may publish model progress. A cancelled
    /// Core ML load can finish later without reviving its retired session.
    private func recordPreparation(_ label: String, token: UUID) {
        guard generation == token, phase == "requesting", !invalidated else { return }
        audioDiagnostics.append("Préparation · \(label)")
        emitState()
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
        voicePreview?.handleNotification(name, routeReason: routeReason, interruptionType: interruptionType, previous: previous)
        if name == UIApplication.didReceiveMemoryWarningNotification {
            // A quiescent cache is expendable. Do not change provider or voice
            // midway through an active turn in response to a warning.
            if phase == "idle", !lifetime.retained { fluidCachedRuntime = nil }
            return
        }
        if name == UIApplication.didBecomeActiveNotification {
            let action = pendingForegroundAction
            pendingForegroundAction = nil
            if phase == "requesting" { action?() }
            return
        }
        // Release model/voice conditioning even when no audio is currently
        // active. A permission sheet preserves only its pending first-use flow.
        if name == UIApplication.didEnterBackgroundNotification ||
           (name == UIApplication.willResignActiveNotification && phase != "requesting") {
            fluidCachedRuntime = nil
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
        cancelCurrent(preservingFluidCache: false)
    }

    private func failAudioInterruption() {
        if lifetime.retained {
            cancelCurrent(preservingFluidCache: false)
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
        for line in facts.diagnosticLines(source: source, phase: phase, decision: decision, frames: frames) {
            audioDiagnostics.append(line)
        }
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

    private func eligibleSpeechVoices() -> [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices().filter { voice in
            // Product allow-list, not a public API guarantee of provenance or
            // offline execution. Every offered voice still needs offline QA.
            AssistSpeechVoicePolicy.isEligible(id: voice.identifier, name: voice.name, language: voice.language,
                quality: Self.voiceQuality(voice), personal: voice.voiceTraits.contains(.isPersonalVoice),
                novelty: voice.voiceTraits.contains(.isNoveltyVoice))
        }.sorted {
            $0.quality.rawValue == $1.quality.rawValue ? $0.identifier < $1.identifier : $0.quality.rawValue > $1.quality.rawValue
        }.prefix(200).map { $0 }
    }

    private static func voiceQuality(_ voice: AVSpeechSynthesisVoice) -> String? {
        switch voice.quality {
        case .default: return "default"
        case .enhanced: return "enhanced"
        case .premium: return "premium"
        @unknown default: return nil
        }
    }

    private func canadianVoice() -> AVSpeechSynthesisVoice? {
        let voices = eligibleSpeechVoices()
        let selected = UserDefaults.standard.string(forKey: speechVoicePreferenceKey) ?? ""
        let resolution = AssistSpeechVoicePolicy.resolve(identifiers: voices.map(\.identifier), selected: selected)
        return voices.first(where: { $0.identifier == resolution.id })
    }

    private func speechVoiceCatalogJSON() -> String {
        let voices = eligibleSpeechVoices()
        let selected = UserDefaults.standard.string(forKey: speechVoicePreferenceKey) ?? ""
        let resolution = AssistSpeechVoicePolicy.resolve(identifiers: voices.map(\.identifier), selected: selected)
        var catalog: [String: Any] = [
            "schemaVersion": 1, "locale": "fr-CA",
            "voices": voices.map { ["id": $0.identifier, "name": $0.name, "language": "fr-CA", "quality": Self.voiceQuality($0)!] },
            "selectedVoiceId": selected, "resolvedVoiceId": resolution.id.map { $0 as Any } ?? NSNull(),
            "selectionMissing": resolution.missing
        ]
        if let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String,
           !build.isEmpty, build.utf16.count <= 128 { catalog["nativeBuild"] = build }
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        if !os.isEmpty, os.utf16.count <= 128 { catalog["osVersion"] = os }
        return encode(catalog)
    }

    private func statusJSON() -> String {
        let voice = speechVoice ?? canadianVoice()
        let speechPermission = SFSpeechRecognizer.authorizationStatus()
        let micPermission = AVAudioApplication.shared.recordPermission
        let fluidReady = fluidConfiguration != nil || AssistAdvancedVoiceResources.shared.configuration != nil
        let recognitionAvailable = !invalidated && micPermission != .denied && (fluidReady ||
            (recognizer?.supportsOnDeviceRecognition == true && recognizer?.isAvailable == true &&
            speechPermission != .denied && speechPermission != .restricted))
        let synthesisAvailable = !invalidated && (fluidReady || voice != nil)
        var status: [String: Any] = [
            "available": recognitionAvailable && synthesisAvailable,
            "recognitionAvailable": recognitionAvailable, "synthesisAvailable": synthesisAvailable,
            "locale": "fr-CA", "phase": phase, "monitoring": isMonitoring
        ]
        if !audioDiagnostics.lines.isEmpty { status["audioDiagnostics"] = audioDiagnostics.lines }
        if fluidReady { status["voiceName"] = "Voix de référence locale · PocketTTS" }
        else if let voice { status["voiceName"] = voice.name }
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

// BEGIN PREVIEW VALUE CONTRACTS — also exercised by the standalone checks.
enum AssistSpeechVoicePolicy {
    static func isEligible(id: String, name: String, language: String, quality: String?, personal: Bool, novelty: Bool) -> Bool {
        id.hasPrefix("com.apple.") && id.utf16.count <= 512 && !name.isEmpty && name.utf16.count <= 160 &&
        language.replacingOccurrences(of: "_", with: "-").lowercased() == "fr-ca" &&
        !personal && !novelty && quality.map { ["default", "enhanced", "premium"].contains($0) } == true
    }
    static func resolve(identifiers: [String], selected: String) -> (id: String?, missing: Bool) {
        let found = !selected.isEmpty && identifiers.contains(selected)
        return (found ? selected : identifiers.first, !selected.isEmpty && !found)
    }
}

enum AssistSpeechPreviewPlan {
    static func segments(from json: String) -> [String]? {
        guard json.utf8.count <= 65_536, let data = json.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data),
              let segments = value as? [String], (1...12).contains(segments.count),
              segments.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf8.count <= 2_400 }),
              segments.reduce(0, { $0 + $1.utf8.count }) <= 8_192 else { return nil }
        return segments
    }

    static func resultJSON(sessionId: String, outcome: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: ["sessionId": sessionId, "outcome": outcome], options: [.sortedKeys])
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}

struct AssistSpeechPreviewLifetime: Sendable {
    private var generation: UUID?
    private var pending: Set<UUID> = []
    var isActive: Bool { generation != nil }
    mutating func begin(generation: UUID, identifiers: [UUID]) {
        self.generation = generation
        pending = Set(identifiers)
    }
    func contains(_ identifier: UUID, generation: UUID) -> Bool {
        self.generation == generation && pending.contains(identifier)
    }
    mutating func didFinish(_ identifier: UUID, generation: UUID) -> Bool {
        guard contains(identifier, generation: generation) else { return false }
        pending.remove(identifier)
        return pending.isEmpty
    }
    mutating func cancel() { generation = nil; pending.removeAll() }
}
// END PREVIEW VALUE CONTRACTS

/// A playback-only preview. It never creates an input engine, Speech request,
/// audio tap, or privacy prompt. The conversation synthesizer is independent.
@MainActor
private final class AssistSpeechVoicePreview: NSObject, AVSpeechSynthesizerDelegate {
    nonisolated let sessionId: String
    nonisolated let generation: UUID
    private let synthesizer = AVSpeechSynthesizer()
    private var lifetime = AssistSpeechPreviewLifetime()
    private var ownership = AssistVoiceAudioSessionOwnership()
    private var completion: ((String, NSError?) -> Void)?
    private var starting = false
    private var route: AssistVoiceRouteIdentity?
    private var ownedCategory: AssistVoiceOwnedCategoryTransition?
    private var deferredRoutes: [(reason: UInt, previous: AssistVoiceRouteIdentity?, current: AssistVoiceRouteIdentity)] = []

    init(sessionId: String, generation: UUID, completion: @escaping (String, NSError?) -> Void) {
        self.sessionId = sessionId
        self.generation = generation
        self.completion = completion
        super.init()
        synthesizer.delegate = self
        synthesizer.usesApplicationAudioSession = true
    }

    func start(voice: AVSpeechSynthesisVoice, segments: [String]) {
        let identifiers = segments.map { _ in UUID() }
        lifetime.begin(generation: generation, identifiers: identifiers)
        starting = true
        let session = AVAudioSession.sharedInstance()
        let before = Self.identity(session.currentRoute)
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            guard lifetime.isActive else { return }
            let afterCategory = Self.identity(session.currentRoute)
            try session.setActive(true)
            guard lifetime.isActive, UIApplication.shared.applicationState == .active else {
                try? session.setActive(false, options: [.notifyOthersOnDeactivation])
                finish("cancelled")
                return
            }
            ownership.acquire()
            let target = Self.identity(session.currentRoute)
            route = target
            let owned = AssistVoiceOwnedCategoryTransition(previous: [before, afterCategory], target: target)
            ownedCategory = owned
            starting = false
            guard session.category == .playback, session.mode == .spokenAudio, !session.currentRoute.outputs.isEmpty else {
                throw NSError(domain: "Assist.Voice", code: 1,
                    userInfo: ["code": "E_VOICE_PREVIEW_AUDIO", NSLocalizedDescriptionKey: "La sortie audio de l’aperçu n’est pas disponible."])
            }
            for notification in deferredRoutes {
                let previousMatches = notification.previous == nil || notification.previous == target
                let expectedCategory = notification.reason == 3 &&
                    (previousMatches || notification.previous.map { owned.contains(previous: $0, current: target) } == true) &&
                    [before, afterCategory, target].contains(notification.current)
                let stableConfiguration = notification.reason == 8 && notification.current == target && previousMatches
                guard expectedCategory || stableConfiguration else { finish("cancelled"); return }
            }
            deferredRoutes.removeAll()
            for (text, identifier) in zip(segments, identifiers) {
                guard lifetime.isActive else { return }
                let utterance = AssistVoiceUtterance(text: text, generation: generation, identifier: identifier)
                utterance.voice = voice
                synthesizer.speak(utterance)
            }
        } catch {
            finish("cancelled", error: NSError(domain: "Assist.Voice", code: 1,
                userInfo: ["code": "E_VOICE_PREVIEW_AUDIO", NSLocalizedDescriptionKey: "L’aperçu vocal n’a pas pu démarrer : \(error.localizedDescription)"]))
        }
    }

    func cancel() { finish("cancelled") }

    private func finish(_ outcome: String, error: NSError? = nil) {
        guard let callback = completion else { return }
        completion = nil
        lifetime.cancel()
        starting = false
        deferredRoutes.removeAll()
        let deactivate = ownership.relinquish()
        synthesizer.stopSpeaking(at: .immediate)
        if deactivate { try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation]) }
        synthesizer.delegate = nil
        callback(outcome, error)
    }

    func handleNotification(_ name: Notification.Name, routeReason: UInt?, interruptionType: UInt?, previous: AssistVoiceRouteIdentity?) {
        guard lifetime.isActive else { return }
        if name == UIApplication.willResignActiveNotification || name == UIApplication.didEnterBackgroundNotification {
            cancel(); return
        }
        if name == AVAudioSession.interruptionNotification {
            if interruptionType != AVAudioSession.InterruptionType.ended.rawValue { cancel() }
            return
        }
        guard name == AVAudioSession.routeChangeNotification else { return }
        let session = AVAudioSession.sharedInstance()
        guard UIApplication.shared.applicationState == .active,
              session.category == .playback, session.mode == .spokenAudio,
              routeReason == 3 || routeReason == 8 else { cancel(); return }
        let current = Self.identity(session.currentRoute)
        if starting {
            guard deferredRoutes.count < 8, let routeReason else { cancel(); return }
            deferredRoutes.append((routeReason, previous, current))
            return
        }
        let previousMatches = previous == nil || previous == current ||
            (routeReason == 3 && previous.map { ownedCategory?.contains(previous: $0, current: current) == true } == true)
        guard ownership.isActive, current == route, previousMatches, !session.currentRoute.outputs.isEmpty else { cancel(); return }
    }

    private nonisolated static func identity(_ route: AVAudioSessionRouteDescription) -> AssistVoiceRouteIdentity {
        AssistVoiceRouteIdentity(inputs: route.inputs.map { .init(type: $0.portType.rawValue, uid: $0.uid) },
                                 outputs: route.outputs.map { .init(type: $0.portType.rawValue, uid: $0.uid) })
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        guard let value = utterance as? AssistVoiceUtterance else { return }
        let token = value.generation
        let identifier = value.identifier
        Task { @MainActor [weak self] in
            guard let self, self.lifetime.didFinish(identifier, generation: token) else { return }
            self.finish("completed")
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        guard let value = utterance as? AssistVoiceUtterance else { return }
        let token = value.generation
        let identifier = value.identifier
        Task { @MainActor [weak self] in
            guard let self, self.lifetime.contains(identifier, generation: token) else { return }
            self.cancel()
        }
    }
}
