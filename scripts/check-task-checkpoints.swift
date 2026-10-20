import Foundation

@main
struct TaskCheckpointChecks {
    @MainActor
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("assist-checkpoint-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("checkpoint.json")
        let clock: () -> Date = { Date(timeIntervalSince1970: 1_792_411_200) }
        var checks = 0
        func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
            guard try condition() else { throw NSError(domain: "CheckpointTests", code: 1,
                                                       userInfo: [NSLocalizedDescriptionKey: message]) }
            checks += 1
        }
        func rejects(_ operation: () throws -> Void) throws {
            do { try operation() }
            catch { checks += 1; return }
            throw NSError(domain: "CheckpointTests", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Unsafe checkpoint transition accepted"])
        }
        func object(_ json: String) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
        }
        func rows(_ store: AssistTaskCheckpoint) throws -> [[String: Any]] {
            try object(store.snapshotJSON())["tasks"] as! [[String: Any]]
        }
        func request(_ action: String, _ id: String, _ revision: Int, extra: [String: Any] = [:]) throws -> String {
            var value: [String: Any] = ["schemaVersion": 1, "action": action, "taskId": id, "expectedRevision": revision]
            value.merge(extra) { _, new in new }
            return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
        }
        let a = "11111111-1111-4111-8111-111111111111"
        let b = "22222222-2222-4222-8222-222222222222"
        let store = AssistTaskCheckpoint(url: url, now: clock)
        try expect(try rows(store).isEmpty, "fresh metadata only")
        try expect(!FileManager.default.fileExists(atPath: url.path), "snapshot does not create a file without metadata")
        let start = try request("start", a, 0, extra: ["kind": "research"])
        _ = try store.apply(start)
        try expect(try rows(store)[0]["state"] as? String == "running", "real start recorded")
        try expect(FileManager.default.fileExists(atPath: url.path), "start persisted")
        let initialData = try Data(contentsOf: url)
        try expect(initialData.count < 24 * 1_024, "checkpoint byte bound")
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as! NSNumber
        try expect(mode.intValue & 0o777 == 0o600, "private file permissions")
        try rejects { _ = try store.apply(start) }
        try rejects { _ = try store.apply(request("start", b, 0, extra: ["kind": "document"])) }
        try rejects { _ = try store.apply(request("pause", a, 0)) }
        try rejects { _ = try store.apply(request("resume", a, 1)) }
        try expect(try Data(contentsOf: url) == initialData, "rejected changes never overwrite disk")

        _ = try store.apply(request("pause", a, 1))
        try expect(try rows(store)[0]["pauseReason"] as? String == "user", "explicit pause")
        _ = try store.apply(request("resume", a, 2))
        try expect(try rows(store)[0]["epoch"] as? Int == 2, "resume creates a new fenced epoch")
        try rejects { _ = try store.apply(request("complete", a, 1)) }
        try rejects { _ = try store.apply(request("complete", a, 3, extra: ["outcome": NSNull()])) }

        store.pauseActive()
        try expect(try rows(store)[0]["state"] as? String == "paused", "background pauses metadata")
        try expect(try rows(store)[0]["pauseReason"] as? String == "interrupted", "background interruption is explicit")
        try expect(try rows(store)[0]["epoch"] as? Int == 2, "pause does not fabricate a resume epoch")
        _ = try store.apply(request("start", b, 0, extra: ["kind": "document"]))
        try rejects { _ = try store.apply(request("resume", a, 4)) }
        _ = try store.apply(request("cancel", b, 1))
        _ = try store.apply(request("resume", a, 4))
        try expect(try rows(store)[0]["epoch"] as? Int == 3, "only explicit resume advances epoch")

        // Recreating the owner simulates a process restart with actual disk I/O.
        let restored = AssistTaskCheckpoint(url: url, now: clock)
        try expect(try rows(restored)[0]["state"] as? String == "paused", "relaunch never auto-resumes running work")
        try expect(try rows(restored)[0]["pauseReason"] as? String == "interrupted", "relaunch preserves interruption")
        try expect(try rows(restored)[0]["revision"] as? Int == 6, "relaunch fences old callbacks")
        try rejects { _ = try restored.apply(request("complete", a, 5)) }
        _ = try restored.apply(request("resume", a, 6))
        _ = try restored.apply(request("complete", a, 7, extra: ["outcome": "outcome_unknown"]))
        try expect(try rows(restored)[0]["state"] as? String == "outcome_unknown", "uncertain outcomes persist unchanged")
        try rejects { _ = try restored.apply(request("resume", a, 8)) }
        try rejects { _ = try restored.apply(request("cancel", a, 8)) }
        let beforePause = try Data(contentsOf: url)
        restored.pauseActive()
        try expect(try Data(contentsOf: url) == beforePause, "background does not change terminal uncertainty")
        try expect(!(try restored.snapshotJSON()).contains("prompt"), "no prompt field saved")
        try expect(!(try restored.snapshotJSON()).contains("http"), "no source URL saved")

        for extra in [["kind": "write"], ["kind": "calendar_create"], ["kind": "research", "prompt": "private"],
                      ["kind": "research", "query": "private"], ["kind": "research", "url": "https://example.invalid"],
                      ["kind": "research", "secret": "private"]] {
            try rejects { _ = try restored.apply(request("start", UUID().uuidString, 0, extra: extra)) }
        }
        try rejects { _ = try restored.apply(request("start", "not-an-opaque-UUID", 0, extra: ["kind": "research"])) }
        try rejects { _ = try restored.apply(start.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":1,\"schemaVersion\":1")) }
        try rejects { _ = try restored.apply(String(repeating: " ", count: 24 * 1_024 + 1)) }

        // Future/corrupt journals are preserved, not replaced with an empty file.
        for (index, invalid) in ["{\"schemaVersion\":2,\"revision\":0,\"tasks\":[]}",
                                 "not JSON", String(repeating: "x", count: 24 * 1_024 + 1)].enumerated() {
            let other = root.appendingPathComponent("invalid-\(index).json")
            let data = Data(invalid.utf8)
            try data.write(to: other)
            let protected = AssistTaskCheckpoint(url: other, now: clock)
            try rejects { _ = try protected.snapshotJSON() }
            try rejects { _ = try protected.apply(start) }
            protected.pauseActive()
            try expect(try Data(contentsOf: other) == data, "future/corrupt journal preserved")
        }
        let changedURL = root.appendingPathComponent("changed.json")
        let changed = AssistTaskCheckpoint(url: changedURL, now: clock)
        _ = try changed.apply(start)
        let future = Data("{\"schemaVersion\":2,\"revision\":0,\"tasks\":[]}".utf8)
        try future.write(to: changedURL)
        try rejects { _ = try changed.apply(request("pause", a, 1)) }
        try expect(try Data(contentsOf: changedURL) == future, "mid-process future journal cannot be overwritten")

        var persisted = try object(restored.snapshotJSON())
        var damagedRows = persisted["tasks"] as! [[String: Any]]
        damagedRows[0]["kind"] = "write"
        persisted["tasks"] = damagedRows
        let writeURL = root.appendingPathComponent("write-kind.json")
        let writeData = try JSONSerialization.data(withJSONObject: persisted)
        try writeData.write(to: writeURL)
        let writeStore = AssistTaskCheckpoint(url: writeURL, now: clock)
        try rejects { _ = try writeStore.apply(request("resume", a, 8)) }
        try expect(try Data(contentsOf: writeURL) == writeData, "write-kind metadata cannot resume or be discarded")

        let symlink = root.appendingPathComponent("symlink.json")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: url)
        let linked = AssistTaskCheckpoint(url: symlink, now: clock)
        try rejects { _ = try linked.snapshotJSON() }
        try rejects { _ = try linked.apply(start) }
        try expect(try Data(contentsOf: url) == beforePause, "checkpoint never follows a linked storage file")

        let blocker = root.appendingPathComponent("not-a-directory")
        try Data("preserve".utf8).write(to: blocker)
        let unwritable = AssistTaskCheckpoint(url: blocker.appendingPathComponent("checkpoint.json"), now: clock)
        try rejects { _ = try unwritable.apply(start) }
        try expect(try Data(contentsOf: blocker) == Data("preserve".utf8), "I/O failure preserves existing data")

        let fullURL = root.appendingPathComponent("full.json")
        let full = AssistTaskCheckpoint(url: fullURL, now: clock)
        for _ in 0..<20 {
            let id = UUID().uuidString
            _ = try full.apply(request("start", id, 0, extra: ["kind": "research"]))
            _ = try full.apply(request("complete", id, 1, extra: ["outcome": "outcome_unknown"]))
        }
        try expect(try rows(full).count == 20, "twenty bounded uncertain tasks retained")
        try rejects { _ = try full.apply(request("start", UUID().uuidString, 0, extra: ["kind": "research"])) }
        try expect(try rows(full).count == 20, "uncertain tasks are never evicted")

        let prune = AssistTaskCheckpoint(url: root.appendingPathComponent("prune.json"), now: clock)
        for _ in 0..<21 {
            let id = UUID().uuidString
            _ = try prune.apply(request("start", id, 0, extra: ["kind": "document"]))
            _ = try prune.apply(request("complete", id, 1))
        }
        try expect(try rows(prune).count == 20, "only completed/cancelled old metadata may be pruned")
        print("PASS: \(checks) persisted task checkpoint lifecycle/fencing/recovery checks; no executor or network")
    }
}
