import CryptoKit
import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif
#if canImport(FileProvider)
import FileProvider
#endif

/// An opt-in byte identity check. The caller owns the unloaded/busy gate and directory scope.
/// This file deliberately has no dependency on a model SDK or a model parser.
enum AssistModelAssetProbe {
    static let maximumReportBytes = 32 * 1024
    static let chunkBytes = 64 * 1024
    static let modelName = "gemma4-e2b-32k-group8-rmscomposite"
    static let measurementMethods = [
        "scope": "Hashes four pinned F16 asset files only; no Core AI APIs, inference, specialization, cache inspection or model writes",
        "hash": "SHA-256 over a 64 KiB read stream; whole model data is never retained",
        "stability": "Directory-relative no-follow opens; regular files only; descriptor and path identity, size, mtime and ctime checked before and after",
        "storedHash": "main.hash contains 32 raw SHA-256 bytes; compare with main.mlirb and the pinned F16 source digest",
        "unverified": "PLE and tokenizer payloads, future file stability, Core AI readability/cache state and actual accelerator placement remain unverified",
        "failure": "Constant safe error codes only; a pending record is the last persisted boundary, not proof of a crash",
    ]

    enum Role: String, Codable, Sendable {
        case bundleMetadata = "bundle_metadata"
        case assetMetadata = "asset_metadata"
        case storedMainHash = "stored_main_hash"
        case mainBytecode = "main_bytecode"
    }

    struct ExpectedFile: Sendable {
        let role: Role
        let relativePath: String
        let bytes: UInt64
        let sha256: String
    }

    static let expectedFiles = [
        ExpectedFile(role: .bundleMetadata, relativePath: "metadata.json", bytes: 1_091,
                     sha256: "2771755c5042bc9b400ff99c320b8689b32aa2751351fa5fa137df72208fa801"),
        ExpectedFile(role: .assetMetadata, relativePath: modelName + ".aimodel/metadata.json", bytes: 406,
                     sha256: "68bc28f74571f1617d9b888841d33351ebdb2f72be77294c255f520957ef92db"),
        ExpectedFile(role: .storedMainHash, relativePath: modelName + ".aimodel/main.hash", bytes: 32,
                     sha256: "abbf299e92e76280e6e5ce0bde11b9cabc5ad75c6a5f94d979299d07d3b2cece"),
        ExpectedFile(role: .mainBytecode, relativePath: modelName + ".aimodel/main.mlirb", bytes: 1_381_786_497,
                     sha256: "bd71bc0793677c4c4789b78109426b96afa2af7fc4df332f0c88695a43967362"),
    ]

    enum Stage: String, Codable, Sendable { case checkingFiles = "checking_files", completed, failed }

    enum Failure: String, Error, LocalizedError, Codable, Sendable {
        case localOnly = "E_ASSET_IDENTITY_LOCAL_ONLY"
        case io = "E_ASSET_IDENTITY_IO"
        case changed = "E_ASSET_IDENTITY_CHANGED"
        case mismatch = "E_ASSET_IDENTITY_MISMATCH"
        case persistence = "E_ASSET_IDENTITY_PERSISTENCE"
        case corruptReport = "E_ASSET_IDENTITY_CORRUPT_REPORT"

        var errorDescription: String? {
            switch self {
            case .localOnly: return "Sélectionne un dossier local entièrement téléchargé et sans lien symbolique."
            case .io: return "Un fichier autorisé n’a pas pu être lu entièrement."
            case .changed: return "Un fichier ou son emplacement a changé pendant la vérification."
            case .mismatch: return "Les fichiers sélectionnés diffèrent de l’asset F16 attendu."
            case .persistence: return "Impossible de sauvegarder le diagnostic d’identité."
            case .corruptReport: return "Le diagnostic d’identité enregistré est invalide."
            }
        }
    }

    struct Attempt: Codable, Sendable {
        let id: String
        let startedAtUTC: String
        let processIdentifier: Int32
        var entryPoint = "selected_f16_asset_identity_probe"

        static func formatter() -> ISO8601DateFormatter {
            let result = ISO8601DateFormatter()
            result.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            result.timeZone = TimeZone(secondsFromGMT: 0)
            return result
        }

        static func current() -> Attempt {
            Attempt(id: UUID().uuidString.lowercased(), startedAtUTC: formatter().string(from: Date()),
                    processIdentifier: ProcessInfo.processInfo.processIdentifier)
        }

        func validate() throws {
            let formatter = Self.formatter()
            guard id.count == 36, UUID(uuidString: id)?.uuidString.lowercased() == id,
                  startedAtUTC.utf8.count == 24, let date = formatter.date(from: startedAtUTC),
                  formatter.string(from: date) == startedAtUTC, processIdentifier > 0,
                  entryPoint == "selected_f16_asset_identity_probe" else { throw Failure.corruptReport }
        }
    }

    struct FileResult: Codable, Sendable {
        let role: Role
        let relativePath: String
        let expectedBytes: UInt64
        let expectedSHA256: String
        var bytesRead: UInt64 = 0
        var sha256: String?
        var matchesExpected: Bool?

        init(_ expected: ExpectedFile) {
            role = expected.role
            relativePath = expected.relativePath
            expectedBytes = expected.bytes
            expectedSHA256 = expected.sha256
        }
    }

    struct Report: Codable, Sendable {
        var schemaVersion = 1
        var kind = "assistModelAssetDiagnostic"
        var scope = "selected_f16_asset_identity_only_no_coreai"
        var expectedModelName = AssistModelAssetProbe.modelName
        var contextCapacity = 32_768
        let nativeBuild: String
        let osVersion: String
        var attempt = Attempt.current()
        var stage = Stage.checkingFiles
        var files = expectedFiles.map(FileResult.init)
        var currentFileRole: Role? = .bundleMetadata
        var storedMainHashMatches: Bool?
        var errorCode: Failure?
        var posixErrno: Int32?
        var measurementMethods = AssistModelAssetProbe.measurementMethods

        init(nativeBuild: String, osVersion: String) {
            self.nativeBuild = Self.label(nativeBuild, maximumBytes: 32)
            self.osVersion = Self.label(osVersion, maximumBytes: 160)
        }

        private static func label(_ text: String, maximumBytes: Int) -> String {
            guard !text.isEmpty, text.utf8.count <= maximumBytes,
                  text.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { return "unknown" }
            return text
        }

        func validate() throws {
            guard schemaVersion == 1, kind == "assistModelAssetDiagnostic",
                  scope == "selected_f16_asset_identity_only_no_coreai", expectedModelName == modelName,
                  contextCapacity == 32_768, nativeBuild == Self.label(nativeBuild, maximumBytes: 32),
                  osVersion == Self.label(osVersion, maximumBytes: 160),
                  measurementMethods == AssistModelAssetProbe.measurementMethods,
                  files.count == expectedFiles.count else { throw Failure.corruptReport }
            try attempt.validate()
            let currentIndex = expectedFiles.firstIndex { $0.role == currentFileRole }
            var sawPending = false
            for (index, pair) in zip(files, expectedFiles).enumerated() {
                let (result, expected) = pair
                guard result.role == expected.role, result.relativePath == expected.relativePath,
                      result.expectedBytes == expected.bytes, result.expectedSHA256 == expected.sha256,
                      result.bytesRead <= expected.bytes + UInt64(chunkBytes) else { throw Failure.corruptReport }
                if let digest = result.sha256 {
                    guard !sawPending, validHash(digest), result.bytesRead == expected.bytes,
                          result.matchesExpected == (digest == expected.sha256) else { throw Failure.corruptReport }
                } else {
                    sawPending = true
                    guard result.matchesExpected == nil else { throw Failure.corruptReport }
                }
                if let currentIndex {
                    if index < currentIndex, result.sha256 == nil { throw Failure.corruptReport }
                    if index > currentIndex, result.sha256 != nil || result.bytesRead != 0 { throw Failure.corruptReport }
                }
            }
            if let posixErrno {
                guard stage == .failed, errorCode == .io || errorCode == .changed,
                      (1...4095).contains(posixErrno) else { throw Failure.corruptReport }
            }
            if storedMainHashMatches != nil, files.contains(where: { $0.sha256 == nil }) { throw Failure.corruptReport }
            switch stage {
            case .checkingFiles:
                guard errorCode == nil, storedMainHashMatches == nil, currentIndex != nil else { throw Failure.corruptReport }
            case .completed:
                guard currentFileRole == nil, errorCode == nil, storedMainHashMatches == true,
                      files.allSatisfy({ $0.matchesExpected == true }) else { throw Failure.corruptReport }
            case .failed:
                guard currentIndex != nil, let errorCode,
                      [.localOnly, .io, .changed, .mismatch].contains(errorCode) else { throw Failure.corruptReport }
            }
        }
    }

    struct Store: Sendable {
        let directory: URL
        var url: URL { directory.appendingPathComponent("model-asset-diagnostic.json", isDirectory: false) }

        static func applicationSupport() throws -> Store {
            do {
                let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                       appropriateFor: nil, create: true)
                return Store(directory: base.appendingPathComponent("AssistLoadDiagnostic", isDirectory: true))
            } catch { throw Failure.persistence }
        }

        @discardableResult
        func save(_ report: Report) throws -> String {
            try report.validate()
            let data = try Self.encode(report)
            guard data.count <= maximumReportBytes else { throw Failure.persistence }
            do {
                guard directory.isFileURL else { throw Failure.persistence }
                let manager = FileManager.default
                try manager.createDirectory(at: directory, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
                guard try Snapshot(path: directory.path).isDirectory else { throw Failure.persistence }
                var existing = stat()
                let exists = url.withUnsafeFileSystemRepresentation { $0.map { lstat($0, &existing) } ?? -1 }
                guard exists == 0 ? Snapshot(existing).isRegular : errno == ENOENT else { throw Failure.persistence }
                try data.write(to: url, options: .atomic)
                try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
                let saved = try Snapshot(path: url.path)
                guard saved.isRegular, saved.mode & 0o777 == 0o600 else { throw Failure.persistence }
                return String(decoding: data, as: UTF8.self)
            } catch { throw Failure.persistence }
        }

        func readJSON() throws -> String {
            var status = stat()
            guard url.withUnsafeFileSystemRepresentation({ $0.map { lstat($0, &status) } ?? -1 }) == 0 else {
                if errno == ENOENT { return "null" }
                throw Failure.corruptReport
            }
            do {
                let before = Snapshot(status)
                guard before.isRegular, before.size > 0, before.size <= Int64(maximumReportBytes) else { throw Failure.corruptReport }
                let descriptor = url.withUnsafeFileSystemRepresentation { $0.map { open($0, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) } ?? -1 }
                guard descriptor >= 0 else { throw Failure.corruptReport }
                defer { close(descriptor) }
                guard try Snapshot(descriptor: descriptor) == before else { throw Failure.corruptReport }
                let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
                guard let data = try handle.read(upToCount: maximumReportBytes + 1), Int64(data.count) == before.size,
                      try Snapshot(descriptor: descriptor) == before,
                      try Snapshot(path: url.path) == before else { throw Failure.corruptReport }
                let report = try JSONDecoder().decode(Report.self, from: data)
                try report.validate()
                return String(decoding: try Self.encode(report), as: UTF8.self)
            } catch { throw Failure.corruptReport }
        }

        private static func encode(_ report: Report) throws -> Data {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            return try encoder.encode(report)
        }
    }

    /// Full descriptor snapshots catch in-place edits even when byte count is unchanged.
    struct Snapshot: Equatable {
        let device: Int64
        let inode: UInt64
        let size: Int64
        let mode: UInt32
        let modifiedSeconds: Int64
        let modifiedNanoseconds: Int64
        let changedSeconds: Int64
        let changedNanoseconds: Int64
        let dataless: Bool
        var isRegular: Bool { mode & UInt32(S_IFMT) == UInt32(S_IFREG) }
        var isDirectory: Bool { mode & UInt32(S_IFMT) == UInt32(S_IFDIR) }

        init(_ value: stat) {
            device = Int64(value.st_dev)
            inode = UInt64(value.st_ino)
            size = Int64(value.st_size)
            mode = UInt32(value.st_mode)
            #if canImport(Darwin)
            modifiedSeconds = Int64(value.st_mtimespec.tv_sec)
            modifiedNanoseconds = Int64(value.st_mtimespec.tv_nsec)
            changedSeconds = Int64(value.st_ctimespec.tv_sec)
            changedNanoseconds = Int64(value.st_ctimespec.tv_nsec)
            dataless = value.st_flags & UInt32(SF_DATALESS) != 0
            #else
            modifiedSeconds = Int64(value.st_mtim.tv_sec)
            modifiedNanoseconds = Int64(value.st_mtim.tv_nsec)
            changedSeconds = Int64(value.st_ctim.tv_sec)
            changedNanoseconds = Int64(value.st_ctim.tv_nsec)
            dataless = false
            #endif
        }

        init(path: String) throws {
            var value = stat()
            let result = path.withCString { pointer -> (Int32, Int32) in
                let status = lstat(pointer, &value)
                return (status, status == 0 ? 0 : errno)
            }
            guard result.0 == 0 else { throw POSIXFailure(code: result.1) }
            self.init(value)
        }

        init(descriptor: Int32) throws {
            var value = stat()
            guard fstat(descriptor, &value) == 0 else { throw POSIXFailure(code: errno) }
            self.init(value)
        }
    }

    struct ReadResult {
        let bytesRead: UInt64
        let sha256: String
        let storedDigest: String?
    }

    struct ReadFailure: Error {
        let code: Failure
        let bytesRead: UInt64
        var posixErrno: Int32?
    }

    struct POSIXFailure: Error {
        let code: Int32
    }

    /// The only test hook runs between bounded read chunks, allowing deterministic mutation checks.
    static func readFile(root: URL, expected: ExpectedFile, afterChunk: (() throws -> Void)? = nil) throws -> ReadResult {
        var bytesRead: UInt64 = 0
        do {
            guard root.isFileURL, root.host == nil || root.host == "", (root.path as NSString).isAbsolutePath,
                  !root.path.utf8.contains(0) else { throw Failure.localOnly }
            let parts = expected.relativePath.split(separator: "/", omittingEmptySubsequences: false)
            guard (1...2).contains(parts.count), parts.allSatisfy({
                !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") && !$0.utf8.contains(0)
            })
            else { throw Failure.localOnly }
            let rootBefore = try localEntry(root, directory: true)
            let rootOpen = root.withUnsafeFileSystemRepresentation { pointer -> (Int32, Int32) in
                guard let pointer else { return (-1, EINVAL) }
                let descriptor = open(pointer, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK)
                return (descriptor, descriptor < 0 ? errno : 0)
            }
            let rootFD = rootOpen.0
            guard rootFD >= 0 else { throw POSIXFailure(code: rootOpen.1) }
            defer { close(rootFD) }
            guard try Snapshot(descriptor: rootFD) == rootBefore else { throw Failure.changed }
            var parentFD = rootFD
            var parentURL = root
            var nestedFD: Int32 = -1
            defer { if nestedFD >= 0 { close(nestedFD) } }
            var parentBefore = rootBefore
            if parts.count == 2 {
                parentURL.appendPathComponent(String(parts[0]), isDirectory: true)
                parentBefore = try localEntry(parentURL, directory: true)
                let nestedOpen = String(parts[0]).withCString { pointer -> (Int32, Int32) in
                    let descriptor = openat(rootFD, pointer, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK)
                    return (descriptor, descriptor < 0 ? errno : 0)
                }
                nestedFD = nestedOpen.0
                guard nestedFD >= 0 else { throw POSIXFailure(code: nestedOpen.1) }
                parentFD = nestedFD
                guard try Snapshot(descriptor: parentFD) == parentBefore else { throw Failure.changed }
            }
            let name = String(parts[parts.count - 1])
            let fileURL = parentURL.appendingPathComponent(name, isDirectory: false)
            let before = try localEntry(fileURL, directory: false)
            let fileOpen = name.withCString { pointer -> (Int32, Int32) in
                let descriptor = openat(parentFD, pointer, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
                return (descriptor, descriptor < 0 ? errno : 0)
            }
            let descriptor = fileOpen.0
            guard descriptor >= 0 else { throw POSIXFailure(code: fileOpen.1) }
            defer { close(descriptor) }
            let opened = try Snapshot(descriptor: descriptor)
            guard opened.isRegular, opened == before else { throw Failure.changed }
            guard opened.size >= 0, UInt64(opened.size) == expected.bytes else { throw Failure.mismatch }
            var hash = SHA256()
            var buffer = [UInt8](repeating: 0, count: chunkBytes)
            var storedHash = Data()
            while true {
                let readResult = buffer.withUnsafeMutableBytes { buffer -> (Int, Int32) in
                    let count = read(descriptor, buffer.baseAddress, buffer.count)
                    return (count, count < 0 ? errno : 0)
                }
                let count = readResult.0
                if count < 0 {
                    if readResult.1 == EINTR { continue }
                    throw POSIXFailure(code: readResult.1)
                }
                if count == 0 { break }
                bytesRead += UInt64(count)
                guard bytesRead <= expected.bytes else { throw Failure.changed }
                let data = Data(buffer.prefix(count))
                hash.update(data: data)
                if expected.role == .storedMainHash {
                    guard bytesRead <= 32 else { throw Failure.mismatch }
                    storedHash.append(data)
                }
                try afterChunk?()
            }
            guard bytesRead == expected.bytes else { throw Failure.changed }
            do {
                guard try Snapshot(descriptor: descriptor) == before, try Snapshot(path: fileURL.path) == before,
                      try Snapshot(descriptor: parentFD) == parentBefore, try Snapshot(path: parentURL.path) == parentBefore,
                      try Snapshot(descriptor: rootFD) == rootBefore, try Snapshot(path: root.path) == rootBefore
                else { throw Failure.changed }
            } catch let failure as POSIXFailure {
                throw ReadFailure(code: .changed, bytesRead: bytesRead, posixErrno: failure.code)
            } catch { throw Failure.changed }
            return ReadResult(bytesRead: bytesRead, sha256: hex(hash.finalize()),
                              storedDigest: expected.role == .storedMainHash ? hex(storedHash) : nil)
        } catch let failure as ReadFailure {
            throw failure
        } catch let failure as POSIXFailure {
            throw ReadFailure(code: .io, bytesRead: bytesRead, posixErrno: failure.code)
        } catch let failure as Failure {
            throw ReadFailure(code: failure, bytesRead: bytesRead)
        } catch { throw ReadFailure(code: .io, bytesRead: bytesRead) }
    }

    private static func localEntry(_ url: URL, directory: Bool) throws -> Snapshot {
        guard url.isFileURL else { throw Failure.localOnly }
        let snapshot = try Snapshot(path: url.path)
        guard (directory ? snapshot.isDirectory : snapshot.isRegular), !snapshot.dataless else { throw Failure.localOnly }
        let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isUbiquitousItemKey,
            .ubiquitousItemDownloadingStatusKey, .ubiquitousItemIsDownloadingKey])
        #if canImport(FileProvider) && os(iOS)
        let placeholder = FileManager.default.fileExists(atPath: NSFileProviderManager.placeholderURL(for: url).path)
        #else
        let placeholder = false
        #endif
        let downloaded = values.ubiquitousItemDownloadingStatus
        guard values.isSymbolicLink == false, values.isUbiquitousItem != true, !placeholder,
              values.ubiquitousItemIsDownloading != true,
              downloaded == nil || downloaded == .current || downloaded == .downloaded,
              FileManager.default.isReadableFile(atPath: url.path) else { throw Failure.localOnly }
        return snapshot
    }

    static func lastReportJSON() throws -> String { try Store.applicationSupport().readJSON() }

    @concurrent
    static func run(path: String) async throws -> String {
        let store = try Store.applicationSupport()
        let report = Report(nativeBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
                            osVersion: ProcessInfo.processInfo.operatingSystemVersionString)
        return try execute(path: path, report: report, store: store)
    }

    /// Injectable store keeps the persistence boundary verifiable without touching app data or a model.
    static func execute(path: String, report initial: Report, store: Store) throws -> String {
        var report = initial
        try store.save(report)
        guard (path as NSString).isAbsolutePath, !path.utf8.contains(0) else {
            report.stage = .failed
            report.errorCode = .localOnly
            return try store.save(report)
        }
        let root = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
        var storedDigest: String?
        for (index, expected) in expectedFiles.enumerated() {
            report.currentFileRole = expected.role
            try store.save(report)
            do {
                let result = try readFile(root: root, expected: expected)
                report.files[index].bytesRead = result.bytesRead
                report.files[index].sha256 = result.sha256
                report.files[index].matchesExpected = result.sha256 == expected.sha256
                if let digest = result.storedDigest { storedDigest = digest }
            } catch {
                let failure = error as? ReadFailure
                report.files[index].bytesRead = failure?.bytesRead ?? 0
                report.stage = .failed
                report.errorCode = failure?.code ?? .io
                report.posixErrno = failure?.posixErrno
                return try store.save(report)
            }
            try store.save(report)
        }
        report.storedMainHashMatches = storedDigest == report.files.last?.sha256
        if report.files.allSatisfy({ $0.matchesExpected == true }), report.storedMainHashMatches == true {
            report.stage = .completed
            report.currentFileRole = nil
        } else {
            report.stage = .failed
            report.errorCode = .mismatch
        }
        return try store.save(report)
    }

    private static func validHash(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private static func hex(_ bytes: some Sequence<UInt8>) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
}
