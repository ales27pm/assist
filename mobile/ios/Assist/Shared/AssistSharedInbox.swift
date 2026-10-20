import Foundation
import Synchronization
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Per-import admission, shared across provider callbacks and lifecycle UI.
/// Cancellation and the small metadata publication are serialized by one lock;
/// payload copying and NSFileCoordinator waits never hold this lock.
final class AssistInboxAdmission: Sendable {
    private let active = Mutex(true)

    func cancel() { active.withLock { $0 = false } }
    func check() throws { guard active.withLock({ $0 }) else { throw CancellationError() } }

    func publish<Value>(_ operation: () throws -> Value) throws -> Value {
        try active.withLock { admitted in
            guard admitted else { throw CancellationError() }
            return try operation()
        }
    }
}

enum AssistInboxError: Error, LocalizedError, Sendable {
    case unavailable, invalidItem, unsupported, oversized, full, conflict, missing
    var errorDescription: String? {
        switch self {
        case .unavailable: "La boîte de réception partagée est indisponible."
        case .invalidItem: "Le document importé ne respecte pas le contrat."
        case .unsupported: "Ce type de document n’est pas pris en charge."
        case .oversized: "Le document dépasse la limite de taille."
        case .full: "La boîte de réception est pleine. Supprime des documents avant de continuer."
        case .conflict: "Cet import possède déjà un contenu différent. Aucun remplacement effectué."
        case .missing: "Ce document a expiré ou a été supprimé."
        }
    }
}

/// Shared by the app, Share extension and widget. No engine, network, account,
/// secrets or conversation history belong in this container. All writes use the
/// same NSFileCoordinator root; an actor alone cannot serialize three processes.
struct AssistSharedInbox: Sendable {
    static let groupIdentifier = "group.org.27pm.assist"
    static let widgetKind = "AssistLauncher"
    static let maximumItemBytes = 8 * 1024 * 1024
    static let maximumTextBytes = 64 * 1024
    static let maximumTotalBytes = 24 * 1024 * 1024
    static let maximumItems = 20
    static let lifetime: TimeInterval = 7 * 24 * 60 * 60
    static let consumedLifetime: TimeInterval = 24 * 60 * 60

    enum Kind: String, Codable, Sendable { case text, url, image, pdf }
    enum Source: String, Codable, Sendable { case picker, share }
    struct Item: Codable, Equatable, Sendable {
        let schemaVersion: Int
        let id: String
        let kind: Kind
        let source: Source
        let byteCount: Int
        let createdAt: Date
        var consumedAt: Date?
    }
    struct Content: Sendable { let item: Item; let data: Data }
    private let root: URL

    /// The caller supplies only a system-owned group URL (or an isolated test
    /// directory), never a model/JS path. Resolve this trusted root exactly once.
    init(containerURL: URL) throws {
        guard containerURL.isFileURL else { throw AssistInboxError.unavailable }
        let container = containerURL.standardizedFileURL.resolvingSymlinksInPath()
        root = container.appendingPathComponent("AssistInbox-v1", isDirectory: true)
        let manager = FileManager.default
        if !manager.fileExists(atPath: root.path) {
            try manager.createDirectory(at: root, withIntermediateDirectories: false,
                                        attributes: [.posixPermissions: 0o700])
        }
        try verifyDirectory()
        try protect(root, directory: true)
    }

    static func appGroup() throws -> Self {
#if canImport(Darwin)
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupIdentifier) else {
            throw AssistInboxError.unavailable
        }
        return try Self(containerURL: container)
#else
        throw AssistInboxError.unavailable
#endif
    }

    /// Identity is generated once per user import gesture and reused through
    /// callbacks. A duplicate matching submission is a read, not another import.
    func save(id: UUID, kind: Kind, data: Data, source: Source, now: Date = Date(),
              admission: AssistInboxAdmission? = nil,
              beforeMetadataPublication: (() throws -> Void)? = nil) throws -> Item {
        try validate(data, kind: kind)
        return try coordinated {
            // A cancelled import may have been waiting for another process's
            // file coordination. Recheck admission only AFTER acquiring it.
            try admission?.check()
            let items = try maintain(now: now)
            let identifier = id.uuidString.lowercased()
            if let previous = items.first(where: { $0.id == identifier }) {
                guard previous.kind == kind, previous.source == source,
                      try readPayload(previous) == data else { throw AssistInboxError.conflict }
                return previous
            }
            guard items.count < Self.maximumItems,
                  items.reduce(0, { $0 + $1.byteCount }) + data.count <= Self.maximumTotalBytes else {
                throw AssistInboxError.full
            }
            let item = Item(schemaVersion: 1, id: identifier, kind: kind, source: source,
                            byteCount: data.count, createdAt: now, consumedAt: nil)
            let payload = payloadURL(identifier)
            try admission?.check()
            try write(data, to: payload)
            do {
                let metadata = try Self.encoder().encode(item)
                try write(metadata, to: metadataURL(identifier), admission: admission,
                          beforePublication: beforeMetadataPublication)
            }
            catch { try? FileManager.default.removeItem(at: payload); throw error }
            // Publication succeeded. A later cancellation never undoes a
            // committed user import; its stable ID remains recoverable in list.
            return item
        }
    }

    func list(now: Date = Date()) throws -> [Item] {
        try coordinated { try maintain(now: now).sorted { $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt } }
    }

    /// Repeated consumption returns the same bytes and never creates an action.
    /// The small receipt survives for one day; pending imports expire in 7 days.
    func consume(_ id: String, now: Date = Date()) throws -> Content {
        try validIdentifier(id)
        return try coordinated {
            guard var item = try maintain(now: now).first(where: { $0.id == id }) else { throw AssistInboxError.missing }
            let data = try readPayload(item)
            if item.consumedAt == nil {
                item.consumedAt = now
                try write(try Self.encoder().encode(item), to: metadataURL(id))
            }
            return Content(item: item, data: data)
        }
    }

    @discardableResult
    func remove(_ id: String, now: Date = Date()) throws -> Bool {
        try validIdentifier(id)
        return try coordinated {
            guard try maintain(now: now).contains(where: { $0.id == id }) else { return false }
            // Remove the published metadata first; any crash leaves only a
            // non-published payload which maintain() removes before next use.
            try FileManager.default.removeItem(at: metadataURL(id))
            try FileManager.default.removeItem(at: payloadURL(id))
            return true
        }
    }

    static func encoded<T: Encodable>(_ value: T) throws -> String {
        guard let json = String(data: try encoder().encode(value), encoding: .utf8) else { throw AssistInboxError.invalidItem }
        return json
    }

    /// Bounded read before decoding or copying provider-controlled content.
    static func readSelectedFile(_ url: URL, maximumBytes: Int = maximumItemBytes) throws -> Data {
        guard url.isFileURL else { throw AssistInboxError.invalidItem }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber,
              size.int64Value > 0, size.int64Value <= Int64(maximumBytes) else { throw AssistInboxError.oversized }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
        guard !data.isEmpty, data.count <= maximumBytes, data.count == size.intValue else { throw AssistInboxError.oversized }
        return data
    }

    static func safeWebURL(_ raw: String) throws -> String {
        guard raw.utf8.count <= 4096, let components = URLComponents(string: raw),
              ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
              components.host?.isEmpty == false, components.user == nil, components.password == nil,
              !raw.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw AssistInboxError.invalidItem }
        return raw
    }

    private func validate(_ data: Data, kind: Kind) throws {
        guard !data.isEmpty, data.count <= Self.maximumItemBytes else { throw AssistInboxError.oversized }
        switch kind {
        case .text, .url:
            guard data.count <= Self.maximumTextBytes, let text = String(data: data, encoding: .utf8),
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AssistInboxError.invalidItem }
            if kind == .url { _ = try Self.safeWebURL(text) }
        case .pdf:
            guard data.starts(with: Data("%PDF-".utf8)) else { throw AssistInboxError.invalidItem }
        case .image: break // Actual image metadata/pixel checks precede OCR in app.
        }
    }

    private func maintain(now: Date) throws -> [Item] {
        try verifyDirectory()
        let manager = FileManager.default
        let urls = try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        guard urls.count <= Self.maximumItems * 4 + 8 else { throw AssistInboxError.full }
        // A crash before the atomic rename may leave only a protected staging
        // file. It was never published and is safe to remove under coordination.
        for url in urls where url.pathExtension == "stage" {
            try validIdentifier(url.deletingPathExtension().lastPathComponent)
            try verifyRegular(url)
            try manager.removeItem(at: url)
        }
        var items: [Item] = []
        for url in urls where url.pathExtension == "json" {
            let id = url.deletingPathExtension().lastPathComponent
            try validIdentifier(id)
            let bytes = try Self.readSelectedFile(url, maximumBytes: 2048)
            let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
            let required: Set<String> = ["schemaVersion", "id", "kind", "source", "byteCount", "createdAt"]
            guard let object, required.isSubset(of: Set(object.keys)),
                  Set(object.keys).isSubset(of: required.union(["consumedAt"])) else { throw AssistInboxError.invalidItem }
            let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
            let item = try decoder.decode(Item.self, from: bytes)
            guard item.schemaVersion == 1, item.id == id, item.byteCount > 0,
                  item.byteCount <= Self.maximumItemBytes, item.createdAt <= now.addingTimeInterval(300),
                  item.consumedAt.map({ $0 >= item.createdAt && $0 <= now.addingTimeInterval(300) }) ?? true else { throw AssistInboxError.invalidItem }
            let expired = now.timeIntervalSince(item.createdAt) >= Self.lifetime ||
                item.consumedAt.map({ now.timeIntervalSince($0) >= Self.consumedLifetime }) == true
            if expired {
                try manager.removeItem(at: url)
                if manager.fileExists(atPath: payloadURL(id).path) {
                    try verifyRegular(payloadURL(id)); try manager.removeItem(at: payloadURL(id))
                }
            } else {
                try verifyRegular(payloadURL(id))
                let size = try manager.attributesOfItem(atPath: payloadURL(id).path)[.size] as? NSNumber
                guard size?.intValue == item.byteCount else { throw AssistInboxError.invalidItem }
                items.append(item)
            }
        }
        let live = Set(items.map(\.id))
        for url in urls where url.pathExtension == "payload" {
            let id = url.deletingPathExtension().lastPathComponent
            try validIdentifier(id)
            if !live.contains(id), manager.fileExists(atPath: url.path) {
                try verifyRegular(url); try manager.removeItem(at: url)
            }
        }
        guard items.count <= Self.maximumItems,
              items.reduce(0, { $0 + $1.byteCount }) <= Self.maximumTotalBytes else { throw AssistInboxError.full }
        return items
    }

    private func readPayload(_ item: Item) throws -> Data {
        let data = try Self.readSelectedFile(payloadURL(item.id))
        guard data.count == item.byteCount else { throw AssistInboxError.invalidItem }
        try validate(data, kind: item.kind)
        return data
    }
    private func metadataURL(_ id: String) -> URL { root.appendingPathComponent(id + ".json") }
    private func payloadURL(_ id: String) -> URL { root.appendingPathComponent(id + ".payload") }
    private func validIdentifier(_ id: String) throws {
        guard UUID(uuidString: id)?.uuidString.lowercased() == id else { throw AssistInboxError.invalidItem }
    }
    private func verifyDirectory() throws {
        guard try FileManager.default.attributesOfItem(atPath: root.path)[.type] as? FileAttributeType == .typeDirectory else { throw AssistInboxError.invalidItem }
    }
    private func verifyRegular(_ url: URL) throws {
        guard try FileManager.default.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType == .typeRegular else { throw AssistInboxError.invalidItem }
    }
    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
    private func write(_ data: Data, to url: URL, admission: AssistInboxAdmission? = nil,
                       beforePublication: (() throws -> Void)? = nil) throws {
        if FileManager.default.fileExists(atPath: url.path) { try verifyRegular(url) }
        let staged = root.appendingPathComponent(UUID().uuidString.lowercased() + ".stage")
        defer { try? FileManager.default.removeItem(at: staged) }
#if os(iOS)
        try data.write(to: staged, options: [.atomic, .completeFileProtection])
#else
        try data.write(to: staged, options: .atomic)
#endif
        // Native-only failure/cancellation seam for the contract harness. All
        // throwing protection work finishes BEFORE destination publication.
        try beforePublication?()
        try protect(staged, directory: false)
        let publish = {
            let status = staged.path.withCString { source in
                url.path.withCString { destination in rename(source, destination) }
            }
            guard status == 0 else { throw CocoaError(.fileWriteUnknown) }
        }
        if let admission { try admission.publish(publish) }
        else { try publish() }
        // No throwing work after rename: a metadata publication is a commit,
        // never an apparent failure that lets save() remove its live payload.
    }
    private func protect(_ url: URL, directory: Bool) throws {
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: directory ? 0o700 : 0o600]
#if os(iOS)
        attributes[.protectionKey] = FileProtectionType.complete
#endif
        try FileManager.default.setAttributes(attributes, ofItemAtPath: url.path)
#if canImport(Darwin)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var target = url; try target.setResourceValues(values)
#endif
    }
    private func coordinated<T>(_ action: () throws -> T) throws -> T {
#if canImport(Darwin)
        var coordinationError: NSError?
        var result: Result<T, Error>?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: root, options: .forMerging, error: &coordinationError) { _ in
            result = Result { try action() }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw AssistInboxError.unavailable }
        return try result.get()
#else
        // Foundation-only Linux checks are deterministic and sequential. Apple
        // cross-process behavior must also be checked on the signed app targets.
        return try action()
#endif
    }
}
