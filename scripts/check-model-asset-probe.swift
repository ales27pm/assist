import CryptoKit
import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// Standalone filesystem checks; compile beside AssistModelAssetProbe.swift with Swift 6.
/// Uses small disposable fixtures only. No model SDK, device or actual model asset is involved.
@main
struct ModelAssetProbeChecks {
    typealias Probe = AssistModelAssetProbe

    static func check(_ condition: Bool, _ message: String) {
        precondition(condition, message)
    }

    static func rejected(_ code: Probe.Failure, _ operation: () throws -> Void) {
        do { try operation(); preconditionFailure("Invalid operation was accepted.") }
        catch let error as Probe.ReadFailure { check(error.code == code, "Wrong bounded read failure.") }
        catch let error as Probe.Failure { check(error == code, "Wrong bounded probe failure.") }
        catch { preconditionFailure("Unexpected unbounded failure type.") }
    }

    static func fixture(_ bytes: UInt64, _ digest: String, path: String = "metadata.json") -> Probe.ExpectedFile {
        Probe.ExpectedFile(role: .bundleMetadata, relativePath: path, bytes: bytes, sha256: digest)
    }

    static func decoded(_ json: String) throws -> Probe.Report {
        try JSONDecoder().decode(Probe.Report.self, from: Data(json.utf8))
    }

    static func main() throws {
        let manager = FileManager.default
        let temporary = manager.temporaryDirectory.appendingPathComponent("AssistAssetProbeChecks-" + UUID().uuidString)
            .resolvingSymlinksInPath()
        try manager.createDirectory(at: temporary, withIntermediateDirectories: false)
        defer { try? manager.removeItem(at: temporary) }
        let root = temporary.appendingPathComponent("selected", isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: false)
        let file = root.appendingPathComponent("metadata.json")
        let store = Probe.Store(directory: temporary.appendingPathComponent("reports", isDirectory: true))
        check(try store.readJSON() == "null", "A fresh store has no saved identity report.")
        check(Probe.expectedFiles.map(\.role) == [.bundleMetadata, .assetMetadata, .storedMainHash, .mainBytecode],
              "Exactly four pinned F16 files are allowed.")
        check(Probe.expectedFiles.last?.bytes == 1_381_786_497 && Probe.expectedFiles.last?.sha256
              == "bd71bc0793677c4c4789b78109426b96afa2af7fc4df332f0c88695a43967362", "Pinned source identity drifted.")
        check(try Probe.identity(named: Probe.modelName).files.map(\.relativePath) == Probe.expectedFiles.map(\.relativePath),
              "The original v1 identity remains pinned.")
        rejected(.corruptReport) { _ = try Probe.identity(named: "unreviewed-model") }
        rejected(.localOnly) { _ = try Probe.selectedIdentity(path: "relative-path") }
        let metadataFixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("fixtures/model-asset-identities/google-rmscomposite-metadata.json")
        let pinnedMetadata = try Data(contentsOf: metadataFixture)
        try pinnedMetadata.write(to: file)
        check(try Probe.selectedIdentity(path: root.path).modelName == Probe.modelName,
              "Choose the real pinned metadata bytes even when the selected directory has another name.")
        var changedMetadata = pinnedMetadata
        changedMetadata[changedMetadata.count - 1] = 32
        try changedMetadata.write(to: file)
        rejected(.mismatch) { _ = try Probe.selectedIdentity(path: root.path) }
        let metadataOutside = temporary.appendingPathComponent("pinned-metadata", isDirectory: false)
        try pinnedMetadata.write(to: metadataOutside)
        try manager.removeItem(at: file)
        try manager.createSymbolicLink(at: file, withDestinationURL: metadataOutside)
        rejected(.localOnly) { _ = try Probe.selectedIdentity(path: root.path) }
        try manager.removeItem(at: file)
        let abliteratedMetadataFixture = metadataFixture.deletingLastPathComponent()
            .appendingPathComponent("huihui-abliterated-rmscomposite-metadata.json")
        try Data(contentsOf: abliteratedMetadataFixture).write(to: file)
        let abliteratedIdentity = try Probe.selectedIdentity(path: root.path)
        check(abliteratedIdentity.modelName == "gemma4-e2b-32k-group8-abliterated-rmscomposite" &&
              abliteratedIdentity.files.last?.bytes == 1_381_786_507 && abliteratedIdentity.files.last?.sha256
              == "a46f84f3bf569ac06da3b86eb24400c31b367da5b831566da0786987f863c8f0",
              "Recognize only the actual independently validated abliterated asset identity.")
        let abliteratedReport = Probe.Report(identity: abliteratedIdentity, nativeBuild: "11", osVersion: "test")
        try abliteratedReport.validate()
        check(abliteratedReport.files[1].relativePath == abliteratedIdentity.modelName + ".aimodel/metadata.json",
              "Resolve all asset paths from the selected pinned identity.")
        var borrowedIdentity = abliteratedReport
        borrowedIdentity.files = Probe.expectedFiles.map(Probe.FileResult.init)
        rejected(.corruptReport) { try borrowedIdentity.validate() }
        try pinnedMetadata.write(to: file)
        check(try Probe.selectedIdentity(path: root.path).modelName == Probe.modelName,
              "Adding the derivative preserves recognition of the historical metadata.")

        // Published SHA-256 vectors and an independently computed multi-chunk fixture.
        try Data("abc".utf8).write(to: file)
        let abc = fixture(3, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        var result = try Probe.readFile(root: root, expected: abc)
        check(result.bytesRead == 3 && result.sha256 == abc.sha256, "The standard abc SHA-256 vector failed.")
        try Data().write(to: file)
        let empty = fixture(0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        result = try Probe.readFile(root: root, expected: empty)
        check(result.bytesRead == 0 && result.sha256 == empty.sha256, "The empty SHA-256 vector failed.")
        let repeated = Data(repeating: 0x61, count: 65_539)
        let multi = fixture(65_539, "2063eabf1a5e48a6a7569d05cbe722c522a6d050b1d07c5e70c906a5d0fceb18")
        try repeated.write(to: file)
        result = try Probe.readFile(root: root, expected: multi)
        check(result.bytesRead == multi.bytes && result.sha256 == multi.sha256, "Chunk boundaries changed the digest.")
        rejected(.mismatch) { _ = try Probe.readFile(root: root, expected: abc) }

        // Change bytes already read: size and the computed digest can stay unchanged;
        // descriptor timestamps must still reject the observation.
        var changed = false
        rejected(.changed) {
            _ = try Probe.readFile(root: root, expected: multi, afterChunk: {
                if changed { return }
                changed = true
                let writer = try FileHandle(forWritingTo: file)
                defer { try? writer.close() }
                try writer.write(contentsOf: Data([0x62]))
                try manager.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)], ofItemAtPath: file.path)
            })
        }
        check(changed, "The mutation check did not reach a read boundary.")
        try repeated.write(to: file)
        var truncated = false
        rejected(.changed) {
            _ = try Probe.readFile(root: root, expected: multi, afterChunk: {
                if truncated { return }
                truncated = true
                let writer = try FileHandle(forWritingTo: file)
                defer { try? writer.close() }
                try writer.truncate(atOffset: 1)
            })
        }

        // Replacing the selected path must fail even though the open descriptor
        // still refers to the readable original inode.
        try repeated.write(to: file)
        let outside = temporary.appendingPathComponent("outside")
        try repeated.write(to: outside)
        var replaced = false
        rejected(.changed) {
            _ = try Probe.readFile(root: root, expected: multi, afterChunk: {
                if replaced { return }
                replaced = true
                try manager.removeItem(at: file)
                try manager.createSymbolicLink(at: file, withDestinationURL: outside)
            })
        }
        rejected(.localOnly) { _ = try Probe.readFile(root: root, expected: multi) }
        try manager.removeItem(at: file)
        try Data("abc".utf8).write(to: file)
        let rootLink = temporary.appendingPathComponent("linked-root")
        try manager.createSymbolicLink(at: rootLink, withDestinationURL: root)
        rejected(.localOnly) { _ = try Probe.readFile(root: rootLink, expected: abc) }
        let parentLink = root.appendingPathComponent("linked-parent")
        try manager.createSymbolicLink(at: parentLink, withDestinationURL: root)
        rejected(.localOnly) { _ = try Probe.readFile(root: root, expected: fixture(3, abc.sha256, path: "linked-parent/metadata.json")) }
        rejected(.localOnly) { _ = try Probe.readFile(root: URL(string: "https://example.test/model")!, expected: abc) }
        rejected(.localOnly) { _ = try Probe.readFile(root: root, expected: fixture(3, abc.sha256, path: "../outside")) }
        try manager.removeItem(at: file)
        check(file.path.withCString { mkfifo($0, 0o600) } == 0, "Cannot create a nonregular fixture.")
        rejected(.localOnly) { _ = try Probe.readFile(root: root, expected: abc) }
        try manager.removeItem(at: file)
        try manager.createDirectory(at: file, withIntermediateDirectories: false)
        rejected(.localOnly) { _ = try Probe.readFile(root: root, expected: abc) }
        try manager.removeItem(at: file)

        // main.hash is binary digest data, never a hex text file.
        let rawDigest = Data(stride(from: 0, to: abc.sha256.count, by: 2).map { offset -> UInt8 in
            let start = abc.sha256.index(abc.sha256.startIndex, offsetBy: offset)
            return UInt8(abc.sha256[start..<abc.sha256.index(start, offsetBy: 2)], radix: 16)!
        })
        try rawDigest.write(to: file)
        let rawExpected = Probe.ExpectedFile(role: .storedMainHash, relativePath: "metadata.json", bytes: 32,
            sha256: "") // readFile observes a digest; comparison belongs to the pinned report layer.
        result = try Probe.readFile(root: root, expected: rawExpected)
        check(result.storedDigest == abc.sha256 && result.bytesRead == 32, "Raw digest bytes were interpreted as text.")

        let initial = Probe.Report(nativeBuild: "10", osVersion: "Version 27.2 (fixture)")
        let pendingJSON = try store.save(initial)
        check(try store.readJSON() == pendingJSON, "Pending report must roundtrip exactly.")
        check(try Probe.Snapshot(path: store.url.path).mode & 0o777 == 0o600, "Report permissions must be 0600.")
        let loadMarker = store.directory.appendingPathComponent("model-load-diagnostic.json")
        let marker = Data("existing load report".utf8)
        try marker.write(to: loadMarker)
        var failed = try decoded(Probe.execute(path: "relative-path", report: initial, store: store))
        check(failed.stage == .failed && failed.errorCode == .localOnly && failed.files.allSatisfy({ $0.bytesRead == 0 }),
              "Invalid paths must persist a safe failure before any model-file read.")
        try Data("abc".utf8).write(to: file)
        failed = try decoded(Probe.execute(path: root.path, report: initial, store: store))
        check(failed.stage == .failed && failed.errorCode == .mismatch && failed.currentFileRole == .bundleMetadata,
              "Wrong file size must persist a mismatch, not a successful identity check.")
        check(try Data(contentsOf: file) == Data("abc".utf8), "The diagnostic wrote to a selected model file.")
        check(try Data(contentsOf: loadMarker) == marker, "Asset diagnostics overwrote the load diagnostic.")
        try manager.removeItem(at: file)
        failed = try decoded(Probe.execute(path: root.path, report: initial, store: store))
        check(failed.stage == .failed && failed.errorCode == .io && failed.posixErrno == ENOENT,
              "Missing files must remain distinct from hash mismatches and retain actual errno.")

        var complete = initial
        for index in complete.files.indices {
            complete.files[index].bytesRead = complete.files[index].expectedBytes
            complete.files[index].sha256 = complete.files[index].expectedSHA256
            complete.files[index].matchesExpected = true
        }
        complete.stage = .completed
        complete.currentFileRole = nil
        complete.storedMainHashMatches = true
        let completeJSON = try store.save(complete)
        check(try store.readJSON() == completeJSON, "Completed report must roundtrip exactly.")
        var selfConsistentButWrong = complete
        selfConsistentButWrong.files[3].sha256 = abc.sha256
        selfConsistentButWrong.files[3].matchesExpected = true
        rejected(.corruptReport) { try selfConsistentButWrong.validate() }
        var inconsistentRawHash = complete
        inconsistentRawHash.storedMainHashMatches = false
        rejected(.corruptReport) { try inconsistentRawHash.validate() }
        var unsafeError = initial
        unsafeError.stage = .failed
        unsafeError.errorCode = .persistence
        rejected(.corruptReport) { try unsafeError.validate() }
        var wrongRole = initial
        wrongRole.currentFileRole = .mainBytecode
        rejected(.corruptReport) { try wrongRole.validate() }
        var prematureFile = initial
        prematureFile.files[3].bytesRead = 1
        rejected(.corruptReport) { try prematureFile.validate() }
        var invalidErrno = initial
        invalidErrno.posixErrno = ENOENT
        rejected(.corruptReport) { try invalidErrno.validate() }

        // Disk content is decoded and re-encoded from declared fields only.
        var object = try JSONSerialization.jsonObject(with: Data(completeJSON.utf8)) as! [String: Any]
        object["absoluteSelectedPath"] = "/private/fixture/secret"
        try JSONSerialization.data(withJSONObject: object).write(to: store.url)
        let sanitized = try store.readJSON()
        check(!sanitized.contains("absoluteSelectedPath") && !sanitized.contains("/private/fixture"),
              "Undeclared disk fields must not be replayed to JavaScript.")
        try Data(repeating: 0x20, count: Probe.maximumReportBytes + 1).write(to: store.url)
        rejected(.corruptReport) { _ = try store.readJSON() }
        try manager.removeItem(at: store.url)
        try manager.createSymbolicLink(at: store.url, withDestinationURL: outside)
        rejected(.corruptReport) { _ = try store.readJSON() }
        rejected(.persistence) { _ = try store.save(initial) }
        let blockedStore = Probe.Store(directory: outside)
        rejected(.persistence) { _ = try Probe.execute(path: root.path, report: initial, store: blockedStore) }

        if CommandLine.arguments.count > 1 {
            let source = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
            for forbidden in ["import CoreAI", "import CoreAILanguageModels", "AIModel(", "AIModelAsset(", "LanguageModelBundle("] {
                check(!source.contains(forbidden), "A byte identity action must not depend on a model API.")
            }
        }
        if CommandLine.arguments.count > 2 {
            // Synthetic contract fixture only; it is never a physical-phone observation.
            try Data(completeJSON.utf8).write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .withoutOverwriting)
        }
        print("PASS: SHA-256 vectors/chunks; mutation/path replacement; symlink/nonregular rejection; binary main.hash; bounded private report persistence; mismatch versus IO; no selected-model writes")
    }

}
