import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

final class DiagnosticClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant = ContinuousClock.now
    private var date = Date(timeIntervalSince1970: 1_792_540_800)
    func now() -> ContinuousClock.Instant { lock.lock(); defer { lock.unlock() }; return instant }
    func wall() -> Date { lock.lock(); defer { lock.unlock() }; return date }
    func advance(_ seconds: Int, wall: Bool = true) {
        lock.lock(); defer { lock.unlock() }
        instant = instant.advanced(by: .seconds(seconds))
        if wall { date = date.addingTimeInterval(Double(seconds)) }
    }
    func advanceWall(_ seconds: Int) { lock.lock(); defer { lock.unlock() }; date = date.addingTimeInterval(Double(seconds)) }
}

private actor ControlGate {
    private var release: CheckedContinuation<Void, Never>?
    private var entered = false
    private var values: [Int] = []
    private var failed = false
    func suspend() async { entered = true; await withCheckedContinuation { release = $0 } }
    func unblock() { release?.resume(); release = nil }
    func append(_ value: Int) { values.append(value) }
    func fail() { failed = true }
    func state() -> (Bool, [Int], Bool) { (entered, values, failed) }
}

@main @MainActor struct DebugDiagnosticChecks {
    typealias Recorder = AssistDebugDiagnostics
    typealias Object = [String: Any]
    static var checks = 0
    static var stage = "initial"
    static var actors: [Recorder] = []
    static func check(_ condition: @autoclosure () throws -> Bool, _ detail: String) throws {
        guard try condition() else { throw NSError(domain: "Assist.DebugChecks", code: 1,
            userInfo: [NSLocalizedDescriptionKey: detail]) }
        checks += 1
    }
    static func object(_ json: String) throws -> Object {
        guard let value = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? Object else {
            throw NSError(domain: "Assist.DebugChecks.JSON", code: 1)
        }
        return value
    }
    static func number(_ row: Object, _ key: String) -> Int { (row[key] as? NSNumber)?.intValue ?? -1 }
    static func rows(_ row: Object, _ key: String) -> [Object] { row[key] as? [Object] ?? [] }
    static func make(_ directory: URL, _ clock: DiagnosticClock) -> Recorder {
        let value = Recorder(directory: directory, nativeBuild: "31", osVersion: "iOS 27.2",
            clock: { clock.now() }, wallClock: { clock.wall() })
        actors.append(value); return value
    }
    static func status(_ recorder: Recorder) async throws -> Object { try object(await recorder.snapshotJSON()) }
    static func bundle(_ recorder: Recorder) async throws -> Object { try object(await recorder.exportJSON()) }
    static func configure(_ recorder: Recorder, _ mode: String) async throws -> Object {
        try object(await recorder.configureJSON("{\"schemaVersion\":1,\"mode\":\"\(mode)\"}"))
    }
    static func save(_ value: Object, name: String, directory: URL?) throws {
        guard let directory else { return }
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .prettyPrinted])
            .write(to: directory.appendingPathComponent(name), options: .atomic)
    }
    static func files(_ directory: URL) throws -> [String: Data] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [:] }
        return try Dictionary(uniqueKeysWithValues: FileManager.default.contentsOfDirectory(at: directory,
            includingPropertiesForKeys: nil).map { ($0.lastPathComponent, try Data(contentsOf: $0)) })
    }
    static func shape(_ snapshot: Object) throws {
        try check(snapshot["kind"] as? String == "assistDebugStatus" && number(snapshot, "schemaVersion") == 1,
                  "status identity/version")
        try check(rows(snapshot, "records").count <= 30 && rows(snapshot, "findings").count <= 32,
                  "status windows are bounded")
        let coverage = rows(snapshot, "coverage")
        try check(Set(coverage.compactMap { $0["category"] as? String }) == Set(Recorder.Category.allCases.map(\.rawValue))
                  && coverage.count == 16, "coverage contains exactly the compiled categories")
        let privacy = snapshot["privacy"] as? Object ?? [:]
        try check(privacy["contentCaptured"] as? Bool == false && privacy["automaticUpload"] as? Bool == false,
                  "privacy contract is explicit")
        try check(rows(snapshot, "findings").contains { $0["code"] as? String == "noCausalEvidence"
                  && $0["evidence"] as? String == "unmeasured" }, "findings never manufacture a causal conclusion")
    }
    static func consistency(_ export: Object) throws {
        let current = export["current"] as? Object ?? [:], snapshot = export["status"] as? Object ?? [:]
        let records = rows(current, "records"), previous = rows(export, "previous")
        try check(number(snapshot, "recordCount") == records.count
                  && number(snapshot, "previousSessionCount") == previous.count, "bundle counts agree with its actual sessions")
        let tail = try JSONSerialization.data(withJSONObject: Array(records.suffix(30)), options: [.sortedKeys])
        let window = try JSONSerialization.data(withJSONObject: rows(snapshot, "records"), options: [.sortedKeys])
        try check(tail == window, "status records are exactly the current session suffix")
        try check(previous.count <= 2 && records.count <= 512, "bundle session and record bounds")
        let bytes = try JSONSerialization.data(withJSONObject: current)
        try check(bytes.count <= Recorder.maximumSessionBytes, "exported current respects the session byte ceiling")
    }
    static func main() async {
        do { try await run() }
        catch {
            FileHandle.standardError.write(Data("FAIL [\(stage)]: \(error.localizedDescription)\n".utf8)); exit(1)
        }
    }
    static func run() async throws {
        let manager = FileManager.default
        let root = manager.temporaryDirectory.appendingPathComponent("assist-debug-checks-" + UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        let args = CommandLine.arguments
        let fixtureDirectory: URL?
        if let flag = args.firstIndex(of: "--fixtures"), args.indices.contains(flag + 1) {
            fixtureDirectory = URL(fileURLWithPath: args[flag + 1], isDirectory: true)
            try manager.createDirectory(at: fixtureDirectory!, withIntermediateDirectories: true)
        } else { fixtureDirectory = nil }

        let clock = DiagnosticClock(), base = root.appendingPathComponent("modes")
        let recorder = make(base, clock)
        await recorder.start()
        let initial = try await status(recorder)
        try shape(initial)
        try check(initial["mode"] as? String == "standard" && number(initial, "recordCount") == 0, "fresh mode is standard")
        try check(rows(initial, "coverage").allSatisfy { $0["state"] as? String == "unavailable" },
                  "coverage does not claim hooks before a collector declares itself")
        await recorder.setCoverage(.engine, available: true)
        await recorder.setCoverage(.system, available: false)
        let declared = try await status(recorder)
        try check(rows(declared, "coverage").contains { $0["category"] as? String == "engine" && $0["state"] as? String == "partial" },
                  "a compiled collector declares partial coverage, not qualification")
        let beforeFilter = number(initial, "recordCount")
        await recorder.record(category: .context, stage: .tokenization, outcome: .completed, metrics: [.promptTokens: 20])
        let filtered = try await status(recorder)
        try check(number(filtered, "recordCount") == beforeFilter, "standard filters successful intermediate details")
        await recorder.record(category: .planning, stage: .roots, outcome: .rejected,
            requestId: "PRIVATE_REQUEST_KEY:tree-roots", reason: .fieldTooLong, field: .intent,
            metrics: [.fieldBytes: 74, .limitBytes: 72, .branchIndex: 0])
        await recorder.record(category: .planning, stage: .leaves, outcome: .completed,
            requestId: "PRIVATE_REQUEST_KEY:tree-leaves", reason: .turn106)
        let standard = try await status(recorder)
        let captured = rows(standard, "records")
        try check(captured.count == 2 && captured[0]["traceId"] as? String == "t1"
                  && captured[1]["traceId"] as? String == "t1", "roots/leaves normalize to the same opaque trace")
        try check(!String(describing: standard).contains("PRIVATE_REQUEST_KEY"), "request keys remain RAM-only")
        try check(rows(standard, "findings").contains { $0["code"] as? String == "preparationRejected" }, "actual preparation rejection has a finding")
        try save(standard, name: "status-standard.json", directory: fixtureDirectory)
        stage = "detailed configuration"
        let detailed = try await configure(recorder, "detailed")
        try check(detailed["mode"] as? String == "detailed" && detailed["detailExpiresAt"] is String, "detail has an explicit expiry")
        await recorder.record(category: .context, stage: .tokenization, outcome: .completed, metrics: [.promptTokens: 20])
        let withDetail = try await status(recorder)
        try check(rows(withDetail, "records").last?["stage"] as? String == "tokenization", "detailed captures intermediate metadata")
        try save(withDetail, name: "status-detailed.json", directory: fixtureDirectory)
        clock.advanceWall(86_400)
        let wallJump = try await status(recorder)
        try check(wallJump["mode"] as? String == "detailed", "wall-clock changes do not expire a monotonic lease")
        clock.advance(899, wall: false)
        let justBefore = try await status(recorder)
        try check(justBefore["mode"] as? String == "detailed", "detail remains active before 900 seconds")
        clock.advance(1, wall: false)
        await recorder.record(category: .context, stage: .tokenization, outcome: .completed)
        let expired = try await status(recorder)
        try check(expired["mode"] as? String == "standard" && expired["detailExpiresAt"] is NSNull,
                  "native observation expires detail without opening a panel")
        stage = "invalid configuration"
        let revision = number(expired, "revision"), count = number(expired, "recordCount")
        for (index, invalid) in ["", "{}", "[]", "{\"schemaVersion\":2,\"mode\":\"off\"}",
            "{\"schemaVersion\":true,\"mode\":\"off\"}", "{\"schemaVersion\":1,\"mode\":\"all\"}",
            "{\"schemaVersion\":1,\"mode\":\"off\",\"prompt\":\"PRIVATE_CONFIG\"}",
            "{\"schemaVersion\":1,\"mode\":\"off\",\"mode\":\"standard\"}",
            "{\"schemaVersion\":1,\"mode\":\"off\",\"m\\u006fde\":\"standard\"}", String(repeating: " ", count: 129)].enumerated() {
            stage = "invalid configuration \(index)"
            var accepted = false
            do { _ = try await recorder.configureJSON(invalid); accepted = true }
            catch { checks += 1 }
            try check(!accepted, "invalid configuration \(index) was accepted")
            stage = "status after invalid configuration \(index)"
            let after = try await status(recorder)
            try check(number(after, "revision") == revision && number(after, "recordCount") == count
                      && after["mode"] as? String == "standard", "invalid config is atomic and has no runtime side effect")
        }
        stage = "invalid metrics"
        let rejectedBefore = number(try await status(recorder), "rejectedRecords")
        for invalid in [-1.0, Double.infinity, Double.nan, 9_007_199_254_740_992] {
            await recorder.record(category: .engine, stage: .generation, outcome: .completed, metrics: [.durationMs: invalid])
        }
        let invalidMetrics = try await status(recorder)
        try check(number(invalidMetrics, "rejectedRecords") == rejectedBefore + 4, "nonfinite, negative and out-of-range metrics are rejected")
        stage = "off configuration"
        let off = try await configure(recorder, "off")
        try save(off, name: "status-off.json", directory: fixtureDirectory)
        let offFiles = try files(base), offCount = number(off, "recordCount")
        await recorder.record(category: .engine, stage: .generation, outcome: .failed, reason: .engine)
        await recorder.recordOmission(10)
        _ = try await recorder.exportJSON()
        let offAfter = try await status(recorder)
        try check(number(offAfter, "recordCount") == offCount && (try files(base)) == offFiles, "Off prevents capture and checkpoint writes")
        let restartedOff = make(base, clock)
        await restartedOff.start()
        let restartedOffStatus = try await status(restartedOff)
        try check(restartedOffStatus["mode"] as? String == "off" && (try files(base)) == offFiles, "Off survives relaunch without rotation")
        let detailPath = root.appendingPathComponent("detail-restart")
        let detailRecorder = make(detailPath, clock)
        _ = try await configure(detailRecorder, "detailed")
        let detailRestart = make(detailPath, clock)
        let detailRestartStatus = try await status(detailRestart)
        try check(detailRestartStatus["mode"] as? String == "standard", "detailed mode never survives relaunch")

        stage = "quotas"
        try await quotaChecks(root: root, clock: clock)
        stage = "archives"
        try await archiveChecks(root: root, clock: clock)
        stage = "purge and queue"
        try await purgeAndQueueChecks(root: root, clock: clock)
        stage = "fixture sessions"
        try await fixtureChecks(root: root, clock: clock, output: fixtureDirectory)
        stage = "native error classification"
        try await nativeErrorClassificationChecks(root: root, clock: clock)
        stage = "control FIFO and capacity"
        try await controlQueueChecks(root: root, clock: clock)
        for actor in actors { _ = try? await actor.configureJSON("{\"schemaVersion\":1,\"mode\":\"off\"}") }
        try manager.removeItem(at: root)
        print("PASS: \(checks) real advanced-recorder checks; isolated storage, no model/device/network")
    }

    static func quotaChecks(root: URL, clock: DiagnosticClock) async throws {
        let recorder = make(root.appendingPathComponent("quota"), clock)
        _ = try await configure(recorder, "detailed")
        let metrics = Dictionary(uniqueKeysWithValues: Recorder.Metric.allCases.map { ($0, 9_007_199_254_740_991.0) })
        for index in 0..<700 {
            await recorder.record(category: .engine, stage: .generation, outcome: .completed,
                requestId: "private-trace-\(index)", reason: .eos1, metrics: metrics)
        }
        let export = try await bundle(recorder)
        try consistency(export)
        let snapshot = export["status"] as! Object
        try check(number(snapshot, "omittedRecords") > 0 && number(snapshot, "recordCount") <= 512,
                  "ring and byte saturation is counted")
        try check(rows(snapshot, "findings").contains { $0["code"] as? String == "collectionTruncated" }, "truncation is visible")
        try check(!String(describing: export).contains("private-trace-"), "trace-key churn never exports original keys")
        clock.advance(2)
        await recorder.record(category: .engine, stage: .generation, outcome: .completed)
        let persisted = try Data(contentsOf: root.appendingPathComponent("quota/current.json"))
        try check(persisted.count <= Recorder.maximumSessionBytes, "persisted saturated session also respects the byte ceiling")
    }

    static func archiveChecks(root: URL, clock: DiagnosticClock) async throws {
        let manager = FileManager.default, path = root.appendingPathComponent("archive-seed")
        let seed = make(path, clock)
        await seed.record(category: .engine, stage: .modelLoad, outcome: .completed)
        clock.advance(2)
        await seed.record(category: .engine, stage: .generation, outcome: .completed, reason: .eos1)
        let valid = try Data(contentsOf: path.appendingPathComponent("current.json"))
        let permissions = try manager.attributesOfItem(atPath: path.appendingPathComponent("current.json").path)
        try check((permissions[.posixPermissions] as? NSNumber)?.intValue == 0o600, "session file permissions are restricted")
        var invalids: [Data] = [Data("{invalid}".utf8), Data(repeating: 32, count: Recorder.maximumSessionBytes + 1)]
        var extra = try JSONSerialization.jsonObject(with: valid) as! Object
        extra["prompt"] = "PRIVATE_ARCHIVE_TEXT"; invalids.append(try JSONSerialization.data(withJSONObject: extra))
        var unknownMetric = try JSONSerialization.jsonObject(with: valid) as! Object
        var records = rows(unknownMetric, "records"), record = records[0]
        record["metrics"] = ["PRIVATE_METRIC_NAME": 1]; records[0] = record; unknownMetric["records"] = records
        invalids.append(try JSONSerialization.data(withJSONObject: unknownMetric))
        for (index, data) in invalids.enumerated() {
            let dir = root.appendingPathComponent("invalid-\(index)")
            try manager.createDirectory(at: dir, withIntermediateDirectories: true)
            try data.write(to: dir.appendingPathComponent("current.json"))
            let actor = make(dir, clock), export = try await bundle(actor)
            try check(rows(export, "previous").isEmpty, "invalid archives are not evidence")
            try check(!String(describing: export).contains("PRIVATE_"), "invalid archive contents cannot enter export")
        }
        let fallbackPath = root.appendingPathComponent("corrupt-current-fallback")
        try manager.createDirectory(at: fallbackPath, withIntermediateDirectories: true)
        try valid.write(to: fallbackPath.appendingPathComponent("previous.json"))
        try Data("{invalid}".utf8).write(to: fallbackPath.appendingPathComponent("current.json"))
        let fallback = make(fallbackPath, clock), fallbackExport = try await bundle(fallback)
        let validObject = try JSONSerialization.jsonObject(with: valid) as! Object
        try check(rows(fallbackExport, "previous").first?["sessionId"] as? String == validObject["sessionId"] as? String,
                  "corrupt current cannot replace a valid previous session")
        let sentinel = root.appendingPathComponent("outside-sentinel.json")
        try valid.write(to: sentinel)
        let linkDirectory = root.appendingPathComponent("symlink-file")
        try manager.createDirectory(at: linkDirectory, withIntermediateDirectories: true)
        try manager.createSymbolicLink(at: linkDirectory.appendingPathComponent("current.json"), withDestinationURL: sentinel)
        let linked = make(linkDirectory, clock), linkedExport = try await bundle(linked)
        try check(rows(linkedExport, "previous").isEmpty && (try Data(contentsOf: sentinel)) == valid,
                  "archive symlinks are rejected without changing their target")
        let directoryTarget = root.appendingPathComponent("directory-target")
        try manager.createDirectory(at: directoryTarget, withIntermediateDirectories: true)
        let directoryLink = root.appendingPathComponent("directory-link")
        try manager.createSymbolicLink(at: directoryLink, withDestinationURL: directoryTarget)
        let blocked = make(directoryLink, clock), blockedStatus = try await status(blocked)
        try check(blockedStatus["persistence"] as? String == "unavailable" && (try files(directoryTarget)).isEmpty,
                  "symlinked storage directory is unavailable and is not written through")
        let fileInstead = root.appendingPathComponent("not-a-directory")
        try Data("owned sentinel".utf8).write(to: fileInstead)
        let failed = make(fileInstead, clock), failedStatus = try await status(failed)
        try check(failedStatus["persistence"] as? String == "unavailable", "disk failure is reported without throwing from start/record")
        await failed.record(category: .engine, stage: .generation, outcome: .failed, reason: .engine)
        let failedAfter = try await status(failed)
        try check(number(failedAfter, "recordCount") == 1, "failed persistence does not suppress in-memory evidence")
    }

    static func purgeAndQueueChecks(root: URL, clock: DiagnosticClock) async throws {
        let recorder = make(root.appendingPathComponent("purge"), clock)
        await recorder.record(category: .engine, stage: .generation, outcome: .completed)
        let queue = DebugSubmissionQueue(recorder: recorder)
        let oldSession = (try await status(recorder))["sessionId"] as? String
        queue.invalidate()
        let cleared = try object(await recorder.clearJSON())
        let input = DebugSubmissionQueue.Input(category: .tools, stage: .receipt, outcome: .completed,
            requestId: "PRE_PURGE_PRIVATE_KEY", reason: nil, field: nil, metrics: [:])
        await recorder.acceptSubmission(input, lost: 7, generation: 0, source: queue)
        let afterOld = try await status(recorder)
        try check(number(afterOld, "recordCount") == 0 && number(afterOld, "omittedRecords") == 0,
                  "queued old generation cannot repopulate a purged session or its lost counter")
        await recorder.acceptSubmission(input, lost: 0, generation: 1, source: queue)
        let afterNew = try await status(recorder)
        try check(number(afterNew, "recordCount") == 1 && afterNew["sessionId"] as? String != oldSession,
                  "current queue generation remains usable after purge")
        try check(number(cleared, "recordCount") == 0 && number(cleared, "previousSessionCount") == 0,
                  "purge immediately clears all visible sessions")
        _ = try await recorder.clearJSON()
        let export = try await bundle(recorder)
        try consistency(export)
        try check(rows(export["current"] as! Object, "records").isEmpty && rows(export, "previous").isEmpty,
                  "purged bundle remains empty")
        try await Task.sleep(for: .milliseconds(1_100))
        try check(try files(root.appendingPathComponent("purge")).isEmpty,
                  "cancelled pre-purge checkpoint cannot recreate old files later")
    }

    private static func wait(_ gate: ControlGate, count: Int? = nil) async throws -> [Int] {
        for _ in 0..<2_000 {
            let state = await gate.state()
            if state.0 && (count == nil || state.1.count == count) {
                try check(!state.2, "queued control operation unexpectedly threw")
                return state.1
            }
            try await Task.sleep(for: .milliseconds(1))
        }
        throw NSError(domain: "Assist.DebugChecks.ControlTimeout", code: 1)
    }
    static func controlQueueChecks(root: URL, clock: DiagnosticClock) async throws {
        let recorder = make(root.appendingPathComponent("controls"), clock)
        let queue = AssistDebugControlQueue(), gate = ControlGate()
        try check(queue.enqueue { await gate.suspend(); await gate.append(0) }, "first control admitted")
        _ = try await wait(gate)
        for (index, mode) in [(1, "detailed"), (2, "off")] {
            try check(queue.enqueue {
                do { _ = try await recorder.configureJSON("{\"schemaVersion\":1,\"mode\":\"\(mode)\"}") }
                catch { await gate.fail() }
                await gate.append(index)
            }, "configuration control admitted")
        }
        try check(queue.enqueue {
            do { _ = try await recorder.clearJSON() } catch { await gate.fail() }
            await gate.append(3)
        }, "purge control admitted")
        let before = await gate.state()
        try check(before.1.isEmpty, "later controls cannot overtake a suspended first operation")
        await gate.unblock()
        let order = try await wait(gate, count: 4)
        let final = try await status(recorder)
        try check(order == [0, 1, 2, 3] && final["mode"] as? String == "off" && number(final, "recordCount") == 0,
                  "configuration and purge settle in FIFO order")
        let bounded = AssistDebugControlQueue(), capacityGate = ControlGate()
        try check(bounded.enqueue { await capacityGate.suspend(); await capacityGate.append(0) }, "capacity blocker admitted")
        _ = try await wait(capacityGate)
        for index in 1..<32 {
            try check(bounded.enqueue { await capacityGate.append(index) }, "up to 32 controls are retained")
        }
        try check(!bounded.enqueue { await capacityGate.append(32) }, "33rd pending control is explicitly rejected")
        await capacityGate.unblock()
        let capacityOrder = try await wait(capacityGate, count: 32)
        try check(capacityOrder == Array(0..<32), "bounded controls retain FIFO order without dropping accepted operations")
    }

    static func nativeErrorClassificationChecks(root: URL, clock: DiagnosticClock) async throws {
        try check(Recorder.classifyNativeError(nil) == nil, "successful callbacks do not invent an error reason")
        let privateMarker = "PRIVATE_NATIVE_DESCRIPTION_NOT_EVIDENCE"
        let payload: [String: Any] = [NSLocalizedDescriptionKey: privateMarker,
            NSUnderlyingErrorKey: NSError(domain: "Assist.ApplePlaces", code: 5),
            "url": "https://private.invalid/" + privateMarker, "arguments": privateMarker]
        let apple: [(Int, Recorder.Reason)] = [(1, .unknown), (2, .unknown), (3, .cancelRequested),
            (4, .connectionUnavailable), (5, .permissionDenied), (6, .unknown), (7, .imageUnavailable)]
        for (code, expected) in apple {
            try check(Recorder.classifyNativeError(NSError(domain: "Assist.ApplePlaces", code: code,
                userInfo: payload)) == expected, "ApplePlaces uses its exact closed numeric identity \(code)")
        }
        for code in [-1, 0, 8, Int.max] {
            var conflicting = payload; conflicting["code"] = "E_PERMISSION"
            try check(Recorder.classifyNativeError(NSError(domain: "Assist.ApplePlaces", code: code,
                userInfo: conflicting)) == .unknown, "unknown ApplePlaces identities cannot inherit a permission classification")
        }
        try check(Recorder.classifyNativeError(NSError(domain: "Assist.WeatherAttribution", code: 1,
            userInfo: payload)) == .imageUnavailable, "official attribution failure has a fixed image reason")
        try check(Recorder.classifyNativeError(NSError(domain: "Assist.WeatherAttribution", code: 2,
            userInfo: payload)) == .unknown, "unknown attribution identity stays unknown")
        for code in [NSURLErrorTimedOut, NSURLErrorNotConnectedToInternet, NSURLErrorCannotConnectToHost] {
            try check(Recorder.classifyNativeError(NSError(domain: NSURLErrorDomain, code: code,
                userInfo: payload)) == .connectionUnavailable, "URL service failures are a coarse network observation")
        }
        try check(Recorder.classifyNativeError(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled,
            userInfo: payload)) == .cancelRequested, "URL cancellation is distinct from a network failure")
        let wire: [(String, Recorder.Reason)] = [
            ("E_PERMISSION", .permissionDenied), ("E_AUTHORIZATION", .permissionDenied),
            ("E_WEATHER_AUTHORIZATION", .permissionDenied), ("E_CALENDAR_PERMISSION", .permissionDenied),
            ("E_CONTACTS_PERMISSION", .permissionDenied), ("E_REMINDERS_PERMISSION", .permissionDenied),
            ("E_NOTIFICATION_PERMISSION", .permissionDenied), ("E_OUTCOME_UNKNOWN", .outcomeUnknown),
            ("E_APPLE_NETWORK", .connectionUnavailable), ("E_PRIVATE_SERVICE_NETWORK", .connectionUnavailable),
            ("E_WEATHER_ATTRIBUTION", .imageUnavailable), ("E_CANCELLED", .cancelRequested), ("E_CANCELED", .cancelRequested)]
        let recorder = make(root.appendingPathComponent("native-error-classification"), clock)
        await recorder.start()
        for (code, expected) in wire {
            var details = payload; details["code"] = code
            let classified = Recorder.classifyNativeError(NSError(domain: "Assist.DeviceCapabilities", code: 1,
                userInfo: details))
            try check(classified == expected, "only allowlisted wire code \(code) has a closed classification")
            await recorder.record(category: .bridge, stage: .execution, outcome: .failed, reason: classified)
        }
        for code: Any in ["E_PERMISSION " as Any, "permissionDenied", "E_UNKNOWN", 1, true, NSNull()] {
            var details = payload; details["code"] = code
            try check(Recorder.classifyNativeError(NSError(domain: "Unknown.Private." + privateMarker, code: 5,
                userInfo: details)) == .unknown, "unknown or wrongly typed code cannot infer an error reason")
        }
        try check(Recorder.classifyNativeError(NSError(domain: "Unknown.Private." + privateMarker, code: 5,
            userInfo: payload)) == .unknown, "description, URL, nested error and unknown domain are not classification evidence")
        let exported = try await recorder.exportJSON()
        try check(!exported.contains(privateMarker) && !exported.contains("private.invalid")
                  && !exported.contains("NSLocalizedDescription") && !exported.contains("E_PERMISSION"),
                  "only closed reason values enter diagnostics; no NSError text or arbitrary payload is retained")
        let classifiedRecords = rows(try object(exported)["current"] as? Object ?? [:], "records")
        try check(classifiedRecords.count == wire.count && classifiedRecords.allSatisfy {
            ($0["reason"] as? String).flatMap(Recorder.Reason.init(rawValue:)) != nil
        }, "classified exports contain typed reasons, never a raw error object")
    }

    static func fixtureChecks(root: URL, clock: DiagnosticClock, output: URL?) async throws {
        let path = root.appendingPathComponent("fixture-sessions")
        var ids: [String] = []
        var latest: Recorder?
        for index in 0..<3 {
            let recorder = make(path, clock)
            await recorder.start()
            await recorder.record(category: .engine, stage: .modelLoad, outcome: .completed)
            clock.advance(2)
            await recorder.record(category: .planning, stage: .roots, outcome: .completed,
                requestId: "FIXTURE_PRIVATE_\(index)", reason: .eos1, metrics: [.promptTokens: 1500, .generatedTokens: 120])
            let snapshot = try await status(recorder)
            ids.append(snapshot["sessionId"] as! String)
            if index < 2 { actors.removeAll { $0 === recorder } }
            else { latest = recorder }
        }
        let recorder = latest!, export = try await bundle(recorder)
        try consistency(export)
        let previous = rows(export, "previous")
        try check(previous.count == 2 && previous[0]["sessionId"] as? String == ids[1]
                  && previous[1]["sessionId"] as? String == ids[0], "rotation retains the two actual previous sessions in order")
        try save(export, name: "bundle.json", directory: output)
        try save(export["current"] as! Object, name: "session.json", directory: output)
        _ = try await configure(recorder, "off")
        _ = try await recorder.clearJSON()
        let empty = try await bundle(recorder)
        try consistency(empty)
        try save(empty, name: "bundle-empty.json", directory: output)
    }
}
