import Foundation

/// Foundation-only checks; compile beside AssistModelLoadProbe.swift with Swift 6.
@main
struct ModelLoadProbeChecks {
    typealias Probe = AssistModelLoadProbe

    final class Counters: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String: Int] = [:]
        @discardableResult
        func add(_ key: String, _ delta: Int = 1) -> Int {
            lock.lock()
            defer { lock.unlock() }
            values[key, default: 0] += delta
            return values[key]!
        }
        func get(_ key: String) -> Int {
            lock.lock()
            defer { lock.unlock() }
            return values[key, default: 0]
        }
    }

    final class Token: @unchecked Sendable {
        let key: String
        let counters: Counters
        init(_ key: String, _ counters: Counters) {
            self.key = key
            self.counters = counters
            counters.add(key)
        }
        deinit { counters.add(key, -1) }
    }

    // The synchronous loaded object stays local; its SDK type need not be Sendable.
    final class LocalToken {
        let counters: Counters
        init(_ counters: Counters) { self.counters = counters; counters.add("loaded") }
        deinit { counters.add("loaded", -1) }
    }

    struct SyntheticFailure: Error { let detail = "/private/model/path secret prompt" }

    static func check(_ condition: Bool, _ message: String) {
        precondition(condition, message)
    }

    static func rejected(_ expected: Probe.Failure = .corruptReport, _ operation: () throws -> Void) {
        do { try operation(); preconditionFailure("Invalid data unexpectedly accepted.") }
        catch { check(error as? Probe.Failure == expected, "Failure must be bounded and correctly classified.") }
    }

    static func report(_ name: String = "gemma4-e2b-32k-group8-rms-fp32io") throws -> Probe.Report {
        try Probe.Report(nativeBuild: "8", osVersion: "Version 27.2 (test)",
                         functionName: "extend_1024_8", modelName: name)
    }

    static func decoded(_ value: String) throws -> Probe.Report {
        try JSONDecoder().decode(Probe.Report.self, from: Data(value.utf8))
    }

    static func object(_ value: String) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(value.utf8)) as! [String: Any]
    }

    static func reading(_ counters: Counters) -> Probe.Reading {
        let index = counters.add("readings")
        if index == 3 {
            check(counters.get("prepared") == 1 && counters.get("loaded") == 1,
                  "Prepared model and function must remain alive through the final snapshot.")
        }
        return Probe.Reading(physicalFootprintBytes: UInt64(index * 1_000), availableMemoryBytes: 3_000_000_000,
            metalCurrentAllocatedBytes: 2_000_000, metalMaxBufferLengthBytes: 268_435_456,
            metalRecommendedWorkingSetBytes: 4_000_000_000, thermalState: "nominal", lowPowerMode: false)
    }

    static func main() async throws {
        let manager = FileManager.default
        let temporary = manager.temporaryDirectory.appendingPathComponent("AssistLoadProbeChecks-" + UUID().uuidString)
        try manager.createDirectory(at: temporary, withIntermediateDirectories: false)
        defer { try? manager.removeItem(at: temporary) }
        let store = Probe.Store(directory: temporary.appendingPathComponent("saved"))
        check(try store.readJSON() == "null", "A fresh install has no saved diagnostic.")
        check(Probe.functionNames == Set(["extend_1024_8", "extend_32768_8", "extend_8192_8",
            "prompt_opt_1024_64", "prompt_opt_32768_64", "prompt_opt_8192_64"]), "Only the exact six shipping functions are accepted.")
        for name in ["main", "extend_8192_1", "extend_32768_64", "../extend_1024_8", "extend_1024_8\n"] {
            rejected(.invalidRequest) { _ = try Probe.Report(nativeBuild: "8", osVersion: "test", functionName: name, modelName: "Gemma") }
        }
        for name in ["/private/model", "C:\\private\\model", "model\nsecret", "étiquette", ".", "..", " model", "model ", String(repeating: "a", count: 161)] {
            check(Probe.sanitizedModelName(name) == "gemma4-e2b-local", "Do not export paths, controls or arbitrary metadata.")
        }
        check(Probe.sanitizedModelName(String(repeating: "a", count: 160)) == String(repeating: "a", count: 160), "A safe 160-byte model label is supported.")
        check(Probe.sanitizedModelName("Gemma 4_E2B-32K.v1") == "Gemma 4_E2B-32K.v1", "Safe basename-style names are preserved.")
        var pending = try report()
        try pending.observe(.preparingModel, sampleStage: .beforePrepare, reading: Probe.Reading(), elapsedMs: 0)
        let pendingJSON = try store.save(pending)
        check(pendingJSON.utf8.count <= Probe.maximumReportBytes, "The saved marker stays bounded.")
        check(try Probe.Store(directory: store.directory).readJSON() == pendingJSON, "A fresh store can read a marker after relaunch.")
        check(try manager.contentsOfDirectory(atPath: store.directory.path) == ["model-load-diagnostic.json"], "Keep one fixed marker file.")
        let cleanObject = try object(pendingJSON)
        for (key, value) in [("schemaVersion", 2 as Any), ("contextCapacity", 8192 as Any),
                             ("functionName", "load_embeddings" as Any), ("stage", "crashed" as Any),
                             ("modelName", "/private/model" as Any), ("aneExecution", "verified" as Any),
                             ("errorCode", "PRIVATE_ERROR_TEXT" as Any)] {
            var changed = cleanObject
            changed[key] = value
            try JSONSerialization.data(withJSONObject: changed).write(to: store.url)
            rejected { _ = try store.readJSON() }
        }
        for elapsed in [-1.0, Double.nan, Double.infinity] {
            rejected { _ = try Probe.Sample(stage: .beforePrepare, elapsedMs: elapsed, reading: Probe.Reading()) }
        }
        let unavailable = try Probe.Sample(stage: .beforePrepare, elapsedMs: 0,
            reading: Probe.Reading(physicalFootprintBytes: UInt64.max, thermalState: "/private/error"))
        check(unavailable.physicalFootprintBytes == nil && unavailable.thermalState == "unknown",
              "Invalid readings remain unavailable and categories stay bounded.")
        let malformedSamples: [[String: Any]] = [
            ["stage": "before_prepare", "elapsedMs": -1, "thermalState": "nominal"],
            ["stage": "before_prepare", "elapsedMs": 0, "thermalState": "nominal", "physicalFootprintBytes": -1],
            ["stage": "before_prepare", "elapsedMs": 0, "thermalState": "private thermal text"],
        ]
        for malformedSample in malformedSamples {
            var changed = cleanObject
            changed["samples"] = [malformedSample]
            try JSONSerialization.data(withJSONObject: changed).write(to: store.url)
            rejected { _ = try store.readJSON() }
        }
        var changed = cleanObject
        changed["samples"] = Array(repeating: (cleanObject["samples"] as! [Any])[0], count: 5)
        try JSONSerialization.data(withJSONObject: changed).write(to: store.url)
        rejected { _ = try store.readJSON() }
        changed = cleanObject
        changed["measurementMethods"] = ["cache": "/private/model/path"]
        try JSONSerialization.data(withJSONObject: changed).write(to: store.url)
        rejected { _ = try store.readJSON() }
        try Data(repeating: 32, count: Probe.maximumReportBytes + 1).write(to: store.url)
        rejected { _ = try store.readJSON() }
        try Data("{invalid".utf8).write(to: store.url)
        rejected { _ = try store.readJSON() }
        changed = cleanObject
        changed["path"] = "/private/model/path"
        changed["prompt"] = "secret prompt"
        try JSONSerialization.data(withJSONObject: changed).write(to: store.url)
        let redacted = try store.readJSON()
        check(!redacted.contains("/private/model/path") && !redacted.contains("secret prompt"), "Unknown disk fields must not be exported.")

        let target = temporary.appendingPathComponent("target")
        try Data("untouched".utf8).write(to: target)
        try manager.removeItem(at: store.url)
        try manager.createSymbolicLink(at: store.url, withDestinationURL: target)
        rejected { _ = try store.readJSON() }
        rejected(.persistence) { _ = try store.save(pending) }
        check(try Data(contentsOf: target) == Data("untouched".utf8), "Never follow a marker symlink.")
        try manager.removeItem(at: store.url)

        let counters = Counters()
        let successfulJSON = try await Probe.execute(report: report(), store: store,
            reading: { reading(counters) }, elapsed: { Double(counters.add("elapsed") * 100) },
            prepare: {
                let saved = try decoded(store.readJSON())
                check(saved.stage == .preparingModel && saved.samples.last?.stage == .beforePrepare,
                      "Persist the preparing marker before native preparation starts.")
                counters.add("prepareCalls")
                return Token("prepared", counters)
            }, load: { _ in
                let saved = try decoded(store.readJSON())
                check(saved.stage == .loadingFunction && saved.samples.last?.stage == .beforeFunctionLoad,
                      "Persist the function marker before loading starts.")
                counters.add("loadCalls")
                return LocalToken(counters)
            })
        let successful = try decoded(successfulJSON)
        try successful.validate()
        check(successful.stage == .completed && successful.samples.map(\.stage) == [.beforePrepare, .beforeFunctionLoad, .afterFunctionLoad],
              "Completion preserves the exact three stage-aligned observations.")
        check(counters.get("prepareCalls") == 1 && counters.get("loadCalls") == 1, "Load only one model and one function.")
        check(counters.get("prepared") == 0 && counters.get("loaded") == 0, "Release model and function after final persistence.")
        check(try store.readJSON() == successfulJSON, "Saved completion matches the returned report.")

        let blocked = temporary.appendingPathComponent("blocked")
        try Data([0]).write(to: blocked)
        let stopped = Counters()
        do {
            _ = try await Probe.execute(report: report(), store: Probe.Store(directory: blocked),
                reading: { Probe.Reading() }, elapsed: { 0 }, prepare: { stopped.add("prepare"); return 1 },
                load: { _ -> Int? in stopped.add("load"); return 1 })
            preconditionFailure("A persistence failure must stop preparation.")
        } catch { check(error as? Probe.Failure == .persistence, "Report a bounded persistence error.") }
        check(stopped.get("prepare") == 0 && stopped.get("load") == 0, "No risky call may precede its marker.")

        let secondStore = Probe.Store(directory: temporary.appendingPathComponent("second-marker"))
        do {
            _ = try await Probe.execute(report: report(), store: secondStore, reading: { Probe.Reading() }, elapsed: { 0 },
                prepare: {
                    stopped.add("prepare")
                    try manager.removeItem(at: secondStore.url)
                    try manager.createDirectory(at: secondStore.url, withIntermediateDirectories: false)
                    return 1
                }, load: { _ -> Int? in stopped.add("load"); return 1 })
            preconditionFailure("A second marker failure must stop function loading.")
        } catch { check(error as? Probe.Failure == .persistence, "Second marker errors remain bounded.") }
        check(stopped.get("prepare") == 1 && stopped.get("load") == 0, "Do not load a function when its marker cannot persist.")

        let failStore = Probe.Store(directory: temporary.appendingPathComponent("native-failures"))
        let prepareFailure = try await Probe.execute(report: report(), store: failStore, reading: { Probe.Reading() }, elapsed: { 0 },
            prepare: { () async throws -> Int in throw SyntheticFailure() }, load: { _ -> Int? in preconditionFailure("Preparation failed.") })
        check(try decoded(prepareFailure).errorCode == .preparationFailed, "Keep only a constant preparation error code.")
        let functionFailure = try await Probe.execute(report: report(), store: failStore, reading: { Probe.Reading() }, elapsed: { 0 },
            prepare: { 1 }, load: { _ -> Int? in throw SyntheticFailure() })
        check(try decoded(functionFailure).errorCode == .functionLoadFailed, "Keep only a constant function error code.")
        let absentFunction = try await Probe.execute(report: report(), store: failStore, reading: { Probe.Reading() }, elapsed: { 0 },
            prepare: { 1 }, load: { _ -> Int? in nil })
        check(try decoded(absentFunction).errorCode == .functionNotFound, "A missing function is a failed probe.")
        for value in [prepareFailure, functionFailure, absentFunction] {
            let failed = try decoded(value)
            try failed.validate()
            check(failed.stage == .failed && failed.samples.last?.stage == .failed && failed.samples.count <= 4,
                  "Failed probes preserve bounded stage-aligned observations.")
            check(!value.contains("secret prompt") && !value.contains("/private/model/path"), "Never serialize native raw errors.")
        }
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--fixture-json" {
            let destination = URL(fileURLWithPath: CommandLine.arguments[2])
            check(!manager.fileExists(atPath: destination.path), "Do not overwrite an existing fixture export.")
            try Data(successfulJSON.utf8).write(to: destination)
        }
        print("Model-load probe checks passed: persistence ordering, relaunch, corruption, bounds, whitelist, privacy, errors and lifetimes.")
    }
}
