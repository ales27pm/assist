import CryptoKit
import Darwin
import FileProvider
import Foundation
import UIKit
import UniformTypeIdentifiers

// BEGIN ADVANCED VOICE FILE CONTRACTS
/// Paths never cross the JS bridge. Models are verified against either the
/// bundled legacy manifest or a publisher-signed, host-compatible manifest.
struct AssistAdvancedVoiceConfiguration: Sendable {
    let pocketDirectory: URL
    let asrDirectory: URL
    let vadModelURL: URL
    static let presetVoice = "estelle"
    let variant: String
}

struct AssistAdvancedVoiceManifest: Decodable, Sendable {
    struct Asset: Decodable, Sendable { let path: String; let size: Int64; let sha256: String }
    struct Group: Decodable, Sendable {
        let repository: String
        let revision: String
        let files: [Asset]
    }
    let schemaVersion: Int
    let sdkRevision: String
    let groups: [String: Group]
    let packVersion: String?
    let runtimeABI: String?

    static let supportedABI = "assist-fluid-fr24-estelle-v1"

    init(schemaVersion: Int, sdkRevision: String, groups: [String: Group],
         packVersion: String? = nil, runtimeABI: String? = nil) {
        self.schemaVersion = schemaVersion; self.sdkRevision = sdkRevision; self.groups = groups
        self.packVersion = packVersion; self.runtimeABI = runtimeABI
    }

    func validated() throws -> Self {
        guard [1, 2].contains(schemaVersion), sdkRevision.count == 40,
              sdkRevision.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              Set(groups.keys) == Set(["pocket", "redux", "ultra", "silero"]) else {
            throw AssistAdvancedVoiceFiles.error("Le manifeste des modèles est incompatible.")
        }
        if schemaVersion == 2 {
            guard runtimeABI == Self.supportedABI, let packVersion, !packVersion.isEmpty,
                  packVersion.utf8.count <= 64,
                  packVersion.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45, 46, 95].contains($0) }) else {
                throw AssistAdvancedVoiceFiles.error("La version de ce pack ne correspond pas au moteur vocal installé.")
            }
        }
        var total: Int64 = 0
        for group in groups.values {
            guard group.revision.count == 40,
                  group.revision.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
                  !group.files.isEmpty, group.files.count <= 5000,
                  Set(group.files.map(\.path)).count == group.files.count else {
                throw AssistAdvancedVoiceFiles.error("Le manifeste des modèles est incomplet.")
            }
            for file in group.files {
                let parts = file.path.split(separator: "/", omittingEmptySubsequences: false)
                guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
                      file.path.utf8.count <= 512,
                      !file.path.contains("\\"), !file.path.contains("\0"), file.size > 0, file.size <= 4_000_000_000,
                      file.sha256.count == 64,
                      file.sha256.allSatisfy({ $0.isASCII && ($0.isNumber || ("a"..."f").contains(String($0))) }) else {
                    throw AssistAdvancedVoiceFiles.error("Un chemin du manifeste est invalide.")
                }
                let addition = total.addingReportingOverflow(file.size)
                guard !addition.overflow, addition.partialValue <= 16_000_000_000 else {
                    throw AssistAdvancedVoiceFiles.error("L’inventaire du pack dépasse la capacité de l’importateur.")
                }
                total = addition.partialValue
            }
        }
        return self
    }
}

enum AssistVoicePackTrust {
    static let signatureDomain = Data("org.27pm.assist.voice-pack/v2\0".utf8)
    // Only public keys belong here. Private signing keys stay outside Git.
    static let publicKeys: [String: Data] = [
        "assist-voice-release-2026-10": Data(base64Encoded: "Q5lfZePBTwY9Kjalifv9XQ2ZsKQp3h90JzsY/VwKDlc=")!
    ]
}

struct AssistVerifiedVoiceManifest: Sendable {
    let manifest: AssistAdvancedVoiceManifest
    let data: Data
    let digest: String
    let envelope: Data?
}

struct AssistVoicePackSelection: Codable, Sendable {
    let schemaVersion: Int
    let active: String
    let previous: String?
    let variant: String?
    let previousVariant: String?

    init(schemaVersion: Int, active: String, previous: String?, variant: String? = nil, previousVariant: String? = nil) {
        self.schemaVersion = schemaVersion; self.active = active; self.previous = previous
        self.variant = variant; self.previousVariant = previousVariant
    }

    func validated() throws -> Self {
        guard schemaVersion == 1, UUID(uuidString: active) != nil,
              previous.map({ UUID(uuidString: $0) != nil && $0.lowercased() != active.lowercased() }) != false,
              variant.map({ ["redux", "ultra"].contains($0) }) != false,
              previousVariant.map({ ["redux", "ultra"].contains($0) }) != false else {
            throw AssistAdvancedVoiceFiles.error("La sélection des packs est invalide.")
        }
        return self
    }

    static func compatibleVariant(preferred: String?, groups: Set<String>) throws -> String {
        if let preferred, ["redux", "ultra"].contains(preferred), groups.contains(preferred) { return preferred }
        guard let variant = ["redux", "ultra"].first(where: groups.contains) else {
            throw AssistAdvancedVoiceFiles.error("Le pack ne contient aucune variante Parakeet prise en charge.")
        }
        return variant
    }

    static func load(base: URL, legacyName: String?) throws -> Self? {
        let url = base.appendingPathComponent("selection.json")
        if FileManager.default.fileExists(atPath: url.path) {
            return try JSONDecoder().decode(Self.self, from: AssistAdvancedVoiceFiles.metadata(url, maximum: 4096)).validated()
        }
        // Migrate by pointer only: keep the already verified gigabytes in place.
        guard let legacyName else { return nil }
        return try Self(schemaVersion: 1, active: legacyName, previous: nil).validated()
    }

    func save(base: URL) throws {
        _ = try validated()
        _ = try AssistAdvancedVoiceFiles.inspect(base, directory: true)
        try JSONEncoder().encode(self).write(to: base.appendingPathComponent("selection.json"), options: .atomic)
    }
}

private struct AssistSignedVoicePack: Decodable {
    let schemaVersion: Int
    let keyId: String
    let manifestBase64: String
    let signatureBase64: String
}

/// Disk work runs off the main actor. Input is a local, materialized selection;
/// links and File Provider placeholders are rejected before opening any file.
enum AssistAdvancedVoiceFiles {
    static let manifestFilename = "assist-voice-pack.json"
    static let maximumManifestBytes = 2_000_000

    /// Read small metadata with an actual streaming bound, not a stat-then-Data
    /// allocation that a changing provider file could turn into a huge read.
    static func metadata(_ url: URL, maximum: Int = maximumManifestBytes) throws -> Data {
        let size = try inspect(url, directory: false)
        guard size > 0, size <= Int64(maximum), let input = InputStream(url: url) else {
            throw error("Le manifeste du pack est absent ou trop volumineux.")
        }
        input.open(); defer { input.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            try Task.checkCancellation()
            let count = input.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { throw error("Le manifeste du pack est illisible.") }
            if count == 0 { break }
            guard result.count <= maximum - count else { throw error("Le manifeste du pack est trop volumineux.") }
            result.append(contentsOf: buffer.prefix(count))
        }
        guard result.count == size else { throw error("Le manifeste a changé pendant l’import.") }
        return result
    }

    static func resolveManifest(from source: URL, bundledData: Data,
                                publicKeys: [String: Data] = AssistVoicePackTrust.publicKeys) throws -> AssistVerifiedVoiceManifest {
        let bundled = try JSONDecoder().decode(AssistAdvancedVoiceManifest.self, from: bundledData).validated()
        let bundledDigest = SHA256.hash(data: bundledData).map { String(format: "%02x", $0) }.joined()
        let url = source.appendingPathComponent(manifestFilename)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return AssistVerifiedVoiceManifest(manifest: bundled, data: bundledData, digest: bundledDigest, envelope: nil)
        }
        let bytes = try metadata(checkedSource(root: source, relativePath: manifestFilename), maximum: 3_000_000)
        guard let header = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let version = header["schemaVersion"] as? Int else { throw error("Le manifeste du pack est invalide.") }
        if version == 1 {
            guard header["manifestSHA256"] as? String == bundledDigest else {
                throw error("Ce pack hérité ne correspond pas aux modèles approuvés par cette app.")
            }
            return AssistVerifiedVoiceManifest(manifest: bundled, data: bundledData, digest: bundledDigest, envelope: nil)
        }
        guard version == 2, let signed = try? JSONDecoder().decode(AssistSignedVoicePack.self, from: bytes),
              signed.keyId.utf8.count <= 64, let rawKey = publicKeys[signed.keyId],
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: rawKey),
              let payload = Data(base64Encoded: signed.manifestBase64), payload.count <= maximumManifestBytes,
              let signature = Data(base64Encoded: signed.signatureBase64), signature.count == 64,
              key.isValidSignature(signature, for: AssistVoicePackTrust.signatureDomain + payload) else {
            throw error("La signature du pack est absente ou non reconnue. Le pack précédent est conservé.")
        }
        let candidate = try JSONDecoder().decode(AssistAdvancedVoiceManifest.self, from: payload).validated()
        guard candidate.schemaVersion == 2, candidate.sdkRevision == bundled.sdkRevision else {
            throw error("Ce pack nécessite un autre moteur natif.")
        }
        // Signed data cannot select other models or paths outside this fixed
        // native adapter. Inner compiled-model files may evolve with the weights.
        for (name, reference) in bundled.groups {
            guard let group = candidate.groups[name], group.repository == reference.repository else {
                throw error("Le contrat des modèles du pack n’est pas pris en charge.")
            }
            let roots = Set(reference.files.compactMap { $0.path.split(separator: "/").first.map(String.init) })
            let candidateRoots = Set(group.files.compactMap { $0.path.split(separator: "/").first.map(String.init) })
            guard roots == candidateRoots else { throw error("Le pack ne contient pas les composants vocaux attendus.") }
        }
        return AssistVerifiedVoiceManifest(manifest: candidate, data: payload,
            digest: SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined(), envelope: bytes)
    }

    static func installedManifest(at root: URL, bundledData: Data,
                                  publicKeys: [String: Data] = AssistVoicePackTrust.publicKeys) throws -> AssistVerifiedVoiceManifest {
        let resolved = try resolveManifest(from: root, bundledData: bundledData, publicKeys: publicKeys)
        let receipt = try JSONSerialization.jsonObject(with: metadata(root.appendingPathComponent("verified.json"), maximum: 4096)) as? [String: Any]
        guard receipt?["manifestSHA256"] as? String == resolved.digest else { throw error("Le reçu du pack est incompatible.") }
        return resolved
    }

    /// Migration from the removed custom-voice feature. A corrupt preference
    /// must never point deletion at the pack, a path traversal or an external link.
    static func removeLegacyReference(base: URL, referenceName: String?, packName: String?) throws {
        guard let name = referenceName else { return }
        guard UUID(uuidString: name) != nil,
              name.lowercased() != packName?.lowercased() else {
            throw error("Ancienne référence inaccessible.")
        }
        let directory = base.appendingPathComponent(name, isDirectory: true)
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        _ = try inspect(base, directory: true)
        _ = try inspect(directory, directory: true)
        try FileManager.default.removeItem(at: directory)
    }

    static func hasProviderPlaceholder(_ url: URL) -> Bool {
#if os(iOS)
        // The app is iOS-only; FileProvider's nonreplicated placeholder lookup
        // is unavailable on macOS, where the model-free disk harness runs.
        return FileManager.default.fileExists(atPath: NSFileProviderManager.placeholderURL(for: url).path)
#else
        return false
#endif
    }
    static func error(_ message: String, code: String = "E_ADVANCED_VOICE_RESOURCES") -> NSError {
        NSError(domain: "Assist.AdvancedVoice", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message, "code": code])
    }

    static func inspect(_ url: URL, directory: Bool) throws -> Int64 {
        var info = stat()
        guard url.withUnsafeFileSystemRepresentation({ $0.map { lstat($0, &info) } ?? -1 }) == 0 else {
            throw error("Une ressource locale est absente ou inaccessible.")
        }
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey,
            .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey, .ubiquitousItemIsDownloadingKey])
        let kind = info.st_mode & S_IFMT
        guard values.isSymbolicLink == false, directory ? kind == S_IFDIR : kind == S_IFREG,
              info.st_flags & UInt32(SF_DATALESS) == 0,
              !hasProviderPlaceholder(url),
              values.ubiquitousItemIsDownloading != true,
              values.ubiquitousItemDownloadingStatus == nil || values.ubiquitousItemDownloadingStatus == .current || values.ubiquitousItemDownloadingStatus == .downloaded else {
            throw error("Choisis des fichiers déjà téléchargés sur cet iPhone, sans liens symboliques.")
        }
        return info.st_size
    }

    static func checkedSource(root: URL, relativePath: String) throws -> URL {
        _ = try inspect(root, directory: true)
        let parts = relativePath.split(separator: "/")
        var value = root
        for (index, part) in parts.enumerated() {
            value.appendPathComponent(String(part))
            _ = try inspect(value, directory: index != parts.count - 1)
        }
        return value
    }

    /// A bounded copy prevents multi-GB weights from becoming a Data allocation.
    static func copy(_ source: URL, to destination: URL, expectedSize: Int64? = nil,
                     expectedHash: String? = nil, maximum: Int64 = 4_000_000_000) throws -> String {
        let size = try inspect(source, directory: false)
        guard size > 0, size <= maximum, expectedSize == nil || size == expectedSize else {
            throw error("La taille d’un fichier ne correspond pas au pack attendu.")
        }
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let input = InputStream(url: source), let output = OutputStream(url: destination, append: false) else {
            throw error("Impossible de copier la ressource locale.")
        }
        input.open(); output.open()
        defer { input.close(); output.close() }
        let capacity = 1_048_576
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
        defer { buffer.deallocate() }
        var count: Int64 = 0
        var hasher = SHA256()
        while true {
            try Task.checkCancellation()
            let read = input.read(buffer, maxLength: capacity)
            if read == 0 { break }
            guard read > 0 else { throw error("La lecture d’un fichier a échoué.") }
            count += Int64(read)
            guard count <= size else { throw error("Un fichier a changé pendant l’import.") }
            hasher.update(bufferPointer: UnsafeRawBufferPointer(start: buffer, count: read))
            var offset = 0
            while offset < read {
                let written = output.write(buffer.advanced(by: offset), maxLength: read - offset)
                guard written > 0 else { throw error("L’espace disponible ne permet pas de copier le pack.") }
                offset += written
            }
        }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard count == size, expectedHash == nil || digest == expectedHash else {
            throw error("La vérification SHA-256 a échoué. Le pack précédent est conservé.")
        }
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
        return digest
    }

    static func importPack(from source: URL, to destination: URL,
                           manifest: AssistAdvancedVoiceManifest, digest: String, envelope: Data? = nil,
                           availableCapacity: (URL) throws -> Int64? = { url in
                               try url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage
                           }) throws -> [String] {
        let manager = FileManager.default
        let selected = ["pocket", "redux", "ultra", "silero"].filter {
            manager.fileExists(atPath: source.appendingPathComponent($0).path)
        }
        guard selected.contains("pocket"), selected.contains("silero"),
              selected.contains("redux") || selected.contains("ultra") else {
            throw error("Le dossier doit contenir PocketTTS français, Silero et Parakeet Redux ou Ultra.")
        }
        let bytes = selected.reduce(Int64(0)) { sum, name in sum + (manifest.groups[name]?.files.reduce(0) { $0 + $1.size } ?? 0) }
        let available = try availableCapacity(destination.deletingLastPathComponent())
        guard let available, available > bytes + 256_000_000 else {
            throw error("Libère assez d’espace pour une copie du pack et 256 Mo supplémentaires.")
        }
        try manager.createDirectory(at: destination, withIntermediateDirectories: true)
        var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
        var folder = destination; try folder.setResourceValues(excluded)
        for name in selected {
            guard let group = manifest.groups[name] else { throw error("Pack non reconnu.") }
            for file in group.files {
                try Task.checkCancellation()
                let sourceFile = try checkedSource(root: source, relativePath: "\(name)/\(file.path)")
                _ = try copy(sourceFile, to: destination.appendingPathComponent("\(name)/\(file.path)"),
                             expectedSize: file.size, expectedHash: file.sha256)
            }
        }
        if let envelope {
            try envelope.write(to: destination.appendingPathComponent(manifestFilename), options: .atomic)
        }
        let receipt: [String: Any] = ["schemaVersion": 1, "manifestSHA256": digest, "groups": selected]
        try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]).write(to: destination.appendingPathComponent("verified.json"), options: .atomic)
        return selected
    }
}
// END ADVANCED VOICE FILE CONTRACTS

/// One owner serializes picker/import/preferences. No model loading, microphone
/// capture or network request occurs when this screen or its status is opened.
@MainActor
@objc(AssistAdvancedVoiceResources)
final class AssistAdvancedVoiceResources: NSObject, UIDocumentPickerDelegate {
    @objc static let shared = AssistAdvancedVoiceResources()
    private let defaults = UserDefaults.standard
    private let prefix = "assist.voice.advanced."
    private var revision = 0
    private(set) var isBusy = false
    private var pickerCompletion: ((URL?, NSError?) -> Void)?
    private weak var picker: UIDocumentPickerViewController?
    private var operation: UUID?
    private var work: Task<Void, Never>?
    private var backgroundObserver: NSObjectProtocol?

    private var base: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AdvancedVoice", isDirectory: true)
    }
    private func savedURL(_ key: String) -> URL? {
        let value = key == "pack" ? (try? selection())?.active : defaults.string(forKey: prefix + key)
        guard let name = value, UUID(uuidString: name) != nil else { return nil }
        return base.appendingPathComponent(name, isDirectory: true)
    }
    private func selection() throws -> AssistVoicePackSelection? {
        try AssistVoicePackSelection.load(base: base, legacyName: defaults.string(forKey: prefix + "pack"))
    }
    private func selectedVariant() -> String {
        (try? selection())?.variant ?? defaults.string(forKey: prefix + "variant") ?? "redux"
    }
    private func bundledManifestData() throws -> Data {
        guard let url = Bundle.main.url(forResource: "AdvancedVoiceAssets", withExtension: "json") else {
            throw AssistAdvancedVoiceFiles.error("Le manifeste des voix manque dans cette version de l’app.")
        }
        return try Data(contentsOf: url)
    }
    private func installedManifest(_ root: URL) throws -> AssistVerifiedVoiceManifest {
        try AssistAdvancedVoiceFiles.installedManifest(at: root, bundledData: bundledManifestData())
    }
    private func installedGroups() -> Set<String> {
        guard let root = savedURL("pack"), let resolved = try? installedManifest(root),
              let data = try? AssistAdvancedVoiceFiles.metadata(root.appendingPathComponent("verified.json"), maximum: 4096),
              let receipt = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              receipt["manifestSHA256"] as? String == resolved.digest,
              let groups = receipt["groups"] as? [String],
              Set(groups).isSubset(of: Set(["pocket", "redux", "ultra", "silero"])) else { return [] }
        return Set(groups)
    }
    var configuration: AssistAdvancedVoiceConfiguration? {
        guard !isBusy, defaults.string(forKey: prefix + "backend") == "fluid",
              let root = savedURL("pack") else { return nil }
        let groups = installedGroups()
        let variant = selectedVariant()
        guard groups.isSuperset(of: ["pocket", "silero", variant]) else { return nil }
        return AssistAdvancedVoiceConfiguration(pocketDirectory: root.appendingPathComponent("pocket"),
            asrDirectory: root.appendingPathComponent(variant),
            vadModelURL: root.appendingPathComponent("silero/silero-vad-unified-256ms-v6.2.1.mlmodelc"),
            variant: variant)
    }
    override private init() {
        super.init()
        // Retire only the app-managed copy from the removed cloning feature.
        // The original Files selections are never stored here or touched.
        do {
            try AssistAdvancedVoiceFiles.removeLegacyReference(base: base,
                referenceName: defaults.string(forKey: prefix + "reference"),
                packName: defaults.string(forKey: prefix + "pack"))
            defaults.removeObject(forKey: prefix + "reference")
        } catch {
            // Keep the pointer to retry on next launch; never use it for speech.
        }
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.work?.cancel()
                self?.picker?.dismiss(animated: false)
                self?.finishPicker(nil, AssistAdvancedVoiceFiles.error("Import interrompu en arrière-plan.", code: "E_CANCELLED"))
            }
        }
    }
    @objc(status:)
    func status(_ completion: (String?, NSError?) -> Void) { completion(stateJSON(), nil) }
    private func stateJSON() -> String {
        let groups = installedGroups()
        let variant = selectedVariant()
        let ready = groups.isSuperset(of: ["pocket", "silero", variant])
        let selected = defaults.string(forKey: prefix + "backend") == "fluid" ? "fluid" : "apple"
        var state: [String: Any] = ["schemaVersion": 2, "revision": revision, "selectedBackend": selected,
            "selectedVariant": variant, "effectiveBackend": selected == "fluid" && ready ? "fluid" : "apple",
            "ready": ready, "resources": Dictionary(uniqueKeysWithValues: ["pocket", "redux", "ultra", "silero"].map { ($0, groups.contains($0)) }), "voice": AssistAdvancedVoiceConfiguration.presetVoice]
        if let root = savedURL("pack"), let resolved = try? installedManifest(root) {
            state["packVersion"] = resolved.manifest.packVersion ?? "legacy"
        }
        state["previousPackAvailable"] = (try? selection())?.previous != nil
        if !ready { state["reason"] = "Importe le pack local correspondant à la variante choisie." }
        return String(data: (try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])) ?? Data(), encoding: .utf8) ?? "{}"
    }
    @objc(setBackend:variant:completion:)
    func setBackend(_ backend: String, variant: String, completion: (String?, NSError?) -> Void) {
        guard !isBusy, ["apple", "fluid"].contains(backend), ["redux", "ultra"].contains(variant) else {
            completion(nil, AssistAdvancedVoiceFiles.error("Choix vocal indisponible actuellement.")); return
        }
        guard backend == "apple" || installedGroups().isSuperset(of: ["pocket", "silero", variant]) else {
            completion(nil, AssistAdvancedVoiceFiles.error("Importe le pack de modèles avant l’activation.")); return
        }
        do {
            if let current = try selection() {
                try AssistVoicePackSelection(schemaVersion: 1, active: current.active, previous: current.previous,
                    variant: variant, previousVariant: current.previousVariant).save(base: base)
            }
        } catch { completion(nil, AssistAdvancedVoiceFiles.error("Le choix vocal n’a pas pu être enregistré.")); return }
        defaults.set(variant, forKey: prefix + "variant"); defaults.set(backend, forKey: prefix + "backend")
        revision += 1; completion(stateJSON(), nil)
    }
    @objc(importPack:)
    func importPack(_ completion: @escaping (String?, NSError?) -> Void) {
        guard let token = begin(completion) else { return }
        pick(types: [.folder]) { [weak self] url, error in
            guard let self else { return }
            guard let url else { self.end(token, error, completion); return }
            let scoped = url.startAccessingSecurityScopedResource()
            let destination = self.base.appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                let bundledData = try self.bundledManifestData()
                try FileManager.default.createDirectory(at: self.base, withIntermediateDirectories: true)
                self.work = Task { [weak self] in
                    let task = Task.detached(priority: .userInitiated) {
                        let resolved = try AssistAdvancedVoiceFiles.resolveManifest(from: url, bundledData: bundledData)
                        return try AssistAdvancedVoiceFiles.importPack(from: url, to: destination,
                            manifest: resolved.manifest, digest: resolved.digest, envelope: resolved.envelope)
                    }
                    let result = await withTaskCancellationHandler(operation: { await task.result }, onCancel: { task.cancel() })
                    if scoped { url.stopAccessingSecurityScopedResource() }
                    guard let self else { try? FileManager.default.removeItem(at: destination); return }
                    switch result {
                    case .success(let groups):
                        if Task.isCancelled { try? FileManager.default.removeItem(at: destination); self.end(token, CancellationError() as NSError, completion); return }
                        do {
                            let old = try self.selection()
                            let oldVariant = self.selectedVariant()
                            let nextVariant = try AssistVoicePackSelection.compatibleVariant(preferred: oldVariant, groups: Set(groups))
                            try AssistVoicePackSelection(schemaVersion: 1, active: destination.lastPathComponent,
                                previous: old?.active, variant: nextVariant, previousVariant: old == nil ? nil : oldVariant).save(base: self.base)
                            // Only an older app-owned backup is retired, after
                            // the new active/previous pair was atomically saved.
                            if let obsolete = old?.previous {
                                try? AssistAdvancedVoiceFiles.removeLegacyReference(base: self.base,
                                    referenceName: obsolete, packName: destination.lastPathComponent)
                            }
                            self.end(token, nil, completion)
                        } catch {
                            try? FileManager.default.removeItem(at: destination)
                            self.end(token, error as NSError, completion)
                        }
                    case .failure(let error):
                        try? FileManager.default.removeItem(at: destination)
                        self.end(token, error as NSError, completion)
                    }
                }
            } catch {
                if scoped { url.stopAccessingSecurityScopedResource() }
                self.end(token, error as NSError, completion)
            }
        }
    }
    @objc(restorePreviousPack:)
    func restorePreviousPack(_ completion: (String?, NSError?) -> Void) {
        guard !isBusy else { completion(nil, AssistAdvancedVoiceFiles.error("Un import est déjà en cours.")); return }
        do {
            guard let current = try selection(), let previous = current.previous else {
                throw AssistAdvancedVoiceFiles.error("Aucun pack précédent n’est disponible.")
            }
            let root = base.appendingPathComponent(previous, isDirectory: true)
            _ = try installedManifest(root)
            let receipt = try JSONSerialization.jsonObject(with: AssistAdvancedVoiceFiles.metadata(root.appendingPathComponent("verified.json"), maximum: 4096)) as? [String: Any]
            guard let groups = receipt?["groups"] as? [String], Set(groups).isSuperset(of: ["pocket", "silero"]) else {
                throw AssistAdvancedVoiceFiles.error("Le pack précédent est incomplet.")
            }
            let variant = try AssistVoicePackSelection.compatibleVariant(preferred: current.previousVariant ?? selectedVariant(), groups: Set(groups))
            try AssistVoicePackSelection(schemaVersion: 1, active: previous, previous: current.active,
                variant: variant, previousVariant: selectedVariant()).save(base: base)
            revision += 1
            completion(stateJSON(), nil)
        } catch { completion(nil, AssistAdvancedVoiceFiles.error("Le pack précédent ne peut pas être restauré.")) }
    }
    @objc(cancelImports)
    func cancelImports() {
        work?.cancel()
        picker?.dismiss(animated: false)
        finishPicker(nil, AssistAdvancedVoiceFiles.error("Import annulé.", code: "E_CANCELLED"))
    }
    private func begin(_ completion: (String?, NSError?) -> Void) -> UUID? {
        guard !isBusy else { completion(nil, AssistAdvancedVoiceFiles.error("Un import est déjà en cours.")); return nil }
        let token = UUID(); operation = token; isBusy = true; return token
    }
    private func end(_ token: UUID, _ error: NSError?, _ completion: (String?, NSError?) -> Void) {
        guard operation == token else { return }
        operation = nil; work = nil; isBusy = false
        if let error {
            // Foundation/File Provider errors can contain selected filenames
            // and paths. Only our bounded French messages cross the bridge.
            let safe = error.domain == "Assist.AdvancedVoice" ? error :
                AssistAdvancedVoiceFiles.error("L’import local a échoué. Les ressources précédentes sont conservées.")
            completion(nil, safe)
        } else { revision += 1; completion(stateJSON(), nil) }
    }
    private func pick(types: [UTType], completion: @escaping (URL?, NSError?) -> Void) {
        guard pickerCompletion == nil,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }),
              var presenter = scene.windows.first(where: \.isKeyWindow)?.rootViewController else {
            completion(nil, AssistAdvancedVoiceFiles.error("Impossible d’ouvrir Fichiers actuellement.")); return
        }
        while let presented = presenter.presentedViewController { presenter = presented }
        guard !presenter.isBeingDismissed else { completion(nil, AssistAdvancedVoiceFiles.error("Attends la fermeture de la fenêtre précédente.")); return }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
        picker.allowsMultipleSelection = false; picker.delegate = self
        self.picker = picker; pickerCompletion = completion
        presenter.present(picker, animated: true)
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard controller === picker, let url = urls.first, url.isFileURL else { return }
        // Finish the selection after UIKit has dismissed its picker.
        controller.dismiss(animated: true) { [weak self] in self?.finishPicker(url, nil) }
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard controller === picker else { return }
        finishPicker(nil, AssistAdvancedVoiceFiles.error("Import annulé.", code: "E_CANCELLED"))
    }
    private func finishPicker(_ url: URL?, _ error: NSError?) {
        let completion = pickerCompletion; pickerCompletion = nil; picker = nil; completion?(url, error)
    }
}
