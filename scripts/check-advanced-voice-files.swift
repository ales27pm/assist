import CryptoKit
import Foundation

@main
enum CheckAdvancedVoiceFiles {
    static func expectFailure(_ label: String, _ body: () throws -> Void) throws {
        do { try body() } catch { return }
        throw NSError(domain: "Check", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected failure: \(label)"])
    }
    static func main() throws {
        let manager = FileManager.default
        let root = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: root) }
        let input = root.appendingPathComponent("source.bin")
        let bytes = Data("Known local fixture".utf8)
        try bytes.write(to: input)
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let output = root.appendingPathComponent("copied.bin")
        let copied = try AssistAdvancedVoiceFiles.copy(input, to: output, expectedSize: Int64(bytes.count), expectedHash: hash)
        let readBack = try Data(contentsOf: output)
        precondition(copied == hash && readBack == bytes)
        print("PASS real bounded copy and SHA-256")
        try expectFailure("hash mismatch") {
            _ = try AssistAdvancedVoiceFiles.copy(input, to: root.appendingPathComponent("bad-hash"), expectedHash: String(repeating: "0", count: 64))
        }
        try expectFailure("size mismatch") {
            _ = try AssistAdvancedVoiceFiles.copy(input, to: root.appendingPathComponent("bad-size"), expectedSize: 1)
        }
        try expectFailure("maximum") {
            _ = try AssistAdvancedVoiceFiles.copy(input, to: root.appendingPathComponent("oversize"), maximum: 2)
        }
        print("PASS pinned hash, size and upper bound fail closed")
        let linked = root.appendingPathComponent("link.bin")
        try manager.createSymbolicLink(at: linked, withDestinationURL: input)
        try expectFailure("symlink") { _ = try AssistAdvancedVoiceFiles.copy(linked, to: root.appendingPathComponent("unsafe")) }
        try expectFailure("directory instead of file") { _ = try AssistAdvancedVoiceFiles.copy(root, to: root.appendingPathComponent("unsafe")) }
        print("PASS symlinks and non-regular inputs rejected")
        func manifest(_ path: String) -> AssistAdvancedVoiceManifest {
            let asset = AssistAdvancedVoiceManifest.Asset(path: path, size: 1, sha256: hash)
            let group = AssistAdvancedVoiceManifest.Group(repository: "fixture", revision: String(repeating: "a", count: 40), files: [asset])
            return AssistAdvancedVoiceManifest(schemaVersion: 1, sdkRevision: String(repeating: "b", count: 40),
                groups: Dictionary(uniqueKeysWithValues: ["pocket", "redux", "ultra", "silero"].map { ($0, group) }))
        }
        _ = try manifest("model/weights.bin").validated()
        for path in ["../outside", "/absolute", "foo//bar", "foo/./bar", "foo\\bar", ""] {
            try expectFailure(path) { _ = try manifest(path).validated() }
        }
        print("PASS trusted manifest path validation")
        try expectFailure("missing selected source") { _ = try AssistAdvancedVoiceFiles.checkedSource(root: root, relativePath: "missing/weight.bin") }
        let directoryLink = root.appendingPathComponent("linked-dir")
        try manager.createSymbolicLink(at: directoryLink, withDestinationURL: root)
        try expectFailure("linked source parent") { _ = try AssistAdvancedVoiceFiles.checkedSource(root: root, relativePath: "linked-dir/source.bin") }
        print("PASS nested source components checked before reading")

        let referenceName = UUID().uuidString, packName = UUID().uuidString
        let reference = root.appendingPathComponent(referenceName)
        let pack = root.appendingPathComponent(packName)
        try manager.createDirectory(at: reference, withIntermediateDirectories: true)
        try manager.createDirectory(at: pack, withIntermediateDirectories: true)
        for name in ["reference.wav", "consent.document", "consent.json", "conditioning.safetensors"] {
            try bytes.write(to: reference.appendingPathComponent(name))
        }
        try bytes.write(to: pack.appendingPathComponent("model.bin"))
        try AssistAdvancedVoiceFiles.removeLegacyReference(base: root, referenceName: referenceName, packName: packName)
        precondition(!manager.fileExists(atPath: reference.path))
        let originalAfterMigration = try Data(contentsOf: input)
        let packAfterMigration = try Data(contentsOf: pack.appendingPathComponent("model.bin"))
        precondition(originalAfterMigration == bytes && packAfterMigration == bytes)
        // An interrupted migration may be repeated after its directory vanished.
        try AssistAdvancedVoiceFiles.removeLegacyReference(base: root, referenceName: referenceName, packName: packName)
        try AssistAdvancedVoiceFiles.removeLegacyReference(base: root, referenceName: nil, packName: packName)
        print("PASS preset migration removes only the managed reference; original files and model pack survive repeated migration")
        for name in ["../outside", packName, packName.lowercased()] {
            try expectFailure("unsafe reference migration") {
                try AssistAdvancedVoiceFiles.removeLegacyReference(base: root, referenceName: name, packName: packName)
            }
        }
        let referenceLinkName = UUID().uuidString
        try manager.createSymbolicLink(at: root.appendingPathComponent(referenceLinkName), withDestinationURL: pack)
        try expectFailure("reference directory symlink") {
            try AssistAdvancedVoiceFiles.removeLegacyReference(base: root, referenceName: referenceLinkName, packName: packName)
        }
        let protectedPack = try Data(contentsOf: pack.appendingPathComponent("model.bin"))
        precondition(protectedPack == bytes)
        print("PASS corrupt or linked legacy preferences cannot delete a model pack or escape the app directory")
    }
}
