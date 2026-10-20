import Foundation
import SafariServices
import Security
import UIKit

/// Reject redirects instead of moving the bearer credential to another origin.
/// No challenge handler is installed: platform TLS trust remains mandatory.
private final class AssistPrivateRedirectPolicy: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private enum AssistPrivateTransport {
    enum Endpoint: Sendable {
        case capabilities, researchCapabilities
        case search(AssistPrivateServicePolicy.SearchRequest), read(AssistPrivateServicePolicy.ReadRequest)
    }

    @concurrent
    static func fetch(_ endpoint: Endpoint, configuration: AssistPrivateServicePolicy.Configuration) async throws -> Data {
        try Task.checkCancellation()
        let origin = try AssistPrivateServicePolicy.origin(configuration.origin)
        let path: String
        switch endpoint {
        case .capabilities: path = "v1/capabilities"
        case .researchCapabilities: path = "v2/capabilities"
        case .search: path = "v1/search"
        case .read: path = "v2/read"
        }
        let settings = URLSessionConfiguration.ephemeral
        settings.urlCache = nil
        settings.httpCookieStorage = nil
        settings.urlCredentialStorage = nil
        settings.httpShouldSetCookies = false
        settings.requestCachePolicy = .reloadIgnoringLocalCacheData
        settings.timeoutIntervalForRequest = 15
        settings.timeoutIntervalForResource = 20
        settings.httpMaximumConnectionsPerHost = 1
        let session = URLSession(configuration: settings)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: origin.appendingPathComponent(path))
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("Bearer " + configuration.secret, forHTTPHeaderField: "Authorization")
        if case .search(let search) = endpoint {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(search)
        }
        if case .read(let read) = endpoint {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(read)
        }
        let (bytes, response) = try await session.bytes(for: request, delegate: AssistPrivateRedirectPolicy())
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse, let requestURL = request.url else {
            throw AssistPrivateServicePolicy.invalid()
        }
        try AssistPrivateServicePolicy.validateResponseHeaders(status: response.statusCode, mimeType: response.mimeType,
            contentLength: response.expectedContentLength, responseURL: response.url, requestURL: requestURL)
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < AssistPrivateServicePolicy.maximumResponseBytes else { throw AssistPrivateServicePolicy.invalid() }
            data.append(byte)
        }
        try Task.checkCancellation()
        return data
    }
}

/// A single device-only Keychain item is updated atomically AFTER the remote
/// authenticated capabilities handshake. Neither secret nor auth headers cross
/// the React Native bridge. This is not server-side bearer-token revocation.
@MainActor
private enum AssistPrivateCredentialStore {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "org.27pm.assist.private-service.v1",
         kSecAttrAccount as String: "paired-configuration",
         kSecAttrSynchronizable as String: false]
    }

    static func load() throws -> AssistPrivateServicePolicy.Configuration? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw AssistPrivateServicePolicy.invalid() }
        let stored = try JSONDecoder().decode(AssistPrivateServicePolicy.Configuration.self, from: data)
        return try AssistPrivateServicePolicy.configuration(origin: stored.origin, secret: stored.secret)
    }

    static func save(_ configuration: AssistPrivateServicePolicy.Configuration) throws {
        let data = try JSONEncoder().encode(configuration)
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            for (key, value) in attributes { item[key] = value }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw AssistPrivateServicePolicy.invalid() }
    }

    static func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw AssistPrivateServicePolicy.invalid() }
    }
}

@MainActor
final class AssistPrivateService {
    typealias Completion = (String?, NSError?) -> Void
    static let shared = AssistPrivateService()
    private var epoch = AssistPrivateServicePolicy.Epoch()
    private var activeTask: Task<Void, Never>?
    private var pending: (AssistPrivateServicePolicy.Ticket, Completion)?
    private var setupCompletion: Completion?
    private var setupNavigation: UINavigationController?
    private weak var setupForm: AssistPrivateSetupController?
    private weak var browser: SFSafariViewController?
    private var backgroundObserver: (any NSObjectProtocol)?
    private var disconnectFailed = false
    private var sourceRequest: String?
    private var sourceRevision: UUID?
    private var sourceExpiry: ContinuousClock.Instant?
    private var sourceURLs: [String: URL] = [:]
    private var researchLease: UUID?
    private var researchRequest: String?
    private var researchConfiguration: AssistPrivateServicePolicy.Configuration?
    private var researchAdmission: AssistAgentAdmission?
    private var researchNetwork: (UUID, Task<Data, Error>)?
    private var researchTitles: [String: String] = [:]

    private init() {
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.cancel() }
            }
    }

    func statusJSON() throws -> String {
        struct Status: Encodable {
            let schemaVersion = 1
            let configured: Bool
            let origin: String?
            let revision: String
            let state: String
        }
        let configuration: AssistPrivateServicePolicy.Configuration?
        if disconnectFailed { configuration = nil }
        else { configuration = try AssistPrivateCredentialStore.load() }
        return try AssistJSON.encode(Status(configured: configuration != nil, origin: configuration?.origin,
            revision: epoch.revision.uuidString, state: disconnectFailed ? "disconnect_failed" :
                (configuration == nil ? "not_configured" : "configured")))
    }

    func presentSetup(completion: @escaping Completion) {
        guard Self.foreground, researchLease == nil, browser == nil, let presenter = Self.presenter(), setupCompletion == nil else {
            completion(nil, Self.error("Ouvre Assist au premier plan et ferme le panneau déjà ouvert.")); return
        }
        cancel()
        setupCompletion = completion
        let form = AssistPrivateSetupController()
        form.initialOrigin = (try? AssistPrivateCredentialStore.load())?.origin
        form.onCancel = { [weak self] in self?.cancel() }
        form.onSubmit = { [weak self, weak form] origin, secret in
            guard let self, let form else { return }
            self.validateSetup(origin: origin, secret: secret, form: form)
        }
        let navigation = UINavigationController(rootViewController: form)
        navigation.modalPresentationStyle = .formSheet
        navigation.isModalInPresentation = true
        setupForm = form
        setupNavigation = navigation
        presenter.present(navigation, animated: true)
    }

    private func validateSetup(origin: String, secret: String, form: AssistPrivateSetupController) {
        guard Self.foreground, pending == nil, activeTask == nil, setupCompletion != nil else { return }
        do {
            let configuration = try AssistPrivateServicePolicy.configuration(origin: origin, secret: secret)
            form.setBusy(true)
            let ticket = epoch.begin()
            activeTask = Task { [weak self, weak form] in
                guard let self else { return }
                do {
                    try self.check(ticket)
                    let data = try await AssistPrivateTransport.fetch(.capabilities, configuration: configuration)
                    try self.check(ticket)
                    try AssistPrivateServicePolicy.validateCapabilities(data)
                    try AssistPrivateCredentialStore.save(configuration)
                    self.disconnectFailed = false
                    self.epoch.revoke()
                    self.activeTask = nil
                    form?.eraseSecret()
                    let callback = self.setupCompletion
                    self.setupCompletion = nil
                    let navigation = self.setupNavigation
                    self.setupNavigation = nil
                    self.setupForm = nil
                    navigation?.dismiss(animated: true)
                    do { callback?(try self.statusJSON(), nil) }
                    catch { callback?(nil, Self.error("Configuration enregistrée; son état est temporairement indisponible. Rouvre ce panneau après déverrouillage.")) }
                } catch {
                    guard self.epoch.active == ticket else { return }
                    self.epoch.cancel()
                    self.activeTask = nil
                    form?.setBusy(false)
                    form?.showError("Connexion refusée. Vérifie l’adresse HTTPS, la clé et le certificat du service.")
                }
            }
        } catch { form.showError("Saisis une origine HTTPS sans chemin et une clé de service valide.") }
    }

    func search(_ requestJSON: String, completion: @escaping Completion) {
        guard Self.foreground, researchLease == nil, pending == nil, setupCompletion == nil, !disconnectFailed else {
            completion(nil, Self.error("La recherche exige Assist au premier plan, sans opération privée en cours.")); return
        }
        do {
            let request = try AssistPrivateServicePolicy.searchRequest(requestJSON)
            guard let configuration = try AssistPrivateCredentialStore.load() else {
                throw Self.error("Configure d’abord le service privé.")
            }
            clearSources()
            let ticket = epoch.begin()
            pending = (ticket, completion)
            activeTask = Task { [weak self] in
                guard let self else { return }
                do {
                    try self.check(ticket)
                    let data = try await AssistPrivateTransport.fetch(.search(request), configuration: configuration)
                    try self.check(ticket)
                    let output = try AssistPrivateServicePolicy.searchResponse(data, requestId: request.requestId)
                    try self.storeSources(output, requestId: request.requestId)
                    self.finish(ticket, output: output, error: nil)
                } catch {
                    self.finish(ticket, output: nil,
                        error: Self.error("La recherche privée n’a pas pu être confirmée. Aucun nouvel essai automatique."))
                }
            }
        } catch { completion(nil, Self.error("La requête ou la configuration du service privé est invalide ou indisponible.")) }
    }

    func openResult(_ requestId: String, resultId: String, completion: @escaping Completion) {
        guard Self.foreground, browser == nil, setupCompletion == nil,
              sourceRequest == requestId, sourceRevision == epoch.revision,
              let expiry = sourceExpiry, ContinuousClock.now < expiry,
              let url = sourceURLs[resultId], let presenter = Self.presenter() else {
            completion(nil, Self.error("Ce résultat a expiré ou n’est plus disponible. Relance une recherche explicitement.")); return
        }
        let controller = SFSafariViewController(url: url)
        browser = controller
        presenter.present(controller, animated: true)
        completion("{\"schemaVersion\":1,\"opened\":true}", nil)
    }

    /// An explicit research turn leases this transport for its complete lifetime.
    /// No device-data tool, user history, URL or bearer credential is model input.
    func beginResearch(requestId: String, admission: AssistAgentAdmission) async throws -> UUID {
        try admission.check()
        guard Self.foreground, researchLease == nil, pending == nil, setupCompletion == nil,
              browser == nil, !disconnectFailed, let configuration = try AssistPrivateCredentialStore.load() else {
            throw Self.error("Configure le service privé et ferme toute autre opération avant la recherche.")
        }
        _ = try AssistPrivateServicePolicy.readRequest(requestId: requestId, resultId: "capability-check")
        clearSources()
        let lease = UUID()
        researchLease = lease; researchRequest = requestId
        researchConfiguration = configuration; researchAdmission = admission
        do {
            let data = try await researchFetch(.researchCapabilities, lease: lease)
            try AssistPrivateServicePolicy.validateResearchCapabilities(data)
            return lease
        } catch {
            endResearch(lease, preserveSources: false)
            throw Self.error("Le service privé ne prend pas en charge la lecture sécurisée de pages. Aucun repli automatique.")
        }
    }

    func performResearch(_ call: AssistResearchToolCall, lease: UUID) async throws -> AssistToolValue {
        try checkResearch(lease)
        guard let requestId = researchRequest else { throw CancellationError() }
        switch call.name {
        case .web_search:
            guard let query = call.arguments["query"]?.stringValue else { throw AssistPrivateServicePolicy.invalid() }
            let request = try AssistPrivateServicePolicy.searchRequest(AssistJSON.encode(AssistToolValue.object([
                "schemaVersion": .number(1), "requestId": .string(requestId), "query": .string(query)])))
            let data = try await researchFetch(.search(request), lease: lease)
            let output = try AssistPrivateServicePolicy.searchResponse(data, requestId: requestId)
            try checkResearch(lease)
            try storeSources(output, requestId: requestId)
            let result = try AssistToolValue.decodeJSON(output)
            if case .array(let hits) = result.objectDictionary?["results"] {
                researchTitles = Dictionary(uniqueKeysWithValues: try hits.map { hit in
                    guard let row = hit.objectDictionary, let id = row["id"]?.stringValue,
                          let title = row["title"]?.stringValue else { throw AssistPrivateServicePolicy.invalid() }
                    return (id, title)
                })
            }
            return result
        case .web_read:
            guard let id = call.arguments["result_id"]?.stringValue, let title = researchTitles[id], sourceURLs[id] != nil else {
                throw AssistPrivateServicePolicy.invalid()
            }
            let request = try AssistPrivateServicePolicy.readRequest(requestId: requestId, resultId: id)
            let data = try await researchFetch(.read(request), lease: lease)
            let result = try AssistPrivateServicePolicy.readResponse(data, requestId: requestId, resultId: id, title: title)
            try checkResearch(lease)
            // Browser references use the final, validated URL actually read,
            // never a model URL or an unverified redirect target.
            guard let rawURL = result.objectDictionary?["url"]?.stringValue, let url = URL(string: rawURL) else {
                throw AssistPrivateServicePolicy.invalid()
            }
            sourceURLs[id] = url
            return result
        }
    }

    func checkResearch(_ lease: UUID) throws {
        try Task.checkCancellation()
        guard Self.foreground, researchLease == lease, !disconnectFailed else { throw CancellationError() }
        try researchAdmission?.check()
    }

    func endResearch(_ lease: UUID, preserveSources: Bool) {
        guard researchLease == lease else { return }
        researchNetwork?.1.cancel(); researchNetwork = nil
        researchLease = nil; researchRequest = nil; researchConfiguration = nil
        researchAdmission = nil; researchTitles.removeAll()
        if !preserveSources { clearSources() }
    }

    func discardResearchSources(requestId: String) {
        if sourceRequest == requestId { clearSources() }
    }

    private func researchFetch(_ endpoint: AssistPrivateTransport.Endpoint, lease: UUID) async throws -> Data {
        try checkResearch(lease)
        guard researchNetwork == nil, let configuration = researchConfiguration else { throw AssistPrivateServicePolicy.invalid() }
        let networkId = UUID()
        let task = Task { try await AssistPrivateTransport.fetch(endpoint, configuration: configuration) }
        researchNetwork = (networkId, task)
        defer { if researchNetwork?.0 == networkId { researchNetwork = nil } }
        let data = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
        try checkResearch(lease)
        return data
    }

    func disconnect(completion: @escaping Completion) {
        disconnectFailed = true
        epoch.revoke()
        cancel()
        // Local revocation is effective immediately even if Keychain deletion
        // is temporarily unavailable. Never claim the server token was revoked.
        do {
            try AssistPrivateCredentialStore.delete()
            disconnectFailed = false
            completion(try statusJSON(), nil)
        } catch { completion(nil, Self.error("L’accès local est bloqué, mais la suppression du trousseau a échoué. Réessaie Déconnecter après déverrouillage.")) }
    }

    func cancel() {
        epoch.cancel() // Revoke admission synchronously BEFORE cancellation/callbacks.
        researchAdmission?.cancel()
        if let lease = researchLease { endResearch(lease, preserveSources: false) }
        activeTask?.cancel()
        activeTask = nil
        let callback = pending?.1
        pending = nil
        let setupCallback = setupCompletion
        setupCompletion = nil
        setupForm?.eraseSecret()
        setupForm = nil
        setupNavigation?.dismiss(animated: false)
        setupNavigation = nil
        browser?.dismiss(animated: false)
        browser = nil
        clearSources()
        callback?(nil, Self.error("La recherche privée a été annulée."))
        setupCallback?(nil, Self.error("La configuration privée a été annulée."))
    }

    private func check(_ ticket: AssistPrivateServicePolicy.Ticket) throws {
        try Task.checkCancellation()
        guard epoch.accepts(ticket, foreground: Self.foreground) else { throw CancellationError() }
    }

    private func finish(_ ticket: AssistPrivateServicePolicy.Ticket, output: String?, error: NSError?) {
        guard epoch.active == ticket, pending?.0 == ticket else { return }
        let completion = pending?.1
        pending = nil
        activeTask = nil
        epoch.cancel()
        completion?(output, error)
    }

    private func storeSources(_ output: String, requestId: String) throws {
        guard let object = try AssistToolValue.decodeJSON(output).objectDictionary,
              case .array(let hits) = object["results"] else { throw AssistPrivateServicePolicy.invalid() }
        var urls: [String: URL] = [:]
        for hit in hits {
            guard let row = hit.objectDictionary, let id = row["id"]?.stringValue,
                  let text = row["url"]?.stringValue, AssistPrivateServicePolicy.publicResultURL(text),
                  let url = URL(string: text) else { throw AssistPrivateServicePolicy.invalid() }
            urls[id] = url
        }
        sourceRequest = requestId
        sourceRevision = epoch.revision
        sourceExpiry = ContinuousClock.now.advanced(by: .seconds(600))
        sourceURLs = urls
    }

    private func clearSources() { sourceRequest = nil; sourceRevision = nil; sourceExpiry = nil; sourceURLs.removeAll() }
    private static var foreground: Bool { UIApplication.shared.applicationState == .active }
    private static func presenter() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        guard var controller = scene?.windows.first(where: \.isKeyWindow)?.rootViewController else { return nil }
        while let presented = controller.presentedViewController { controller = presented }
        guard !controller.isBeingDismissed else { return nil }
        return controller
    }
    private static func error(_ message: String) -> NSError {
        NSError(domain: "Assist.PrivateService", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

@MainActor
private final class AssistPrivateSetupController: UIViewController {
    var initialOrigin: String?
    var onSubmit: ((String, String) -> Void)?
    var onCancel: (() -> Void)?
    private let originField = UITextField()
    private let secretField = UITextField()
    private let statusLabel = UILabel()
    private var connectButton: UIBarButtonItem?

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Service privé Ubuntu"
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Annuler", style: .plain, target: self, action: #selector(cancelTapped))
        connectButton = UIBarButtonItem(title: "Connecter", style: .prominent, target: self, action: #selector(connectTapped))
        navigationItem.rightBarButtonItem = connectButton
        let explanation = UILabel()
        explanation.numberOfLines = 0
        explanation.font = .preferredFont(forTextStyle: .body)
        explanation.adjustsFontForContentSizeCategory = true
        explanation.text = "Gemma reste sur cet iPhone. Les recherches sont envoyées à ton service Ubuntu, puis aux moteurs Internet. La clé reste dans le trousseau de cet appareil et n’est pas partagée avec Gemma."
        originField.placeholder = "https://ubuntu.ton-domaine.ca"
        originField.text = initialOrigin
        originField.keyboardType = .URL
        originField.accessibilityLabel = "Origine HTTPS du service privé"
        secretField.placeholder = "Clé du service"
        secretField.isSecureTextEntry = true
        secretField.textContentType = .password
        secretField.accessibilityLabel = "Clé privée du service"
        for field in [originField, secretField] {
            field.borderStyle = .roundedRect
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.spellCheckingType = .no
            field.font = .preferredFont(forTextStyle: .body)
            field.adjustsFontForContentSizeCategory = true
            field.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        }
        statusLabel.numberOfLines = 0
        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.text = "HTTPS avec un certificat valide est obligatoire. Seule une origine, sans chemin ni clé dans l’URL, est acceptée."
        let stack = UIStackView(arrangedSubviews: [explanation, originField, secretField, statusLabel])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
        ])
    }

    func setBusy(_ busy: Bool) {
        connectButton?.isEnabled = !busy
        originField.isEnabled = !busy
        secretField.isEnabled = !busy
        statusLabel.text = busy ? "Vérification du service authentifié…" : "Modifie les renseignements, puis touche Connecter."
    }
    func eraseSecret() { secretField.text = nil }
    func showError(_ message: String) {
        statusLabel.text = message
        UIAccessibility.post(notification: .announcement, argument: message)
    }
    @objc private func connectTapped() { onSubmit?(originField.text ?? "", secretField.text ?? "") }
    @objc private func cancelTapped() { onCancel?() }
    override func accessibilityPerformEscape() -> Bool { onCancel?(); return true }
}
