import Foundation

@main
struct AssistSharedInboxChecks {
    static func main() throws {
        let manager = FileManager.default
        let root = manager.temporaryDirectory.appendingPathComponent("assist-inbox-tests-" + UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? manager.removeItem(at: root) }
        let now = Date(timeIntervalSince1970: 1_792_310_400)
        var checks = 0
        func expect(_ value: @autoclosure () throws -> Bool, _ label: String) throws {
            guard try value() else { throw NSError(domain: "AssistInboxChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: label]) }
            checks += 1
        }
        func rejects(_ label: String, _ work: () throws -> Void) throws {
            do { try work() } catch { checks += 1; return }
            throw NSError(domain: "AssistInboxChecks", code: 2, userInfo: [NSLocalizedDescriptionKey: "Expected rejection: " + label])
        }
        func store(_ name: String) throws -> AssistSharedInbox {
            let directory = root.appendingPathComponent(name, isDirectory: true)
            try manager.createDirectory(at: directory, withIntermediateDirectories: false)
            return try AssistSharedInbox(containerURL: directory)
        }

        let inbox = try store("basic")
        let id = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!; let identifier = id.uuidString.lowercased()
        let content = Data("Bonjour Québec".utf8)
        let item = try inbox.save(id: id, kind: .text, data: content, source: .picker, now: now)
        try expect(item.id == identifier && item.consumedAt == nil, "published metadata")
        try expect(try inbox.list(now: now).count == 1, "list one")
        let duplicate = try inbox.save(id: id, kind: .text, data: content, source: .picker, now: now.addingTimeInterval(5))
        try expect(duplicate == item, "same intent is idempotent")
        try expect(try inbox.list(now: now).count == 1, "no duplicate item")
        try rejects("different duplicate") { _ = try inbox.save(id: id, kind: .text, data: Data("different".utf8), source: .picker, now: now) }
        let firstRead = try inbox.consume(identifier, now: now.addingTimeInterval(10))
        let secondRead = try inbox.consume(identifier, now: now.addingTimeInterval(20))
        try expect(firstRead.data == content && secondRead.data == content, "same selected bytes")
        try expect(firstRead.item.consumedAt == secondRead.item.consumedAt, "consume once")
        try expect(try inbox.list(now: now.addingTimeInterval(20)).filter { $0.consumedAt == nil }.isEmpty, "pending count")
        let encoded = try AssistSharedInbox.encoded(firstRead.item)
        try expect(!encoded.contains("Bonjour") && !encoded.contains(root.path) && !encoded.contains("filename"), "metadata has no content or path")
        try rejects("traversal") { _ = try inbox.consume("../basic", now: now) }
        try rejects("uppercase alias") { _ = try inbox.consume(id.uuidString, now: now) }
        try expect(try inbox.remove(identifier, now: now.addingTimeInterval(20)), "remove")
        try expect(try !inbox.remove(identifier, now: now.addingTimeInterval(20)), "remove is idempotent")
        try rejects("read deleted") { _ = try inbox.consume(identifier, now: now) }

        try expect(try AssistSharedInbox.safeWebURL("https://example.org/path?q=Québec") == "https://example.org/path?q=Québec", "web URL data only")
        for url in ["file:///private/data", "javascript:alert(1)", "https://user:password@example.org", "http://", "https://example.org/\nprivate"] {
            try rejects("unsafe URL") { _ = try AssistSharedInbox.safeWebURL(url) }
        }
        try rejects("empty") { _ = try inbox.save(id: UUID(), kind: .text, data: Data(), source: .share, now: now) }
        try rejects("invalid UTF8") { _ = try inbox.save(id: UUID(), kind: .text, data: Data([0xff]), source: .share, now: now) }
        try rejects("text limit") { _ = try inbox.save(id: UUID(), kind: .text, data: Data(repeating: 65, count: AssistSharedInbox.maximumTextBytes + 1), source: .share, now: now) }
        try rejects("PDF signature") { _ = try inbox.save(id: UUID(), kind: .pdf, data: Data("not a PDF".utf8), source: .picker, now: now) }
        try rejects("image bytes limit") { _ = try inbox.save(id: UUID(), kind: .image, data: Data(repeating: 0, count: AssistSharedInbox.maximumItemBytes + 1), source: .picker, now: now) }

        let quota = try store("quota")
        for _ in 0..<AssistSharedInbox.maximumItems { _ = try quota.save(id: UUID(), kind: .text, data: Data("small".utf8), source: .share, now: now) }
        try rejects("count quota") { _ = try quota.save(id: UUID(), kind: .text, data: Data("small".utf8), source: .share, now: now) }
        let byteQuota = try store("byte-quota")
        let blob = Data(repeating: 0, count: AssistSharedInbox.maximumItemBytes)
        for _ in 0..<3 { _ = try byteQuota.save(id: UUID(), kind: .image, data: blob, source: .picker, now: now) }
        try rejects("aggregate byte quota") { _ = try byteQuota.save(id: UUID(), kind: .text, data: Data("extra".utf8), source: .share, now: now) }

        let expired = try store("expiry")
        _ = try expired.save(id: UUID(), kind: .text, data: content, source: .share, now: now)
        try expect(try expired.list(now: now.addingTimeInterval(AssistSharedInbox.lifetime)).isEmpty, "pending expiry")
        let consumed = try expired.save(id: UUID(), kind: .text, data: content, source: .share, now: now)
        _ = try expired.consume(consumed.id, now: now)
        try expect(try expired.list(now: now.addingTimeInterval(AssistSharedInbox.consumedLifetime)).isEmpty, "consumed expiry")

        let source = root.appendingPathComponent("selected.txt")
        try content.write(to: source)
        try expect(try AssistSharedInbox.readSelectedFile(source) == content, "bounded selected regular file")
        let link = root.appendingPathComponent("link.txt")
        try manager.createSymbolicLink(at: link, withDestinationURL: source)
        try rejects("file symlink") { _ = try AssistSharedInbox.readSelectedFile(link) }
        try rejects("directory") { _ = try AssistSharedInbox.readSelectedFile(root) }
        try rejects("file size before copy") { _ = try AssistSharedInbox.readSelectedFile(source, maximumBytes: 2) }
        let protected = try store("tamper")
        let original = try protected.save(id: UUID(), kind: .text, data: content, source: .picker, now: now)
        let metadata = root.appendingPathComponent("tamper/AssistInbox-v1/" + original.id + ".json")
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: metadata)) as! [String: Any]
        object["extra"] = "unexpected"
        try JSONSerialization.data(withJSONObject: object).write(to: metadata, options: .atomic)
        try rejects("unknown metadata fields") { _ = try protected.list(now: now) }

        let recovery = try store("recovery")
        let orphan = root.appendingPathComponent("recovery/AssistInbox-v1/" + UUID().uuidString.lowercased() + ".payload")
        try content.write(to: orphan)
        let abandonedStage = root.appendingPathComponent("recovery/AssistInbox-v1/" + UUID().uuidString.lowercased() + ".stage")
        try content.write(to: abandonedStage)
        try expect(try recovery.list(now: now).isEmpty, "unpublished orphan is not an import")
        try expect(!manager.fileExists(atPath: orphan.path), "unpublished orphan cleanup")
        try expect(!manager.fileExists(atPath: abandonedStage.path), "unpublished staging cleanup")
        let valid = try recovery.save(id: UUID(), kind: .text, data: content, source: .picker, now: now)
        let recoveryRoot = root.appendingPathComponent("recovery/AssistInbox-v1")
        let rootMode = try manager.attributesOfItem(atPath: recoveryRoot.path)[.posixPermissions] as? NSNumber
        let fileMode = try manager.attributesOfItem(atPath: recoveryRoot.appendingPathComponent(valid.id + ".payload").path)[.posixPermissions] as? NSNumber
        try expect(rootMode?.intValue == 0o700 && fileMode?.intValue == 0o600, "private directory and payload modes")

        let linkedRoot = root.appendingPathComponent("linked-root", isDirectory: true)
        try manager.createDirectory(at: linkedRoot, withIntermediateDirectories: false)
        try manager.createSymbolicLink(at: linkedRoot.appendingPathComponent("AssistInbox-v1"), withDestinationURL: root)
        try rejects("inbox root symlink") { _ = try AssistSharedInbox(containerURL: linkedRoot) }

        let cancellation = try store("cancellation")
        let committedID = UUID()
        let committed = try cancellation.save(id: committedID, kind: .text, data: content, source: .picker, now: now)
        let cancellationRoot = root.appendingPathComponent("cancellation/AssistInbox-v1")
        let denied = AssistInboxAdmission(); denied.cancel()
        let deniedID = UUID()
        do {
            _ = try cancellation.save(id: deniedID, kind: .text, data: content, source: .share, now: now, admission: denied)
            throw NSError(domain: "AssistInboxChecks", code: 3, userInfo: [NSLocalizedDescriptionKey: "Closed admission published an item"])
        } catch is CancellationError { checks += 1 }
        try expect(!manager.fileExists(atPath: cancellationRoot.appendingPathComponent(deniedID.uuidString.lowercased() + ".payload").path), "denied admission copies no payload")
        try expect(try cancellation.list(now: now) == [committed], "denied admission publishes no metadata")
        try rejects("cancelled duplicate cannot overwrite committed bytes") {
            _ = try cancellation.save(id: committedID, kind: .text, data: Data("replacement".utf8), source: .picker, now: now, admission: denied)
        }
        try expect(try cancellation.consume(committed.id, now: now).data == content, "closed duplicate preserves committed bytes")

        let interruptedID = UUID()
        let interrupted = AssistInboxAdmission()
        let interruptedPayload = cancellationRoot.appendingPathComponent(interruptedID.uuidString.lowercased() + ".payload")
        let interruptedMetadata = cancellationRoot.appendingPathComponent(interruptedID.uuidString.lowercased() + ".json")
        var sawPayloadBeforeCancel = false
        do {
            _ = try cancellation.save(id: interruptedID, kind: .text, data: content, source: .share, now: now,
                                      admission: interrupted, beforeMetadataPublication: {
                sawPayloadBeforeCancel = manager.fileExists(atPath: interruptedPayload.path)
                interrupted.cancel()
            })
            throw NSError(domain: "AssistInboxChecks", code: 4, userInfo: [NSLocalizedDescriptionKey: "Cancelled payload was published"])
        } catch is CancellationError { checks += 1 }
        try expect(sawPayloadBeforeCancel, "cancellation injected after payload copy")
        try expect(!manager.fileExists(atPath: interruptedPayload.path) && !manager.fileExists(atPath: interruptedMetadata.path), "cancelled unpublished payload removed without metadata")
        try expect(try cancellation.list(now: now).map(\.id) == [committed.id], "prepublication cancellation leaves existing item intact")

        let protectionFailureID = UUID()
        let protectionFailurePayload = cancellationRoot.appendingPathComponent(protectionFailureID.uuidString.lowercased() + ".payload")
        let protectionFailureMetadata = cancellationRoot.appendingPathComponent(protectionFailureID.uuidString.lowercased() + ".json")
        var sawUnpublishedMetadataStage = false
        try rejects("metadata protection failure before publication") {
            _ = try cancellation.save(id: protectionFailureID, kind: .text, data: content, source: .share, now: now,
                                      beforeMetadataPublication: {
                let stages = try manager.contentsOfDirectory(at: cancellationRoot, includingPropertiesForKeys: nil)
                    .filter { $0.pathExtension == "stage" }
                sawUnpublishedMetadataStage = stages.count == 1 && !manager.fileExists(atPath: protectionFailureMetadata.path)
                // Remove only this isolated test's staged file. The following
                // real protect() must fail before any destination is published.
                guard let stage = stages.first else { throw AssistInboxError.invalidItem }
                try manager.removeItem(at: stage)
            })
        }
        try expect(sawUnpublishedMetadataStage, "metadata bytes staged but not published before protection")
        try expect(!manager.fileExists(atPath: protectionFailurePayload.path) && !manager.fileExists(atPath: protectionFailureMetadata.path), "protection failure leaves no dangling published metadata")
        try expect(try manager.contentsOfDirectory(at: cancellationRoot, includingPropertiesForKeys: nil).allSatisfy { $0.pathExtension != "stage" }, "failed publication cleans metadata staging")
        try expect(try cancellation.consume(committed.id, now: now).data == content, "protection failure preserves existing committed import")

        let afterCommit = AssistInboxAdmission()
        let retained = try cancellation.save(id: UUID(), kind: .text, data: content, source: .share, now: now, admission: afterCommit)
        afterCommit.cancel()
        try expect(try cancellation.list(now: now).contains(where: { $0.id == retained.id }), "late cancellation never undoes committed metadata")
        try expect(try cancellation.consume(retained.id, now: now).data == content, "committed import remains recoverable after cancellation")
        try expect(try cancellation.list(now: now).filter { $0.id == retained.id }.count == 1, "committed stable import remains unique")
        print("PASS: \(checks) shared inbox bounds, identity, consumption, quota, expiry, path and cancellation checks")
    }
}
