import Foundation
import CoreSpotlight
import UniformTypeIdentifiers
import Synchronization

/// An explicitly selected, protected, on-device index. The protected manifest is
/// an allowlist: a Spotlight hit alone never authorizes reading an inbox item.
@MainActor
final class AssistDocumentSpotlight {
    static let shared = AssistDocumentSpotlight()
    private nonisolated static let domain = "org.27pm.assist.selected-documents.v1"
    private let index = CSSearchableIndex(name: "AssistSelectedDocuments-v1", protectionClass: .complete)
    private var query: CSSearchQuery?
    private var queryID: UUID?
    private var queryCompletion: (@MainActor @Sendable (Result<[(String, String)], Error>) -> Void)?
    private var mutating = false
    struct Entry: Codable, Sendable { let inboxId: String; let title: String; let expiresAt: Date }
    private init() {}

    /// Used for NSUserActivity/Spotlight routes as well as local search results.
    /// Receiving a valid-looking UUID never grants document access by itself.
    func canReopen(_ inboxId: String) throws -> Bool {
        guard UUID(uuidString: inboxId)?.uuidString.lowercased() == inboxId else { return false }
        let now = Date()
        guard try load().contains(where: { $0.inboxId == inboxId && $0.expiresAt > now }) else { return false }
        return try AssistSharedInbox.appGroup().list().contains(where: { $0.id == inboxId && Self.expiry($0) > now })
    }

    func add(_ content: AssistSharedInbox.Content, title: String, text: String, days: Int) async throws -> Date {
        guard CSSearchableIndex.isIndexingAvailable(), !mutating else { throw AssistDocumentActionsPolicy.failure(.busy) }
        try Task.checkCancellation()
        let now = Date()
        let live = try AssistSharedInbox.appGroup().list()
        var entries = try load().filter { row in row.expiresAt > now && live.contains { $0.id == row.inboxId } }
        let expiry = min(now.addingTimeInterval(Double(days) * 86400), Self.expiry(content.item))
        guard expiry > now, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AssistDocumentActionsPolicy.failure(.noText) }
        let entry = Entry(inboxId: content.item.id, title: title, expiresAt: expiry)
        entries.removeAll { $0.inboxId == content.item.id }; entries.append(entry)
        // Journal the ownership before submitting. An interrupted submission can
        // always be found and explicitly unindexed by its stable inbox ID.
        try persist(entries)
        let attributes = CSSearchableItemAttributeSet(contentType: .text)
        attributes.title = title; attributes.textContent = text
        attributes.domainIdentifier = Self.domain
        let item = CSSearchableItem(uniqueIdentifier: content.item.id, domainIdentifier: Self.domain, attributeSet: attributes)
        item.expirationDate = expiry
        mutating = true
        defer { mutating = false }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            index.indexSearchableItems([item]) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        guard try load().contains(where: { $0.inboxId == content.item.id }),
              try AssistSharedInbox.appGroup().list().contains(where: { $0.id == content.item.id }) else {
            // Deletion can occur while the OS index submission is suspended.
            // Remove any late publication rather than resurrecting a deleted item.
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                index.deleteSearchableItems(withIdentifiers: [content.item.id]) { error in
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                }
            }
            throw AssistInboxError.missing
        }
        return expiry
    }

    func remove(_ inboxId: String) async throws {
        guard !mutating else { throw AssistDocumentActionsPolicy.failure(.busy) }
        mutating = true; defer { mutating = false }
        // Remove from allowlist first: delayed Spotlight results cannot reopen it.
        var entries = try load(); entries.removeAll { $0.inboxId == inboxId }; try persist(entries)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            index.deleteSearchableItems(withIdentifiers: [inboxId]) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    /// Called by explicit inbox deletion, even when no search panel is mounted.
    func documentRemoved(_ inboxId: String) {
        do {
            var entries = try load(); entries.removeAll { $0.inboxId == inboxId }; try persist(entries)
            index.deleteSearchableItems(withIdentifiers: [inboxId], completionHandler: nil)
        } catch {
            // A corrupt/locked manifest never widens access. Global deletion is
            // limited to this app-owned domain in this dedicated index.
            index.deleteSearchableItems(withDomainIdentifiers: [Self.domain], completionHandler: nil)
        }
    }

    func search(text: String, limit: Int, completion: @escaping @MainActor @Sendable (Result<[(String, String)], Error>) -> Void) {
        guard query == nil, !mutating, CSSearchableIndex.isIndexingAvailable() else { completion(.failure(AssistDocumentActionsPolicy.failure(.busy))); return }
        do {
            // Exact live inbox ownership, expiration, and user opt-in all apply.
            let live = try AssistSharedInbox.appGroup().list()
            let now = Date()
            let previous = try load()
            let entries = previous.filter { row in
                row.expiresAt > now && live.contains { $0.id == row.inboxId && Self.expiry($0) > now }
            }
            let removed = Set(previous.map(\.inboxId)).subtracting(entries.map(\.inboxId))
            if !removed.isEmpty {
                try persist(entries)
                index.deleteSearchableItems(withIdentifiers: Array(removed), completionHandler: nil)
            }
            // Escape ALL query metacharacters; no caller-supplied predicate or
            // wildcard may broaden this app-owned, explicitly opted-in domain.
            let escaped = text.reduce(into: "") { output, character in
                if ["\\", "\"", "*", "?"].contains(character) { output.append("\\") }
                output.append(character)
            }
            let predicate = #"domainIdentifier == "\#(Self.domain)" && (title == "*\#(escaped)*"cd || textContent == "*\#(escaped)*"cd)"#
            let context = CSSearchQueryContext(); context.fetchAttributes = []
            let operation = CSSearchQuery(queryString: predicate, queryContext: context)
            operation.protectionClasses = [.complete]
            let token = UUID(); queryID = token; query = operation; queryCompletion = completion
            let accepted = Set(entries.map(\.inboxId))
            let matches = Mutex<[String]>([])
            operation.foundItemsHandler = { items in
                matches.withLock { ids in
                    for item in items where item.domainIdentifier == Self.domain && accepted.contains(item.uniqueIdentifier) {
                        if ids.count <= limit, !ids.contains(item.uniqueIdentifier) { ids.append(item.uniqueIdentifier) }
                    }
                }
            }
            operation.completionHandler = { [weak self] error in
                let ids = matches.withLock { $0 }
                Task { @MainActor [weak self] in
                    guard let self, self.queryID == token, let callback = self.queryCompletion else { return }
                    self.query = nil; self.queryID = nil; self.queryCompletion = nil
                    if let error { callback(.failure(error)); return }
                    do {
                        let stillLive = try AssistSharedInbox.appGroup().list()
                        let allowed = try self.load().filter { row in
                            row.expiresAt > Date() && stillLive.contains(where: { $0.id == row.inboxId })
                        }
                        let results = ids.compactMap { id -> (String, String)? in
                            guard stillLive.contains(where: { $0.id == id }), let row = allowed.first(where: { $0.inboxId == id }) else { return nil }
                            return (id, row.title)
                        }
                        callback(.success(results))
                    } catch { callback(.failure(error)) }
                }
            }
            operation.start()
        } catch { completion(.failure(error)) }
    }

    func cancelSearch() {
        let callback = queryCompletion
        queryID = nil; queryCompletion = nil; query?.cancel(); query = nil
        callback?(.failure(AssistDocumentActionsPolicy.failure(.cancelled)))
    }

    private static func expiry(_ item: AssistSharedInbox.Item) -> Date {
        min(item.createdAt.addingTimeInterval(AssistSharedInbox.lifetime),
            item.consumedAt?.addingTimeInterval(AssistSharedInbox.consumedLifetime) ?? .distantFuture)
    }
    private func manifest() throws -> URL {
        let manager = FileManager.default
        let root = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("AssistSelectedDocuments-v1", isDirectory: true)
        if !manager.fileExists(atPath: root.path) {
            try manager.createDirectory(at: root, withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        }
        guard try manager.attributesOfItem(atPath: root.path)[.type] as? FileAttributeType == .typeDirectory else { throw AssistInboxError.invalidItem }
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var directory = root; try directory.setResourceValues(values)
        return root.appendingPathComponent("selected.json")
    }
    private func load() throws -> [Entry] {
        let file = try manifest()
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        let data = try AssistSharedInbox.readSelectedFile(file, maximumBytes: 32 * 1024)
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let entries = try decoder.decode([Entry].self, from: data)
        guard entries.count <= AssistSharedInbox.maximumItems,
              Set(entries.map(\.inboxId)).count == entries.count,
              entries.allSatisfy({ UUID(uuidString: $0.inboxId)?.uuidString.lowercased() == $0.inboxId && !$0.title.isEmpty && $0.title.utf8.count <= 120 }) else { throw AssistInboxError.invalidItem }
        return entries
    }
    private func persist(_ entries: [Entry]) throws {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        let file = try manifest()
        if FileManager.default.fileExists(atPath: file.path) {
            guard try FileManager.default.attributesOfItem(atPath: file.path)[.type] as? FileAttributeType == .typeRegular else { throw AssistInboxError.invalidItem }
        }
        try encoder.encode(entries).write(to: file, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
