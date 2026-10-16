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
        try Probe.Report(nativeBuild: "9", osVersion: "Version 27.2 (test)",
                         functionName: "extend_1024_8", modelName: name)
    }

    static let sourceFunctionNames = Probe.functionNames.union(["load_embeddings", "gather_embeddings_8", "gather_embeddings_64"])

    static func library() -> Probe.PreparedLibraryEvidence {
        .capture(functionNames: Array(sourceFunctionNames), sourceFunctionNames: sourceFunctionNames,
                 selectedDescriptorPresent: true)
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
        let identityObject = try object(pendingJSON)
        check(identityObject["schemaVersion"] as? Int == 3, "New reports identify prepared-library evidence with schema 3.")
        check(identityObject["preparedLibrary"] == nil, "A pre-preparation marker must not invent a prepared library.")
        let attempt = identityObject["attempt"] as? [String: Any]
        check(UUID(uuidString: attempt?["id"] as? String ?? "") != nil,
              "Persist an attempt identifier before the first risky call.")
        check(attempt?["processIdentifier"] as? Int == Int(ProcessInfo.processInfo.processIdentifier),
              "Record the actual process identifier for crash correlation.")
        check(attempt?["entryPoint"] as? String == "single_function_load_probe",
              "Identify the diagnostic entry point independently of optimized stack names.")
        let dateFormatter = ISO8601DateFormatter()
        dateFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        check(dateFormatter.date(from: attempt?["startedAtUTC"] as? String ?? "") != nil,
              "Record an absolute UTC start time in the saved marker.")
        check(pendingJSON.utf8.count <= Probe.maximumReportBytes, "The saved marker stays bounded.")
        check(try Probe.Store(directory: store.directory).readJSON() == pendingJSON, "A fresh store can read a marker after relaunch.")
        check(try manager.contentsOfDirectory(atPath: store.directory.path) == ["model-load-diagnostic.json"], "Keep one fixed marker file.")
        let cleanObject = try object(pendingJSON)
        for (key, value) in [("schemaVersion", 4 as Any), ("contextCapacity", 8192 as Any),
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
        var legacy = cleanObject
        legacy["schemaVersion"] = 1
        legacy.removeValue(forKey: "attempt")
        var legacyMethods = legacy["measurementMethods"] as! [String: String]
        legacyMethods.removeValue(forKey: "attempt")
        legacyMethods.removeValue(forKey: "nativeErrors")
        legacyMethods.removeValue(forKey: "preparedLibrary")
        legacy["measurementMethods"] = legacyMethods
        try JSONSerialization.data(withJSONObject: legacy).write(to: store.url)
        check(try object(store.readJSON())["schemaVersion"] as? Int == 1,
              "A build 8 marker must remain readable without inventing attempt identity or native errors.")
        var schema2 = cleanObject
        schema2["schemaVersion"] = 2
        var schema2Methods = schema2["measurementMethods"] as! [String: String]
        schema2Methods.removeValue(forKey: "preparedLibrary")
        schema2["measurementMethods"] = schema2Methods
        try JSONSerialization.data(withJSONObject: schema2).write(to: store.url)
        let schema2Object = try object(store.readJSON())
        check(schema2Object["schemaVersion"] as? Int == 2 && schema2Object["preparedLibrary"] == nil
              && schema2Object["measurementMethods"] as? [String: String] == schema2Methods,
              "Schema 2 keeps its original methods and does not invent prepared-library evidence.")
        for version in [1, 2] {
            changed = version == 1 ? legacy : schema2
            changed["measurementMethods"] = Probe.measurementMethods
            try JSONSerialization.data(withJSONObject: changed).write(to: store.url)
            rejected { _ = try store.readJSON() }
        }
        for patch: [String: Any] in [["id": "not-a-uuid"], ["processIdentifier": -1],
                                    ["startedAtUTC": "2026-02-30T00:00:00.000Z"], ["entryPoint": "normal_load"]] {
            changed = cleanObject
            changed["attempt"] = (cleanObject["attempt"] as! [String: Any]).merging(patch) { _, new in new }
            try JSONSerialization.data(withJSONObject: changed).write(to: store.url)
            rejected { _ = try store.readJSON() }
        }

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
            }, inspect: { prepared in
                check(prepared.key == "prepared" && counters.get("prepared") == 1
                      && counters.get("loadCalls") == 0, "Inspect the live prepared model before any function load.")
                let saved = try! decoded(store.readJSON())
                check(saved.stage == .preparingModel && saved.preparedLibrary == nil,
                      "Do not claim prepared-library evidence before inspection.")
                counters.add("inspectCalls")
                return library()
            }, load: { _ in
                let saved = try decoded(store.readJSON())
                check(saved.stage == .loadingFunction && saved.samples.last?.stage == .beforeFunctionLoad,
                      "Persist the function marker before loading starts.")
                check(saved.preparedLibrary?.functionCount == 9 && saved.preparedLibrary?.matchesSourceSummary == true
                      && saved.preparedLibrary?.selectedDescriptorPresent == true,
                      "Persist prepared-library evidence together with the before-function marker.")
                counters.add("loadCalls")
                return LocalToken(counters)
            })
        let successful = try decoded(successfulJSON)
        try successful.validate()
        check(successful.stage == .completed && successful.samples.map(\.stage) == [.beforePrepare, .beforeFunctionLoad, .afterFunctionLoad],
              "Completion preserves the exact three stage-aligned observations.")
        check(counters.get("prepareCalls") == 1 && counters.get("inspectCalls") == 1 && counters.get("loadCalls") == 1,
              "Prepare and inspect once, then load only one function.")
        check(counters.get("prepared") == 0 && counters.get("loaded") == 0, "Release model and function after final persistence.")
        check(try store.readJSON() == successfulJSON, "Saved completion matches the returned report.")
        check(try object(successfulJSON)["attempt"] as? NSDictionary != attempt as NSDictionary?,
              "Each manual attempt receives a fresh identifier.")

        let completeObject = try object(successfulJSON)
        let completeLibrary = completeObject["preparedLibrary"] as! [String: Any]
        check(completeLibrary["functionNamesPrefix"] as? [String] == sourceFunctionNames.sorted()
              && completeLibrary["functionNamesTruncated"] as? Bool == false,
              "A complete matching library retains all nine sorted names without truncation.")
        let hostileNames = ["/private/model/path", "", "private\ntext", String(repeating: "a", count: 161),
                            "étiquette", "safe_name.1", String(repeating: "a", count: 160)]
        let sanitized = Probe.PreparedLibraryEvidence.capture(functionNames: hostileNames,
            sourceFunctionNames: sourceFunctionNames, selectedDescriptorPresent: false)
        try sanitized.validate()
        check(sanitized.functionCount == 7 && sanitized.functionNamesPrefix.filter({ $0 == "redacted" }).count == 5
              && sanitized.functionNamesPrefix.contains("safe_name.1")
              && sanitized.functionNamesPrefix.contains(String(repeating: "a", count: 160))
              && !sanitized.matchesSourceSummary && !sanitized.selectedDescriptorPresent,
              "Redact unsafe whole identifiers, retain the safe length boundary and record missing descriptors.")
        let manyNames = (0..<40).map { String(format: "fn_%02d", $0) }.reversed()
        let truncated = Probe.PreparedLibraryEvidence.capture(functionNames: Array(manyNames),
            sourceFunctionNames: Set((0..<32).map { String(format: "fn_%02d", $0) }), selectedDescriptorPresent: true)
        try truncated.validate()
        check(truncated.functionCount == 40 && truncated.functionNamesTruncated
              && truncated.functionNamesPrefix == (0..<32).map({ String(format: "fn_%02d", $0) })
              && !truncated.matchesSourceSummary,
              "Compare the full library, including names outside the sorted 32-name export prefix.")
        rejected {
            try Probe.PreparedLibraryEvidence(functionCount: 1, functionNamesPrefix: ["/private/model/path"],
                functionNamesTruncated: false, matchesSourceSummary: false, selectedDescriptorPresent: false).validate()
        }
        for patch: [String: Any] in [["functionCount": -1], ["functionCount": 9_007_199_254_740_992 as Int64],
                                    ["functionCount": 8], ["functionNamesPrefix": ["/private/model/path"]],
                                    ["functionNamesPrefix": sourceFunctionNames.sorted().reversed().map({ $0 })],
                                    ["functionNamesTruncated": true], ["selectedDescriptorPresent": "yes"]] {
            changed = completeObject
            changed["preparedLibrary"] = completeLibrary.merging(patch) { _, new in new }
            try JSONSerialization.data(withJSONObject: changed).write(to: store.url)
            rejected { _ = try store.readJSON() }
        }
        changed = completeObject
        changed.removeValue(forKey: "preparedLibrary")
        try JSONSerialization.data(withJSONObject: changed).write(to: store.url)
        rejected { _ = try store.readJSON() }
        changed = cleanObject
        changed["preparedLibrary"] = completeLibrary
        try JSONSerialization.data(withJSONObject: changed).write(to: store.url)
        rejected { _ = try store.readJSON() }
        for version in [1, 2] {
            changed = version == 1 ? legacy : schema2
            changed["preparedLibrary"] = completeLibrary
            try JSONSerialization.data(withJSONObject: changed).write(to: store.url)
            rejected { _ = try store.readJSON() }
        }
        let mismatchStore = Probe.Store(directory: temporary.appendingPathComponent("prepared-mismatch"))
        let mismatchJSON = try await Probe.execute(report: report(), store: mismatchStore,
            reading: { Probe.Reading() }, elapsed: { 0 }, prepare: { 1 }, inspect: { _ in sanitized }, load: { _ -> Int? in
                let saved = try decoded(mismatchStore.readJSON())
                check(saved.preparedLibrary?.matchesSourceSummary == false
                      && saved.preparedLibrary?.selectedDescriptorPresent == false,
                      "Persist mismatched names and a missing descriptor before the existing load.")
                return 1
            })
        check(try decoded(mismatchJSON).stage == .completed,
              "Prepared-library observations must not skip, retry or change the existing single function load.")
        check(!mismatchJSON.contains("/private/model/path") && !mismatchJSON.contains("private\\ntext"),
              "Prepared-library evidence must never export unsafe function text.")

        let blocked = temporary.appendingPathComponent("blocked")
        try Data([0]).write(to: blocked)
        let stopped = Counters()
        do {
            _ = try await Probe.execute(report: report(), store: Probe.Store(directory: blocked),
                reading: { Probe.Reading() }, elapsed: { 0 }, prepare: { stopped.add("prepare"); return 1 },
                inspect: { _ in stopped.add("inspect"); return library() },
                load: { _ -> Int? in stopped.add("load"); return 1 })
            preconditionFailure("A persistence failure must stop preparation.")
        } catch { check(error as? Probe.Failure == .persistence, "Report a bounded persistence error.") }
        check(stopped.get("prepare") == 0 && stopped.get("inspect") == 0 && stopped.get("load") == 0,
              "No preparation or inspection may precede its persisted marker.")

        let secondStore = Probe.Store(directory: temporary.appendingPathComponent("second-marker"))
        do {
            _ = try await Probe.execute(report: report(), store: secondStore, reading: { Probe.Reading() }, elapsed: { 0 },
                prepare: {
                    stopped.add("prepare")
                    try FileManager.default.removeItem(at: secondStore.url)
                    try FileManager.default.createDirectory(at: secondStore.url, withIntermediateDirectories: false)
                    return 1
                }, inspect: { _ in stopped.add("inspect"); return library() },
                load: { _ -> Int? in stopped.add("load"); return 1 })
            preconditionFailure("A second marker failure must stop function loading.")
        } catch { check(error as? Probe.Failure == .persistence, "Second marker errors remain bounded.") }
        check(stopped.get("prepare") == 1 && stopped.get("inspect") == 1 && stopped.get("load") == 0,
              "Inspect once, but do not load a function when its evidence marker cannot persist.")
        let invalidInspectionStore = Probe.Store(directory: temporary.appendingPathComponent("invalid-inspection"))
        do {
            _ = try await Probe.execute(report: report(), store: invalidInspectionStore,
                reading: { Probe.Reading() }, elapsed: { 0 }, prepare: { 1 }, inspect: { _ in
                    Probe.PreparedLibraryEvidence(functionCount: -1, functionNamesPrefix: [],
                        functionNamesTruncated: false, matchesSourceSummary: false, selectedDescriptorPresent: false)
                }, load: { _ -> Int? in preconditionFailure("Invalid inspection must stop before loading.") })
            preconditionFailure("Invalid prepared-library evidence unexpectedly persisted.")
        } catch { check(error as? Probe.Failure == .corruptReport, "Validate inspection evidence before any function load.") }

        let failStore = Probe.Store(directory: temporary.appendingPathComponent("native-failures"))
        let prepareFailure = try await Probe.execute(report: report(), store: failStore, reading: { Probe.Reading() }, elapsed: { 0 },
            prepare: { () async throws -> Int in throw SyntheticFailure() },
            inspect: { _ in preconditionFailure("Never inspect a model that failed preparation.") },
            load: { _ -> Int? in preconditionFailure("Preparation failed.") })
        check(try decoded(prepareFailure).errorCode == .preparationFailed, "Keep only a constant preparation error code.")
        check(try decoded(prepareFailure).preparedLibrary == nil, "A preparation failure contains no prepared-library claim.")
        let functionFailure = try await Probe.execute(report: report(), store: failStore, reading: { Probe.Reading() }, elapsed: { 0 },
            prepare: { 1 }, inspect: { _ in library() }, load: { _ -> Int? in
                throw NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoSuchFileError, userInfo: [
                    NSLocalizedDescriptionKey: "/private/model/path secret prompt",
                    NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: 2,
                        userInfo: [NSFilePathErrorKey: "/private/model/path"]),
                ])
            })
        check(try decoded(functionFailure).errorCode == .functionLoadFailed, "Keep only a constant function error code.")
        check(try decoded(functionFailure).preparedLibrary?.matchesSourceSummary == true,
              "Retain the inspected library when the native function load throws.")
        let nativeErrors = try object(functionFailure)["nativeErrors"] as? [[String: Any]]
        check(nativeErrors?.count == 2 && nativeErrors?[0]["domain"] as? String == NSCocoaErrorDomain
              && nativeErrors?[0]["code"] as? Int == NSFileReadNoSuchFileError
              && nativeErrors?[1]["domain"] as? String == NSPOSIXErrorDomain
              && nativeErrors?[1]["code"] as? Int == 2,
              "Preserve the native and underlying error codes without serializing user info.")
        let absentFunction = try await Probe.execute(report: report(), store: failStore, reading: { Probe.Reading() }, elapsed: { 0 },
            prepare: { 1 }, inspect: { _ in library() }, load: { _ -> Int? in nil })
        check(try decoded(absentFunction).errorCode == .functionNotFound, "A missing function is a failed probe.")
        for value in [prepareFailure, functionFailure, absentFunction] {
            let failed = try decoded(value)
            try failed.validate()
            check(failed.stage == .failed && failed.samples.last?.stage == .failed && failed.samples.count <= 4,
                  "Failed probes preserve bounded stage-aligned observations.")
            check(!value.contains("secret prompt") && !value.contains("/private/model/path"), "Never serialize native raw errors.")
        }
        let functionFailureObject = try object(functionFailure)
        for version in [1, 2] {
            var oldFailure = functionFailureObject
            oldFailure["schemaVersion"] = version
            oldFailure["measurementMethods"] = version == 1 ? legacyMethods : schema2Methods
            oldFailure.removeValue(forKey: "preparedLibrary")
            if version == 1 {
                oldFailure.removeValue(forKey: "attempt")
                oldFailure.removeValue(forKey: "nativeErrors")
            }
            try JSONSerialization.data(withJSONObject: oldFailure).write(to: store.url)
            let restored = try decoded(store.readJSON())
            check(restored.schemaVersion == version && restored.errorCode == .functionLoadFailed
                  && restored.samples.map(\.stage) == [.beforePrepare, .beforeFunctionLoad, .failed]
                  && restored.preparedLibrary == nil,
                  "Restore old failed function-load reports without adding prepared-library observations.")
        }
        changed = functionFailureObject
        changed["errorCode"] = "E_MODEL_PREPARATION_FAILED"
        try JSONSerialization.data(withJSONObject: changed).write(to: store.url)
        rejected { _ = try store.readJSON() }
        let unsafe = Probe.NativeErrorEvidence.capture(NSError(domain: "/private/model/path", code: Int.max))
        check(unsafe.first?.domain == "redacted" && unsafe.first?.code == nil,
              "Unsafe domains are redacted and unrepresentable codes stay unavailable rather than becoming zero.")
        let longChain = NSError(domain: "NSCocoaErrorDomain", code: 1, userInfo: [NSUnderlyingErrorKey:
            NSError(domain: "NSCocoaErrorDomain", code: 2, userInfo: [NSUnderlyingErrorKey:
                NSError(domain: "NSCocoaErrorDomain", code: 3, userInfo: [NSUnderlyingErrorKey:
                    NSError(domain: "NSCocoaErrorDomain", code: 4)])])])
        check(Probe.NativeErrorEvidence.capture(longChain).map(\.code) == [1, 2, 3],
              "Bound the underlying error chain independently of native user info size.")
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--fixture-json" {
            let destination = URL(fileURLWithPath: CommandLine.arguments[2])
            check(!manager.fileExists(atPath: destination.path), "Do not overwrite an existing fixture export.")
            try Data(successfulJSON.utf8).write(to: destination)
        }
        print("Model-load probe checks passed: persistence ordering, relaunch, corruption, bounds, whitelist, privacy, errors and lifetimes.")
    }
}
