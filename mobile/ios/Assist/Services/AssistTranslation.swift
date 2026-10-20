import Foundation
import NaturalLanguage
import SwiftUI
import Translation
import UIKit

/// Owns foreground request lifetime and UIKit presentation on the main actor.
/// Workers exclusively own their non-Sendable TranslationSession. No user text
/// or result enters a URL request or a persistent store.
@MainActor
final class AssistTranslation: NSObject {
    static let shared = AssistTranslation()
    typealias Completion = @Sendable (String?, NSError?) -> Void
    private var epoch = AssistTranslationPolicy.Epoch()
    private var completion: Completion?
    private var task: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var host: UIViewController?

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(becameInactive),
                                               name: UIApplication.willResignActiveNotification, object: nil)
    }

    func execute(_ json: String, completion: @escaping Completion) {
        do {
            let query = try AssistTranslationPolicy.request(json)
            guard foreground else { throw AssistTranslationPolicy.failure(.cancelled) }
            guard self.completion == nil else { throw AssistTranslationPolicy.failure(.busy) }
            let id = epoch.begin()
            self.completion = completion
            deadline = Task { @concurrent [weak self] in
                do { try await Task.sleep(for: .seconds(query.allowDownload ? 600 : 60)) } catch { return }
                await self?.expire(id)
            }
            task = Task { @MainActor in
                guard self.accepts(id) else { return }
                do {
                    let sourceText = query.action == .translate ? try Self.resolveSource(query) : query.sourceLanguage
                    let source = sourceText.isEmpty ? nil : Locale.Language(identifier: sourceText)
                    let target = Locale.Language(identifier: query.targetLanguage)
                    let status: AssistTranslationPolicy.PairStatus
                    if let source { status = await Self.pairStatus(from: source, to: target) }
                    else { status = .notChecked }
                    guard self.accepts(id) else { return }
                    if query.action == .availability {
                        let identifiers = await Self.supportedIdentifiers()
                        guard self.accepts(id) else { return }
                        guard identifiers.count <= 64 else { throw AssistTranslationPolicy.failure(.unavailable) }
                        let rows: [AssistToolValue] = try identifiers.map { identifier in
                            guard AssistTranslationPolicy.validLanguage(identifier) else { throw AssistTranslationPolicy.failure(.unavailable) }
                            let label = Locale.current.localizedString(forIdentifier: identifier) ?? identifier
                            guard label.utf8.count <= 128 else { throw AssistTranslationPolicy.failure(.unavailable) }
                            return .object(["identifier": .string(identifier), "label": .string(label)])
                        }
                        self.finish(id, json: try AssistTranslationPolicy.response([
                            "schemaVersion": .number(1), "requestId": .string(query.requestId),
                            "action": .string("availability"), "languages": .array(rows),
                            "sourceLanguage": .string(query.sourceLanguage), "targetLanguage": .string(query.targetLanguage),
                            "status": .string(status.rawValue), "localOnly": .bool(true), "untrusted": .bool(true),
                        ]))
                        return
                    }
                    try AssistTranslationPolicy.permits(status, allowDownload: query.allowDownload)
                    guard let source else { throw AssistTranslationPolicy.failure(.languageUndetermined) }
                    if status == .installed {
                        // This initializer cannot request model downloads. A race
                        // with system eviction fails safely rather than prompting.
                        let json = try await Self.translateInstalled(query, source: source, target: target)
                        guard self.accepts(id) else { return }
                        self.finish(id, json: json)
                    } else {
                        try self.presentDownload(query, source: source, target: target, id: id)
                    }
                } catch { self.finish(id, error: Self.safe(error)) }
            }
        } catch { completion(nil, Self.safe(error)) }
    }

    func cancel() {
        epoch.cancel() // Revoke before framework cancellation or UIKit callbacks.
        let callback = completion
        completion = nil
        task?.cancel(); task = nil
        deadline?.cancel(); deadline = nil
        let oldHost = host; host = nil
        oldHost?.dismiss(animated: false)
        callback?(nil, AssistTranslationPolicy.failure(.cancelled))
    }

    @objc private func becameInactive() { cancel() }
    private var foreground: Bool { UIApplication.shared.applicationState == .active }
    private func accepts(_ id: UUID) -> Bool { epoch.accepts(id, foreground: foreground) }
    private func expire(_ id: UUID) { if epoch.active == id { cancel() } }

    private static func resolveSource(_ query: AssistTranslationPolicy.Request) throws -> String {
        if !query.sourceLanguage.isEmpty { return query.sourceLanguage }
        // A fresh recognizer per bounded request avoids sharing mutable NLP state.
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(query.text)
        guard let language = recognizer.dominantLanguage,
              let confidence = recognizer.languageHypotheses(withMaximum: 2)[language], confidence >= 0.60,
              AssistTranslationPolicy.validLanguage(language.rawValue) else {
            throw AssistTranslationPolicy.failure(.languageUndetermined)
        }
        return language.rawValue
    }
    /// LanguageAvailability is not Sendable on SDK 26.2. Each instance is
    /// created and consumed outside the UI actor, then only values cross back.
    @concurrent
    private static func supportedIdentifiers() async -> [String] {
        let languages = await LanguageAvailability().supportedLanguages
        return Set(languages.map(\.minimalIdentifier)).sorted()
    }
    @concurrent
    private static func pairStatus(from source: Locale.Language, to target: Locale.Language) async -> AssistTranslationPolicy.PairStatus {
        status(await LanguageAvailability().status(from: source, to: target))
    }
    nonisolated private static func status(_ status: LanguageAvailability.Status) -> AssistTranslationPolicy.PairStatus {
        switch status {
        case .installed: .installed
        case .supported: .supported
        case .unsupported: .unsupported
        @unknown default: .unsupported
        }
    }
    nonisolated private static func sameLanguage(_ actual: Locale.Language, _ requested: Locale.Language) -> Bool {
        let actualParts = actual.maximalIdentifier.split(separator: "-")
        let requestedParts = requested.maximalIdentifier.split(separator: "-")
        // Region dialects may normalize, but a different language/script cannot.
        return actualParts.prefix(2) == requestedParts.prefix(2)
    }

    /// An SDK 26.2 TranslationSession is non-Sendable. Create it within the
    /// worker and never store it on the UI actor or share it with cancel().
    @concurrent
    private static func translateInstalled(_ query: AssistTranslationPolicy.Request, source: Locale.Language,
                                          target: Locale.Language) async throws -> String {
        try Task.checkCancellation()
        let session = TranslationSession(installedSource: source, target: target)
        return try await translateInSession(query, source: source, target: target, session: session, prepare: false)
    }

    /// Both the installed worker and SwiftUI's translationTask exclusively own
    /// their session until this function returns. Cancellation requests revoke
    /// delivery immediately, cancel that task/view, then clean up the session
    /// here. System model downloads can continue after Apple's UI is dismissed.
    nonisolated private static func translateInSession(_ query: AssistTranslationPolicy.Request,
            source: Locale.Language, target: Locale.Language, session: TranslationSession, prepare: Bool) async throws -> String {
        defer { session.cancel() }
        try Task.checkCancellation()
        if prepare {
            guard query.allowDownload, session.canRequestDownloads else { throw AssistTranslationPolicy.failure(.downloadRequired) }
            try await session.prepareTranslation()
            try Task.checkCancellation()
            guard await pairStatus(from: source, to: target) == .installed else { throw AssistTranslationPolicy.failure(.downloadRequired) }
            try Task.checkCancellation()
        }
        let result = try await session.translate(query.text)
        try Task.checkCancellation()
        guard sameLanguage(result.sourceLanguage, source), sameLanguage(result.targetLanguage, target),
              AssistTranslationPolicy.validText(result.targetText) else { throw AssistTranslationPolicy.failure(.unavailable) }
        return try AssistTranslationPolicy.response([
            "schemaVersion": .number(1), "requestId": .string(query.requestId), "action": .string("translate"),
            "sourceLanguage": .string(query.sourceLanguage.isEmpty ? source.minimalIdentifier : query.sourceLanguage),
            "targetLanguage": .string(query.targetLanguage), "sourceDetected": .bool(query.sourceLanguage.isEmpty),
            "translatedText": .string(result.targetText), "status": .string("installed"),
            "localOnly": .bool(true), "untrusted": .bool(true),
        ])
    }

    /// Construct the action outside UI isolation so SwiftUI transfers its own
    /// session directly into one nonisolated task. Only immutable values and
    /// the @MainActor owner are captured; the session never crosses that actor.
    nonisolated private static func downloadAction(_ query: AssistTranslationPolicy.Request,
            source: Locale.Language, target: Locale.Language, owner: AssistTranslation,
            id: UUID) -> (TranslationSession) async -> Void {
        { session in
            guard await owner.accepts(id) else { session.cancel(); return }
            do {
                let json = try await translateInSession(query, source: source, target: target, session: session, prepare: true)
                await owner.finish(id, json: json)
            } catch { await owner.finish(id, error: safe(error)) }
        }
    }

    private func presentDownload(_ query: AssistTranslationPolicy.Request, source: Locale.Language,
                                 target: Locale.Language, id: UUID) throws {
        guard query.allowDownload, accepts(id),
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                .filter({ $0.activationState == .foregroundActive }).flatMap(\.windows).first(where: \.isKeyWindow),
              var presenter = window.rootViewController else { throw AssistTranslationPolicy.failure(.unavailable) }
        while let next = presenter.presentedViewController { presenter = next }
        guard !presenter.isBeingDismissed, !presenter.isBeingPresented else { throw AssistTranslationPolicy.failure(.unavailable) }
        let view = AssistTranslationDownloadView(source: source, target: target,
            run: Self.downloadAction(query, source: source, target: target, owner: self, id: id),
            cancel: { [weak self] in
                guard let self, self.epoch.active == id else { return }
                self.cancel()
            })
        let controller = UIHostingController(rootView: view)
        controller.modalPresentationStyle = .pageSheet
        host = controller
        presenter.present(controller, animated: true)
    }
    private func finish(_ id: UUID, json: String? = nil, error: NSError? = nil) {
        guard epoch.active == id else { return }
        guard accepts(id) else { cancel(); return }
        epoch.cancel()
        let callback = completion; completion = nil
        task = nil
        deadline?.cancel(); deadline = nil
        let oldHost = host; host = nil
        oldHost?.dismiss(animated: false)
        callback?(json, error)
    }
    nonisolated private static func safe(_ error: Error) -> NSError {
        let value = error as NSError
        if value.domain == "AssistTranslation" { return value }
        if error is CancellationError { return AssistTranslationPolicy.failure(.cancelled) }
        return AssistTranslationPolicy.failure(.unavailable)
    }
}

/// Constructed only by an authorized request. A nil configuration cannot start
/// work at app mount; this view exists only for the lifetime of that request.
private struct AssistTranslationDownloadView: View {
    let source: Locale.Language
    let target: Locale.Language
    let run: (TranslationSession) async -> Void
    let cancel: @MainActor () -> Void
    var body: some View {
        VStack(spacing: 20) {
            Text("Traduction locale").font(.headline)
            Text("Apple peut demander ton accord pour télécharger les langues. Le texte est traduit sur cet appareil.")
            ProgressView()
            Button("Annuler la traduction", action: cancel)
        }
        .padding(24)
        .interactiveDismissDisabled()
        .translationTask(source: source, target: target, action: run)
        .onDisappear(perform: cancel)
    }
}
