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
        if let directory = CommandLine.arguments.dropFirst().first {
            // Optional cross-language fixture: Node signed this pack and removed
            // its temporary private key before transfer. Read public data only.
            let interop = URL(fileURLWithPath: directory, isDirectory: true)
            let reference = try AssistAdvancedVoiceFiles.metadata(interop.appendingPathComponent("reference.json"))
            let publicData = try AssistAdvancedVoiceFiles.metadata(interop.appendingPathComponent("public-key.json"), maximum: 4096)
            guard let info = try JSONSerialization.jsonObject(with: publicData) as? [String: Any],
                  let keyID = info["keyId"] as? String,
                  let encodedKey = info["publicKeyBase64"] as? String,
                  let publicKey = Data(base64Encoded: encodedKey) else {
                throw NSError(domain: "Check", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid public interop fixture"])
            }
            let keys = [keyID: publicKey]
            let pack = interop.appendingPathComponent("pack", isDirectory: true)
            let verified = try AssistAdvancedVoiceFiles.resolveManifest(from: pack, bundledData: reference, publicKeys: keys)
            precondition(verified.manifest.packVersion == "interop-1.0")
            let destination = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
            _ = try AssistAdvancedVoiceFiles.importPack(from: pack, to: destination,
                manifest: verified.manifest, digest: verified.digest, envelope: verified.envelope,
                availableCapacity: { _ in 1_000_000_000 })
            let installed = try AssistAdvancedVoiceFiles.installedManifest(at: destination, bundledData: reference, publicKeys: keys)
            precondition(installed.digest == verified.digest && installed.manifest.packVersion == "interop-1.0")
            guard let signed = verified.envelope,
                  var tampered = try JSONSerialization.jsonObject(with: signed) as? [String: Any],
                  var changedManifest = try JSONSerialization.jsonObject(with: verified.data) as? [String: Any] else {
                throw NSError(domain: "Check", code: 1, userInfo: [NSLocalizedDescriptionKey: "Interop fixture must have a signed payload"])
            }
            // Keep the payload valid and host-compatible: rejection must depend
            // on the signature, not a JSON syntax error caused by our tampering.
            changedManifest["packVersion"] = "interop-tampered"
            let changedPayload = try JSONSerialization.data(withJSONObject: changedManifest)
            tampered["manifestBase64"] = changedPayload.base64EncodedString()
            let tamperedSource = root.appendingPathComponent("tampered-interop", isDirectory: true)
            try manager.createDirectory(at: tamperedSource, withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: tampered).write(to: tamperedSource.appendingPathComponent(AssistAdvancedVoiceFiles.manifestFilename))
            try expectFailure("Node-signed manifest payload tampered after signing") {
                _ = try AssistAdvancedVoiceFiles.resolveManifest(from: tamperedSource, bundledData: reference, publicKeys: keys)
            }
            print("PASS real Node-to-Swift Ed25519 pack import, receipt and payload tamper rejection")
        }
        // Actual Ed25519 and disk integration: the same host accepts distinct
        // compatible weight versions, but not a self-signed/tampered manifest.
        func manifestData(body: Data, version: String? = nil, abi: String = AssistAdvancedVoiceManifest.supportedABI) throws -> Data {
            let item: [String: Any] = ["path": "Model.mlmodelc/weight.bin", "size": body.count,
                "sha256": SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()]
            let group: [String: Any] = ["repository": "fixture", "revision": String(repeating: "a", count: 40), "files": [item]]
            var value: [String: Any] = ["schemaVersion": version == nil ? 1 : 2,
                "sdkRevision": String(repeating: "b", count: 40),
                "groups": Dictionary(uniqueKeysWithValues: ["pocket", "redux", "ultra", "silero"].map { ($0, group) })]
            if let version { value["packVersion"] = version; value["runtimeABI"] = abi }
            return try JSONSerialization.data(withJSONObject: value, options: .sortedKeys)
        }
        let bundledData = try manifestData(body: bytes)
        let signingKey = Curve25519.Signing.PrivateKey()
        let publicKeys = ["fixture": signingKey.publicKey.rawRepresentation]
        let incoming = root.appendingPathComponent("incoming")
        try manager.createDirectory(at: incoming, withIntermediateDirectories: true)
        func envelope(payload: Data, key: Curve25519.Signing.PrivateKey? = nil, keyID: String = "fixture") throws -> Data {
            let signer = key ?? signingKey
            return try JSONSerialization.data(withJSONObject: ["schemaVersion": 2, "keyId": keyID,
                "manifestBase64": payload.base64EncodedString(),
                "signatureBase64": try signer.signature(for: AssistVoicePackTrust.signatureDomain + payload).base64EncodedString()])
        }
        for (index, body) in [bytes, Data("Changed compatible weights".utf8)].enumerated() {
            let payload = try manifestData(body: body, version: "1.0.\(index)")
            let signed = try envelope(payload: payload)
            try signed.write(to: incoming.appendingPathComponent(AssistAdvancedVoiceFiles.manifestFilename))
            for name in ["pocket", "redux", "silero"] {
                let folder = incoming.appendingPathComponent("\(name)/Model.mlmodelc")
                try manager.createDirectory(at: folder, withIntermediateDirectories: true)
                try body.write(to: folder.appendingPathComponent("weight.bin"))
            }
            let resolved = try AssistAdvancedVoiceFiles.resolveManifest(from: incoming, bundledData: bundledData, publicKeys: publicKeys)
            precondition(resolved.manifest.packVersion == "1.0.\(index)")
            let destination = root.appendingPathComponent(UUID().uuidString)
            _ = try AssistAdvancedVoiceFiles.importPack(from: incoming, to: destination,
                manifest: resolved.manifest, digest: resolved.digest, envelope: resolved.envelope,
                availableCapacity: { _ in 1_000_000_000 })
            let installed = try AssistAdvancedVoiceFiles.installedManifest(at: destination, bundledData: bundledData, publicKeys: publicKeys)
            precondition(installed.digest == resolved.digest)
            let previous = try AssistVoicePackSelection.load(base: root, legacyName: nil)
            try AssistVoicePackSelection(schemaVersion: 1, active: destination.lastPathComponent, previous: previous?.active).save(base: root)
        }
        print("PASS two signed weight versions imported and restored without a new host")
        let selection = try AssistVoicePackSelection.load(base: root, legacyName: nil)!
        let previous = selection.previous!
        try AssistVoicePackSelection(schemaVersion: 1, active: previous, previous: selection.active).save(base: root)
        let restoredSelection = try AssistVoicePackSelection.load(base: root, legacyName: nil)
        precondition(restoredSelection?.active == previous)
        let readyManifest = try AssistAdvancedVoiceFiles.resolveManifest(from: incoming, bundledData: bundledData, publicKeys: publicKeys)
        let noSpaceDestination = root.appendingPathComponent(UUID().uuidString)
        let selectionBeforeNoSpace = try Data(contentsOf: root.appendingPathComponent("selection.json"))
        try expectFailure("zero capacity refuses import before staging") {
            _ = try AssistAdvancedVoiceFiles.importPack(from: incoming, to: noSpaceDestination,
                manifest: readyManifest.manifest, digest: readyManifest.digest, envelope: readyManifest.envelope,
                availableCapacity: { _ in 0 })
        }
        precondition(!manager.fileExists(atPath: noSpaceDestination.path))
        let selectionAfterNoSpace = try Data(contentsOf: root.appendingPathComponent("selection.json"))
        precondition(selectionAfterNoSpace == selectionBeforeNoSpace)
        print("PASS insufficient capacity rejects before staging and preserves the selection")
        for (label, signed) in [
            ("wrong key", try envelope(payload: manifestData(body: bytes, version: "2"), key: Curve25519.Signing.PrivateKey())),
            ("unknown publisher", try envelope(payload: manifestData(body: bytes, version: "2"), keyID: "unknown")),
            ("wrong ABI", try envelope(payload: manifestData(body: bytes, version: "2", abi: "other-native-engine"))),
        ] {
            try signed.write(to: incoming.appendingPathComponent(AssistAdvancedVoiceFiles.manifestFilename))
            try expectFailure(label) { _ = try AssistAdvancedVoiceFiles.resolveManifest(from: incoming, bundledData: bundledData, publicKeys: publicKeys) }
            let afterRejectedImport = try AssistVoicePackSelection.load(base: root, legacyName: nil)
            precondition(afterRejectedImport?.active == previous)
        }
        print("PASS signature, trust and native ABI rejection preserve the active/previous selection")
        try expectFailure("corrupt pointer") {
            try AssistVoicePackSelection(schemaVersion: 1, active: "../outside", previous: nil).save(base: root)
        }
        // Exercise the actual atomic selection file, independently of signatures:
        // a Redux-only pack must become usable again after an Ultra-only pack.
        let variantBase = root.appendingPathComponent("variant-selection")
        try manager.createDirectory(at: variantBase, withIntermediateDirectories: true)
        let reduxPack = UUID().uuidString, ultraPack = UUID().uuidString
        let reduxGroups: Set<String> = ["pocket", "silero", "redux"]
        let ultraGroups: Set<String> = ["pocket", "silero", "ultra"]
        let initialVariant = try AssistVoicePackSelection.compatibleVariant(preferred: "redux", groups: reduxGroups)
        try AssistVoicePackSelection(schemaVersion: 1, active: reduxPack, previous: nil,
            variant: initialVariant).save(base: variantBase)
        let reduxSelection = try AssistVoicePackSelection.load(base: variantBase, legacyName: nil)!
        precondition(reduxSelection.active == reduxPack && reduxSelection.variant == "redux")
        let importedVariant = try AssistVoicePackSelection.compatibleVariant(preferred: reduxSelection.variant, groups: ultraGroups)
        try AssistVoicePackSelection(schemaVersion: 1, active: ultraPack, previous: reduxSelection.active,
            variant: importedVariant, previousVariant: reduxSelection.variant).save(base: variantBase)
        let ultraSelection = try AssistVoicePackSelection.load(base: variantBase, legacyName: nil)!
        precondition(ultraSelection.active == ultraPack && ultraSelection.variant == "ultra")
        precondition(ultraSelection.previous == reduxPack && ultraSelection.previousVariant == "redux")
        let rollbackVariant = try AssistVoicePackSelection.compatibleVariant(
            preferred: ultraSelection.previousVariant ?? ultraSelection.variant, groups: reduxGroups)
        try AssistVoicePackSelection(schemaVersion: 1, active: ultraSelection.previous!, previous: ultraSelection.active,
            variant: rollbackVariant, previousVariant: ultraSelection.variant).save(base: variantBase)
        let rolledBack = try AssistVoicePackSelection.load(base: variantBase, legacyName: nil)!
        precondition(rolledBack.active == reduxPack && rolledBack.variant == "redux")
        precondition(rolledBack.previous == ultraPack && rolledBack.previousVariant == "ultra")
        // A second restore must preserve the other pack's own variant too.
        let forwardVariant = try AssistVoicePackSelection.compatibleVariant(preferred: rolledBack.previousVariant, groups: ultraGroups)
        try AssistVoicePackSelection(schemaVersion: 1, active: rolledBack.previous!, previous: rolledBack.active,
            variant: forwardVariant, previousVariant: rolledBack.variant).save(base: variantBase)
        let restoredUltra = try AssistVoicePackSelection.load(base: variantBase, legacyName: nil)!
        precondition(restoredUltra.active == ultraPack && restoredUltra.variant == "ultra")
        precondition(restoredUltra.previous == reduxPack && restoredUltra.previousVariant == "redux")
        let preferredUltra = try AssistVoicePackSelection.compatibleVariant(preferred: "ultra", groups: ["pocket", "silero", "redux", "ultra"])
        precondition(preferredUltra == "ultra")
        print("PASS Redux to Ultra import and repeated rollback preserve each pack's compatible variant atomically")
        let selectionBeforeInvalidVariant = try Data(contentsOf: variantBase.appendingPathComponent("selection.json"))
        for invalidVariant in ["", "other", "../redux"] {
            try expectFailure("invalid active variant") {
                try AssistVoicePackSelection(schemaVersion: 1, active: ultraPack, previous: reduxPack,
                    variant: invalidVariant, previousVariant: "redux").save(base: variantBase)
            }
            try expectFailure("invalid previous variant") {
                try AssistVoicePackSelection(schemaVersion: 1, active: ultraPack, previous: reduxPack,
                    variant: "ultra", previousVariant: invalidVariant).save(base: variantBase)
            }
        }
        try expectFailure("pack without a supported Parakeet variant") {
            _ = try AssistVoicePackSelection.compatibleVariant(preferred: "redux", groups: ["pocket", "silero"])
        }
        let selectionAfterInvalidVariant = try Data(contentsOf: variantBase.appendingPathComponent("selection.json"))
        precondition(selectionAfterInvalidVariant == selectionBeforeInvalidVariant)
        print("PASS invalid active/previous variants and missing Parakeet preserve the saved selection")
        let legacyName = UUID().uuidString
        let separateBase = root.appendingPathComponent("legacy-selection")
        try manager.createDirectory(at: separateBase, withIntermediateDirectories: true)
        let migratedSelection = try AssistVoicePackSelection.load(base: separateBase, legacyName: legacyName)
        precondition(migratedSelection?.active == legacyName)
        print("PASS legacy pack selection migrates by pointer without recopying weights")
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
