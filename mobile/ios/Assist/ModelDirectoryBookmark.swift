import Foundation

/// Main-actor owner of the selected directory and its private persistent bookmark.
/// File inspection is asynchronous; the revision guards keep old inspections from
/// replacing a newer selection or changing persistence after invalidation.
@MainActor
final class AssistModelDirectoryBookmark {
    struct Resolved {
        let url: URL
        let isStale: Bool
    }

    struct Dependencies {
        var read: () throws -> Data?
        var write: (Data?) throws -> Void
        var resolve: (Data) throws -> Resolved
        var create: (URL) throws -> Data
        var startAccess: (URL) -> Bool
        var stopAccess: (URL) -> Void
        var validate: @Sendable (URL) async throws -> Void
        var allowsUnscopedAccess: (URL) -> Bool = { _ in false }
    }

    static let storageKey = "assist.modelDirectory.bookmark.v1"
    private let dependencies: Dependencies
    private(set) var selectedURL: URL?
    private(set) var restorationError: String?
    private var ownsAccess = false
    private var revision: UInt64 = 0
    private var accessRevision: UInt64 = 0
    private var selecting = false
    private var restored = false
    private var invalidated = false
    private var restoreTask: Task<Void, Never>?

    init(dependencies: Dependencies) { self.dependencies = dependencies }

    static func read(from defaults: UserDefaults) throws -> Data? {
        guard let value = defaults.object(forKey: storageKey) else { return nil }
        guard let data = value as? Data, !data.isEmpty, data.count <= 1_048_576 else {
            throw failure("Le dossier mémorisé est invalide. Sélectionne à nouveau le modèle.")
        }
        return data
    }

    static func write(_ data: Data?, to defaults: UserDefaults) throws {
        if let data {
            guard !data.isEmpty, data.count <= 1_048_576 else {
                throw failure("Impossible de mémoriser ce dossier. Sélectionne à nouveau le modèle.")
            }
            defaults.set(data, forKey: storageKey)
            guard defaults.data(forKey: storageKey) == data else {
                throw failure("Impossible de mémoriser ce dossier. Sélectionne à nouveau le modèle.")
            }
        } else {
            defaults.removeObject(forKey: storageKey)
        }
    }

    var publicStatus: [String: Any] {
        [
            "selectedModelAvailable": selectedURL != nil,
            "selectedModelName": selectedURL.map { Self.displayName($0) } as Any? ?? NSNull(),
            "selectedModelError": restorationError as Any? ?? NSNull()
        ]
    }

    func restoreIfNeeded() async {
        guard !invalidated, !selecting, selectedURL == nil, !restored else { return }
        if let restoreTask { await restoreTask.value; return }
        let token = revision
        let task = Task { @MainActor in await self.restore(token: token) }
        restoreTask = task
        await task.value
        if revision == token { restoreTask = nil }
    }

    private func restore(token: UInt64) async {
        guard isCurrent(token), !Task.isCancelled else { return }
        do {
            guard let data = try dependencies.read() else {
                if isCurrent(token) { restored = true }
                return
            }
            let resolved = try dependencies.resolve(data)
            let scoped = try acquireAccess(resolved.url)
            defer { if scoped { dependencies.stopAccess(resolved.url) } }
            try await dependencies.validate(resolved.url)
            guard isCurrent(token), !Task.isCancelled else { return }
            if resolved.isStale {
                try dependencies.write(dependencies.create(resolved.url))
            }
            selectedURL = resolved.url
            restorationError = nil
            restored = true
        } catch {
            guard isCurrent(token), !Task.isCancelled else { return }
            // System errors can contain private absolute paths. Public status only
            // exposes this fixed localized recovery instruction.
            try? dependencies.write(nil)
            restorationError = "Le dossier mémorisé n’est plus accessible. Sélectionne à nouveau le modèle."
            restored = true
        }
    }

    func beginSelection() -> UInt64 {
        revision &+= 1
        accessRevision &+= 1
        restoreTask?.cancel()
        restoreTask = nil
        selecting = true
        return revision
    }

    func endSelection(token: UInt64) {
        guard isCurrent(token) else { return }
        selecting = false
        if selectedURL == nil { restored = false }
    }

    func select(_ candidate: URL, token: UInt64) async throws {
        guard isCurrent(token), selecting else { throw Self.cancelled() }
        let scoped = try acquireAccess(candidate)
        defer { if scoped { dependencies.stopAccess(candidate) } }
        try await dependencies.validate(candidate)
        guard isCurrent(token), selecting, !Task.isCancelled else { throw Self.cancelled() }
        // Neither failed validation nor failed persistence replaces the previous
        // working selection. There is no asynchronous gap between write and adopt.
        let bookmark = try dependencies.create(candidate)
        let previousBookmark = try? dependencies.read()
        do { try dependencies.write(bookmark) }
        catch {
            try? dependencies.write(previousBookmark)
            throw Self.failure("Impossible de mémoriser ce dossier. Le modèle précédent est conservé.")
        }
        releaseAccess()
        selectedURL = candidate
        restorationError = nil
        restored = true
    }

    /// A load/probe owns a separate scope until unload or adapter cleanup.
    func withSelectedURL() async throws -> URL {
        await restoreIfNeeded()
        guard !invalidated, let selectedURL else {
            throw Self.failure("Sélectionne d’abord un dossier de modèle.", code: "E_NO_MODEL")
        }
        let token = revision
        let accessToken = accessRevision
        let scoped: Bool
        do { scoped = try acquireAccess(selectedURL) }
        catch {
            forgetUnusableSelection(token: token)
            throw Self.failure("Le dossier du modèle n’est plus accessible. Sélectionne à nouveau le modèle.")
        }
        var transferred = false
        defer { if scoped && !transferred { dependencies.stopAccess(selectedURL) } }
        do {
            try await dependencies.validate(selectedURL)
        } catch {
            if isCurrent(token), accessRevision == accessToken { forgetUnusableSelection(token: token) }
            throw Self.failure("Le dossier du modèle n’est plus accessible. Sélectionne à nouveau le modèle.")
        }
        guard isCurrent(token), accessRevision == accessToken,
              self.selectedURL == selectedURL, !Task.isCancelled else { throw Self.cancelled() }
        if scoped && !ownsAccess { ownsAccess = true; transferred = true }
        return selectedURL
    }

    func releaseAccess() {
        accessRevision &+= 1
        if ownsAccess, let selectedURL { dependencies.stopAccess(selectedURL) }
        ownsAccess = false
    }

    /// Adapter invalidation first cancels pending walks, while an already loaded
    /// engine keeps its retained scope until its own unload has completed.
    func cancelPendingWork() {
        revision &+= 1
        accessRevision &+= 1
        restoreTask?.cancel()
        restoreTask = nil
        selecting = false
        if selectedURL == nil { restored = false }
    }

    func invalidate() {
        cancelPendingWork()
        releaseAccess()
        invalidated = true
        selectedURL = nil
    }

    private func forgetUnusableSelection(token: UInt64) {
        guard isCurrent(token) else { return }
        releaseAccess()
        selectedURL = nil
        try? dependencies.write(nil)
        restored = true
        restorationError = "Le dossier mémorisé n’est plus accessible. Sélectionne à nouveau le modèle."
    }

    private func isCurrent(_ token: UInt64) -> Bool { !invalidated && revision == token }

    private func acquireAccess(_ url: URL) throws -> Bool {
        guard url.isFileURL else { throw Self.failure("Sélectionne un dossier de modèle local.") }
        if dependencies.startAccess(url) { return true }
        // A sandbox-owned directory needs no extra scope. Never infer this from
        // readability: an external URL whose authorization was revoked is denied.
        guard dependencies.allowsUnscopedAccess(url) else {
            throw Self.failure("Impossible d’accéder au dossier. Sélectionne un modèle local autorisé.")
        }
        return false
    }

    /// Only explicit application-container roots can authorize unscoped access.
    /// Check component boundaries and every ancestor below the trusted root so
    /// a symlink in an intermediate directory cannot escape this exception.
    static func isTrustedDirectory(_ url: URL, roots: [URL],
                                   isDirectoryWithoutSymlink: (URL) -> Bool) -> Bool {
        guard url.isFileURL, url.pathComponents == url.standardizedFileURL.pathComponents else { return false }
        let components = url.pathComponents
        for root in roots where root.isFileURL {
            let rootComponents = root.standardizedFileURL.pathComponents
            guard components.starts(with: rootComponents) else { continue }
            var current = root.standardizedFileURL
            guard isDirectoryWithoutSymlink(current) else { continue }
            var valid = true
            for component in components.dropFirst(rootComponents.count) {
                current.appendPathComponent(component, isDirectory: true)
                if !isDirectoryWithoutSymlink(current) { valid = false; break }
            }
            if valid { return true }
        }
        return false
    }

    private static func displayName(_ url: URL) -> String {
        String(url.lastPathComponent.unicodeScalars.map {
            CharacterSet.controlCharacters.contains($0) ? " " : String($0)
        }.joined().prefix(160))
    }

    private static func cancelled() -> NSError {
        failure("La sélection du modèle a été annulée.", code: "E_CANCELLED")
    }

    private static func failure(_ message: String, code: String = "E_MODEL_DIRECTORY") -> NSError {
        NSError(domain: "Assist.ModelDirectoryPicker", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message, "code": code])
    }
}
