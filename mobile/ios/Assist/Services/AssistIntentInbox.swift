import Foundation
import CoreSpotlight

/// A foreground App Intent may prepare data, never a consent token or executor.
/// The user must load the draft, send it and confirm the normal broker preview.
@MainActor
enum AssistIntentInbox {
    struct Draft: Codable, Sendable {
        let id: String
        let kind: String
        let prompt: String
        let createdAt: TimeInterval
        let expiresAt: TimeInterval
    }
    private static func file() throws -> URL {
        var root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("AssistIntentInbox", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try root.setResourceValues(values)
        return root.appendingPathComponent("pending.json")
    }
    static func prepare(kind: String, prompt: String, now: Date = Date()) throws {
        guard ["chat", "timer", "alarm", "scan", "translation", "document"].contains(kind),
              !prompt.isEmpty, prompt.utf8.count <= 4_000 else { throw AssistToolContractError.invalidArguments }
        try AssistToolContent.validate(prompt)
        guard try pending(now: now) == nil else { throw AssistInferenceError.invalid("Une demande Raccourcis attend déjà dans Assist. Consulte-la ou ferme-la avant d’en préparer une autre.") }
        let draft = Draft(id: UUID().uuidString, kind: kind, prompt: prompt, createdAt: now.timeIntervalSince1970, expiresAt: now.timeIntervalSince1970 + 300)
        let url = try file()
        try JSONEncoder().encode(draft).write(to: url, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        NotificationCenter.default.post(name: .init("AssistIntentDraftChanged"), object: nil)
    }
    private static func pending(now: Date) throws -> Draft? {
        let url = try file()
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]).isSymbolicLink != true,
              let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 8_192 else { throw AssistToolContractError.invalidValue }
        let draft = try JSONDecoder().decode(Draft.self, from: Data(contentsOf: url))
        guard UUID(uuidString: draft.id) != nil, draft.prompt.utf8.count <= 4_000,
              ["chat", "timer", "alarm", "scan", "translation", "document"].contains(draft.kind),
              draft.createdAt.isFinite, draft.expiresAt.isFinite, draft.expiresAt - draft.createdAt == 300 else { throw AssistToolContractError.invalidValue }
        try AssistToolContent.validate(draft.prompt)
        if now.timeIntervalSince1970 >= draft.expiresAt || now.timeIntervalSince1970 < draft.createdAt { try FileManager.default.removeItem(at: url); return nil }
        return draft
    }
    static func snapshotJSON(now: Date = Date()) throws -> String {
        struct Snapshot: Encodable { let schemaVersion = 1; let pending: Draft? }
        return try AssistJSON.encode(Snapshot(pending: pending(now: now)))
    }
    static func dismiss(_ id: String) throws -> String {
        guard UUID(uuidString: id) != nil, let draft = try pending(now: Date()), draft.id == id else { throw AssistToolContractError.invalidArguments }
        try FileManager.default.removeItem(at: file())
        NotificationCenter.default.post(name: .init("AssistIntentDraftChanged"), object: nil)
        return "{\"schemaVersion\":1,\"dismissed\":true}"
    }
    /// Spotlight is only a navigation hint. Recheck the protected, explicit
    /// opt-in manifest and live inbox ownership before making even a draft.
    static func handleSpotlight(_ activity: NSUserActivity) -> Bool {
        guard activity.activityType == CSSearchableItemActionType,
              let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
              (try? AssistDocumentSpotlight.shared.canReopen(id)) == true else { return false }
        do {
            try prepare(kind: "document", prompt: "Ouvre l’aperçu du document Assist sélectionné d’identifiant \(id), après mon accord. Ne l’envoie à aucun service distant.")
            return true
        } catch { return false }
    }
}
