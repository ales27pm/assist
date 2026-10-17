import AVFoundation
import CryptoKit
import Darwin
import FileProvider
import Foundation
import UIKit
import UniformTypeIdentifiers

// BEGIN ADVANCED VOICE FILE CONTRACTS
/// Paths never cross the JS bridge. Every model was copied and hashed against
/// the manifest shipped with this build before this configuration can exist.
struct AssistAdvancedVoiceConfiguration: Sendable {
    let pocketDirectory: URL
    let asrDirectory: URL
    let vadModelURL: URL
    let referenceAudioURL: URL
    let voiceConditioningURL: URL
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

    func validated() throws -> Self {
        guard schemaVersion == 1, sdkRevision.count == 40,
              Set(groups.keys) == Set(["pocket", "redux", "ultra", "silero"]) else {
            throw AssistAdvancedVoiceFiles.error("Le manifeste des modèles est incompatible.")
        }
        for group in groups.values {
            guard group.revision.count == 40, !group.files.isEmpty, group.files.count <= 5000,
                  Set(group.files.map(\.path)).count == group.files.count else {
                throw AssistAdvancedVoiceFiles.error("Le manifeste des modèles est incomplet.")
            }
            for file in group.files {
                let parts = file.path.split(separator: "/", omittingEmptySubsequences: false)
                guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
                      !file.path.contains("\\"), !file.path.contains("\0"), file.size > 0,
                      file.sha256.count == 64,
                      file.sha256.allSatisfy({ $0.isASCII && ($0.isNumber || ("a"..."f").contains(String($0))) }) else {
                    throw AssistAdvancedVoiceFiles.error("Un chemin du manifeste est invalide.")
                }
            }
        }
        return self
    }
}

/// Disk work runs off the main actor. Input is a local, materialized selection;
/// links and File Provider placeholders are rejected before opening any file.
enum AssistAdvancedVoiceFiles {
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
                           manifest: AssistAdvancedVoiceManifest, digest: String) throws -> [String] {
        let manager = FileManager.default
        let selected = ["pocket", "redux", "ultra", "silero"].filter {
            manager.fileExists(atPath: source.appendingPathComponent($0).path)
        }
        guard selected.contains("pocket"), selected.contains("silero"),
              selected.contains("redux") || selected.contains("ultra") else {
            throw error("Le dossier doit contenir PocketTTS français, Silero et Parakeet Redux ou Ultra.")
        }
        let bytes = selected.reduce(Int64(0)) { sum, name in sum + (manifest.groups[name]?.files.reduce(0) { $0 + $1.size } ?? 0) }
        let available = try destination.deletingLastPathComponent().resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage
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
        guard let name = defaults.string(forKey: prefix + key), UUID(uuidString: name) != nil else { return nil }
        return base.appendingPathComponent(name, isDirectory: true)
    }
    private func manifest() throws -> (AssistAdvancedVoiceManifest, String) {
        guard let url = Bundle.main.url(forResource: "AdvancedVoiceAssets", withExtension: "json") else {
            throw AssistAdvancedVoiceFiles.error("Le manifeste des voix manque dans cette version de l’app.")
        }
        let data = try Data(contentsOf: url)
        return (try JSONDecoder().decode(AssistAdvancedVoiceManifest.self, from: data).validated(),
                SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
    }
    private func installedGroups() -> Set<String> {
        guard let root = savedURL("pack"), let (_, digest) = try? manifest(),
              let data = try? Data(contentsOf: root.appendingPathComponent("verified.json")),
              let receipt = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              receipt["manifestSHA256"] as? String == digest,
              let groups = receipt["groups"] as? [String] else { return [] }
        return Set(groups)
    }
    private func referenceReceipt() -> [String: Any]? {
        guard let root = savedURL("reference"),
              FileManager.default.fileExists(atPath: root.appendingPathComponent("reference.wav").path),
              FileManager.default.fileExists(atPath: root.appendingPathComponent("consent.document").path),
              let data = try? Data(contentsOf: root.appendingPathComponent("consent.json")),
              let receipt = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              receipt["consentConfirmed"] as? Bool == true else { return nil }
        return receipt
    }
    var configuration: AssistAdvancedVoiceConfiguration? {
        guard !isBusy, defaults.string(forKey: prefix + "backend") == "fluid",
              let root = savedURL("pack"), let reference = savedURL("reference"), referenceReceipt() != nil else { return nil }
        let groups = installedGroups()
        let variant = defaults.string(forKey: prefix + "variant") ?? "redux"
        guard groups.isSuperset(of: ["pocket", "silero", variant]) else { return nil }
        return AssistAdvancedVoiceConfiguration(pocketDirectory: root.appendingPathComponent("pocket"),
            asrDirectory: root.appendingPathComponent(variant),
            vadModelURL: root.appendingPathComponent("silero/silero-vad-unified-256ms-v6.2.1.mlmodelc"),
            referenceAudioURL: reference.appendingPathComponent("reference.wav"),
            voiceConditioningURL: reference.appendingPathComponent("conditioning.safetensors"), variant: variant)
    }
    override private init() {
        super.init()
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
        let groups = installedGroups(), reference = referenceReceipt()
        let variant = defaults.string(forKey: prefix + "variant") ?? "redux"
        let ready = groups.isSuperset(of: ["pocket", "silero", variant]) && reference != nil
        let selected = defaults.string(forKey: prefix + "backend") == "fluid" ? "fluid" : "apple"
        var ref: [String: Any] = ["ready": reference != nil]
        if let name = reference?["speakerName"] as? String { ref["speakerName"] = name }
        var state: [String: Any] = ["schemaVersion": 1, "revision": revision, "selectedBackend": selected,
            "selectedVariant": variant, "effectiveBackend": selected == "fluid" && ready ? "fluid" : "apple",
            "ready": ready, "resources": Dictionary(uniqueKeysWithValues: ["pocket", "redux", "ultra", "silero"].map { ($0, groups.contains($0)) }), "reference": ref]
        if !ready { state["reason"] = reference == nil ? "Importe la voix et son consentement pour activer la pile avancée." : "Importe le pack local correspondant à la variante choisie." }
        return String(data: (try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])) ?? Data(), encoding: .utf8) ?? "{}"
    }
    @objc(setBackend:variant:completion:)
    func setBackend(_ backend: String, variant: String, completion: (String?, NSError?) -> Void) {
        guard !isBusy, ["apple", "fluid"].contains(backend), ["redux", "ultra"].contains(variant) else {
            completion(nil, AssistAdvancedVoiceFiles.error("Choix vocal indisponible actuellement.")); return
        }
        guard backend == "apple" || (installedGroups().isSuperset(of: ["pocket", "silero", variant]) && referenceReceipt() != nil) else {
            completion(nil, AssistAdvancedVoiceFiles.error("Importe le pack, une référence vocale et son consentement avant l’activation.")); return
        }
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
                let (manifest, digest) = try self.manifest()
                try FileManager.default.createDirectory(at: self.base, withIntermediateDirectories: true)
                self.work = Task { [weak self] in
                    let task = Task.detached(priority: .userInitiated) {
                        try AssistAdvancedVoiceFiles.importPack(from: url, to: destination, manifest: manifest, digest: digest)
                    }
                    let result = await withTaskCancellationHandler(operation: { await task.result }, onCancel: { task.cancel() })
                    if scoped { url.stopAccessingSecurityScopedResource() }
                    guard let self else { try? FileManager.default.removeItem(at: destination); return }
                    switch result {
                    case .success:
                        if Task.isCancelled { try? FileManager.default.removeItem(at: destination); self.end(token, CancellationError() as NSError, completion); return }
                        let old = self.savedURL("pack")
                        self.defaults.set(destination.lastPathComponent, forKey: self.prefix + "pack")
                        if let old { try? FileManager.default.removeItem(at: old) }
                        self.end(token, nil, completion)
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
    @objc(importReference:completion:)
    func importReference(_ consentJSON: String, completion: @escaping (String?, NSError?) -> Void) {
        guard let data = consentJSON.data(using: .utf8), data.count <= 2048,
              let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              value["consentConfirmed"] as? Bool == true,
              let speaker = value["speakerName"] as? String,
              !speaker.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, speaker.utf16.count <= 120 else {
            completion(nil, AssistAdvancedVoiceFiles.error("Confirme les droits de clonage et indique la personne concernée.")); return
        }
        guard let token = begin(completion) else { return }
        pick(types: [.wav]) { [weak self] audio, error in
            guard let self else { return }
            guard let audio else { self.end(token, error, completion); return }
            let audioScope = audio.startAccessingSecurityScopedResource()
            self.pick(types: [.pdf, .plainText, .json]) { [weak self] document, error in
                guard let self else { if audioScope { audio.stopAccessingSecurityScopedResource() }; return }
                guard let document else { if audioScope { audio.stopAccessingSecurityScopedResource() }; self.end(token, error, completion); return }
                let documentScope = document.startAccessingSecurityScopedResource()
                let destination = self.base.appendingPathComponent(UUID().uuidString, isDirectory: true)
                self.work = Task { [weak self] in
                    let task = Task.detached(priority: .userInitiated) {
                        _ = try AssistAdvancedVoiceFiles.inspect(audio, directory: false)
                        let file = try AVAudioFile(forReading: audio)
                        let seconds = Double(file.length) / file.processingFormat.sampleRate
                        guard seconds.isFinite, (3...30).contains(seconds),
                              (1...2).contains(file.processingFormat.channelCount) else {
                            throw AssistAdvancedVoiceFiles.error("Choisis une référence WAV de 3 à 30 secondes, mono ou stéréo.")
                        }
                        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
                        var folder = destination; var values = URLResourceValues(); values.isExcludedFromBackup = true; try folder.setResourceValues(values)
                        let audioHash = try AssistAdvancedVoiceFiles.copy(audio, to: destination.appendingPathComponent("reference.wav"), maximum: 32_000_000)
                        let documentHash = try AssistAdvancedVoiceFiles.copy(document, to: destination.appendingPathComponent("consent.document"), maximum: 5_000_000)
                        let receipt: [String: Any] = ["schemaVersion": 1, "speakerName": speaker,
                            "consentConfirmed": true, "scope": "local voice conditioning and synthesis in Assist",
                            "audioSHA256": audioHash, "documentSHA256": documentHash, "importedAt": ISO8601DateFormatter().string(from: Date())]
                        try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]).write(to: destination.appendingPathComponent("consent.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                    }
                    let result = await withTaskCancellationHandler(operation: { await task.result }, onCancel: { task.cancel() })
                    if audioScope { audio.stopAccessingSecurityScopedResource() }
                    if documentScope { document.stopAccessingSecurityScopedResource() }
                    guard let self else { try? FileManager.default.removeItem(at: destination); return }
                    switch result {
                    case .success:
                        if Task.isCancelled { try? FileManager.default.removeItem(at: destination); self.end(token, CancellationError() as NSError, completion); return }
                        let old = self.savedURL("reference")
                        self.defaults.set(destination.lastPathComponent, forKey: self.prefix + "reference")
                        if let old { try? FileManager.default.removeItem(at: old) }
                        self.end(token, nil, completion)
                    case .failure(let error):
                        try? FileManager.default.removeItem(at: destination); self.end(token, error as NSError, completion)
                    }
                }
            }
        }
    }
    @objc(removeReference:)
    func removeReference(_ completion: (String?, NSError?) -> Void) {
        guard !isBusy else { completion(nil, AssistAdvancedVoiceFiles.error("Un import est en cours.")); return }
        let old = savedURL("reference")
        do {
            if let old, FileManager.default.fileExists(atPath: old.path) {
                try FileManager.default.removeItem(at: old)
            }
        } catch {
            // Keep the pointer so the user can retry deletion. Never report a
            // deleted reference while the audio/consent still lives on disk.
            completion(nil, AssistAdvancedVoiceFiles.error("La suppression de la référence a échoué. Réessaie pour retirer ses fichiers.")); return
        }
        defaults.removeObject(forKey: prefix + "reference"); defaults.set("apple", forKey: prefix + "backend")
        revision += 1; completion(stateJSON(), nil)
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
        // UIKit dismisses the first picker before a second can be presented.
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
