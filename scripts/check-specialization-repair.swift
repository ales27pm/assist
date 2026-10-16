import Foundation

/// Compile alongside AssistSpecializationRepair.swift; no model SDK or device is used.
@main
struct SpecializationRepairChecks {
    typealias Repair = AssistSpecializationRepair

    final class Counts: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String: Int] = [:]
        @discardableResult
        func add(_ name: String, _ delta: Int = 1) -> Int {
            lock.lock()
            defer { lock.unlock() }
            values[name, default: 0] += delta
            return values[name]!
        }
        func get(_ name: String) -> Int {
            lock.lock()
            defer { lock.unlock() }
            return values[name, default: 0]
        }
    }

    final class LocalLifetime {
        let counts: Counts
        init(_ counts: Counts) { self.counts = counts; counts.add("live") }
        deinit { counts.add("live", -1) }
    }

    static let source = URL(fileURLWithPath: "/private/selected-model-never-in-report/RMSNormProbe.aimodel", isDirectory: true)
    static let original = #"{"schemaVersion":2,"scope":"primitive_only_gemma_unqualified","aneExecution":"unverified","summary":{"cases":48,"failed":12,"maxULP":12},"results":[{"passed":false,"mode":"neural_engine_preferred","maxULP":12}],"extra":{"unicode":"é","boolean":true,"null":null}}"#

    static func check(_ value: Bool, _ message: String) { precondition(value, message) }

    static func object(_ value: String) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any] else {
            preconditionFailure("Expected a JSON object.")
        }
        return object
    }

    static func report(_ store: Repair.Store) throws -> Repair.Report {
        try JSONDecoder().decode(Repair.Report.self, from: Data(store.readJSON().utf8))
    }

    static func rejected(_ failure: Repair.Failure = .corruptReport, _ action: () throws -> Void) {
        do { try action(); preconditionFailure("Expected a bounded failure.") }
        catch { check(error as? Repair.Failure == failure, "Unexpected failure classification.") }
    }

    static func failed(_ failure: Repair.Failure, _ action: @Sendable () async throws -> String) async {
        do { _ = try await action(); preconditionFailure("Expected the repair to stop.") }
        catch { check(error as? Repair.Failure == failure, "Unexpected async failure classification.") }
    }

    static func nativeFailure() -> NSError {
        NSError(domain: "Unsafe /private/credential", code: Int.max, userInfo: [
            NSLocalizedDescriptionKey: "secret prompt /private/selected-model-never-in-report",
            NSUnderlyingErrorKey: NSError(domain: "Safe.Native", code: -54),
        ])
    }

    static func success(_ store: Repair.Store, counts: Counts = Counts(), target: Repair.Target = .bundledF16,
                        diagnostic: String = original) async throws -> String {
        try await Repair.run(target: target, nativeBuild: "11", osVersion: "Version 27.2 (test)", store: store,
            verifySource: {
                counts.add("verify")
                check(try report(store).stage == .verifyingSource, "Persist before verifying source bytes.")
                // The verifier's local objects must be gone before invalidation starts.
                let local = LocalLifetime(counts)
                return withExtendedLifetime(local) { source }
            }, invalidate: { url in
                check(url == source, "Invalidate the exact verified source URL.")
                check(counts.get("live") == 0, "No verification object/model is retained across invalidation.")
                let saved = try report(store)
                check(saved.stage == .invalidatingEntry, "Persist before the one invalidation call.")
                check(saved.steps.map(\.stage) == [.verifyingSource, .invalidatingEntry], "No extra invalidation or prepare precedes deletion.")
                counts.add("delete")
            }, qualify: {
                check(try report(store).stage == .qualifying, "Persist invalidation return and qualification boundary first.")
                check(counts.get("delete") == 1 && counts.get("verify") == 1, "Exactly one verified deletion precedes qualification.")
                counts.add("qualify")
                return diagnostic
            })
    }

    static func main() async throws {
        let manager = FileManager.default
        let temporary = manager.temporaryDirectory.appendingPathComponent("AssistSpecializationRepairChecks-" + UUID().uuidString)
        try manager.createDirectory(at: temporary, withIntermediateDirectories: false)
        defer { try? manager.removeItem(at: temporary) }
        let store = Repair.Store(directory: temporary.appendingPathComponent("saved", isDirectory: true))
        check(try store.readJSON() == "null", "Absence is null and never starts an operation.")
        check(Repair.Target.bundledF16.sourceAssetSHA256 == "46932657bf6ea3e4a3e99abba91b377b1ddbfb731a8553a4d5728fc414f54c8c", "Pin the tiny F16 source.")
        check(Repair.Target.selectedGemmaF16.sourceAssetSHA256 == "bd71bc0793677c4c4789b78109426b96afa2af7fc4df332f0c88695a43967362", "Pin the selected Gemma F16 source.")
        check(try Repair.Target.selected(modelName: "gemma4-e2b-32k-group8-rmscomposite") == .selectedGemmaF16,
              "Resolve the historical selected source to its original v1 target.")
        rejected(.invalidRequest) { _ = try Repair.Target.selected(modelName: "unreviewed-model") }
        check(try Repair.Target.selected(modelName: "gemma4-e2b-32k-group8-abliterated-rmscomposite")
              == .selectedAbliteratedGemmaF16 && Repair.Target.selectedAbliteratedGemmaF16.sourceAssetSHA256
              == "a46f84f3bf569ac06da3b86eb24400c31b367da5b831566da0786987f863c8f0",
              "Resolve the separately pinned abliterated source without changing the historical target.")

        let counts = Counts()
        let wrapped = try await success(store, counts: counts)
        check(counts.get("verify") == 1 && counts.get("delete") == 1 && counts.get("qualify") == 1,
              "One explicit action runs one verification, one deletion and one diagnostic.")
        let result = try object(wrapped)
        check(result["schemaVersion"] as? Int == 1 && result["kind"] as? String == "assistSpecializationRepairResult", "Return the fixed wrapper schema.")
        check((result["diagnostic"] as? NSDictionary) == (try object(original) as NSDictionary),
              "Do not rewrite original scope, summary, modes, tolerance, fields or qualification failure.")
        let completed = try report(store)
        check(completed.stage == .completed && completed.steps.map(\.stage) == [.verifyingSource, .invalidatingEntry, .entryInvalidated, .qualifying, .completed],
              "Completed describes the returned original diagnostic, even when numerical cases fail.")
        check(completed.errorCode == nil && completed.nativeErrors == nil, "Do not invent errors for numerical qualification failures.")
        check(completed.attempt.entryPoint == "manual_single_entry_repair" && completed.attempt.processIdentifier == ProcessInfo.processInfo.processIdentifier,
              "Persist the real manual attempt/process identity.")
        try completed.attempt.validate()
        let saved = try store.readJSON()
        check(saved.utf8.count <= Repair.maximumReportBytes && !saved.contains(source.path) && !saved.contains("secret prompt"), "Bounded repair metadata contains no paths or user text.")
        let savedURL = try store.url
        let permissions = try manager.attributesOfItem(atPath: savedURL.path)[.posixPermissions] as? NSNumber
        check(permissions?.intValue == 0o600, "The saved repair marker is private.")
        check(try manager.contentsOfDirectory(atPath: savedURL.deletingLastPathComponent().path) == ["specialization-repair.json"], "Use one fixed marker file only.")
        let abliteratedStore = Repair.Store(directory: temporary.appendingPathComponent("abliterated"))
        let abliteratedCounts = Counts()
        let loadDiagnostic = #"{"kind":"assistModelLoadDiagnostic","modelName":"gemma4-e2b-32k-group8-abliterated-rmscomposite","functionName":"extend_1024_8","stage":"completed","aneExecution":"unverified"}"#
        let abliteratedResult = try await success(abliteratedStore, counts: abliteratedCounts,
            target: .selectedAbliteratedGemmaF16, diagnostic: loadDiagnostic)
        let abliteratedSaved = try report(abliteratedStore)
        check(abliteratedSaved.target == .selectedAbliteratedGemmaF16 && abliteratedSaved.stage == .completed &&
              abliteratedSaved.measurementMethods == Repair.abliteratedMeasurementMethods &&
              abliteratedCounts.get("delete") == 1 && abliteratedCounts.get("qualify") == 1,
              "The manual abliterated repair preserves one verified invalidation and one original diagnostic.")
        check((try object(abliteratedResult)["diagnostic"] as? NSDictionary) == (try object(loadDiagnostic) as NSDictionary),
              "Preserve the abliterated diagnostic without claiming device or ANE qualification.")
        let loadSentinel = savedURL.deletingLastPathComponent().appendingPathComponent("model-load-diagnostic.json")
        let assetSentinel = savedURL.deletingLastPathComponent().appendingPathComponent("model-asset-diagnostic.json")
        let sentinel = Data(#"{"preserved":true}"#.utf8)
        try sentinel.write(to: loadSentinel)
        try sentinel.write(to: assetSentinel)
        _ = try await success(store)
        check(try Data(contentsOf: loadSentinel) == sentinel, "Repair persistence must not overwrite the original load report.")
        check(try Data(contentsOf: assetSentinel) == sentinel, "Repair persistence must not overwrite the source identity report.")

        // A pending marker can be read after relaunch; reading it never deletes or qualifies.
        var pending = try Repair.Report(target: .selectedGemmaF16, nativeBuild: "11", osVersion: "Version 27.2 (test)")
        try pending.observe(.verifyingSource, elapsedMs: 0)
        try pending.observe(.invalidatingEntry, elapsedMs: 1)
        try store.save(pending)
        let restored = Repair.Store(directory: savedURL.deletingLastPathComponent())
        check(try report(restored).stage == .invalidatingEntry, "Restore the last persisted boundary without treating it as proof of a crash.")
        check(counts.get("delete") == 1 && counts.get("qualify") == 1, "A pending report never resumes the repair.")

        // An unwritable destination must fail before even the verifier is entered.
        let blockedDirectory = temporary.appendingPathComponent("not-a-directory")
        try Data("block".utf8).write(to: blockedDirectory)
        let blocked = Repair.Store(directory: blockedDirectory)
        let blockedCounts = Counts()
        await failed(.persistence) {
            try await Repair.run(target: .bundledF16, nativeBuild: "11", osVersion: "test", store: blocked,
                verifySource: { blockedCounts.add("verify"); return source },
                invalidate: { _ in blockedCounts.add("delete") }, qualify: { blockedCounts.add("qualify"); return original })
        }
        check(blockedCounts.get("verify") == 0 && blockedCounts.get("delete") == 0 && blockedCounts.get("qualify") == 0,
              "A failed first marker forbids all subsequent effects.")

        // A pre-delete marker failure must stop after source verification, before mutation.
        let preDelete = Repair.Store(directory: temporary.appendingPathComponent("pre-delete"))
        let preDeleteCounts = Counts()
        await failed(.persistence) {
            try await Repair.run(target: .bundledF16, nativeBuild: "11", osVersion: "test", store: preDelete,
                verifySource: {
                    let marker = try preDelete.url
                    let localManager = FileManager.default
                    try localManager.removeItem(at: marker)
                    try localManager.createDirectory(at: marker, withIntermediateDirectories: false)
                    return source
                }, invalidate: { _ in preDeleteCounts.add("delete") }, qualify: { preDeleteCounts.add("qualify"); return original })
        }
        check(preDeleteCounts.get("delete") == 0 && preDeleteCounts.get("qualify") == 0, "Fail closed when the marker immediately before deletion cannot be persisted.")

        let errors = Repair.Store(directory: temporary.appendingPathComponent("errors"))
        let errorCounts = Counts()
        await failed(.sourceFailed) {
            try await Repair.run(target: .bundledF16, nativeBuild: "11", osVersion: "test", store: errors,
                verifySource: { throw nativeFailure() }, invalidate: { _ in errorCounts.add("delete") },
                qualify: { errorCounts.add("qualify"); return original })
        }
        check(errorCounts.get("delete") == 0 && errorCounts.get("qualify") == 0, "Unverified source bytes forbid deletion.")
        let nativeReport = try report(errors)
        check(nativeReport.stage == .failed && nativeReport.errorCode == Repair.Failure.sourceFailed.rawValue,
              "Persist a bounded source-verification failure.")
        check(nativeReport.nativeErrors?.count == 2 && nativeReport.nativeErrors?.first?.domain == "redacted"
              && nativeReport.nativeErrors?.first?.code == nil, "Redact unsafe domains and omit inexact JSON integer codes.")
        let privateErrorJSON = try errors.readJSON()
        check(!privateErrorJSON.contains("secret prompt") && !privateErrorJSON.contains("credential"), "Never retain NSError descriptions or userInfo.")

        let rejectedSelection = Repair.Store(directory: temporary.appendingPathComponent("rejected-selection"))
        try rejectedSelection.save(completed)
        let metadataSelection: Result<URL, any Error> = .failure(nativeFailure())
        let selectionCounts = Counts()
        await failed(.sourceFailed) {
            try await Repair.run(target: .selectedGemmaF16, nativeBuild: "11", osVersion: "test", store: rejectedSelection,
                verifySource: { try metadataSelection.get() },
                invalidate: { _ in selectionCounts.add("delete") },
                qualify: { selectionCounts.add("qualify"); return original })
        }
        let rejectedReport = try report(rejectedSelection)
        check(rejectedReport.attempt.id != completed.attempt.id && rejectedReport.target == .selectedGemmaF16 &&
              rejectedReport.stage == .failed && rejectedReport.steps.map(\.stage) == [.verifyingSource, .failed],
              "A rejected metadata selection replaces an earlier success with a fresh source-failed attempt.")
        check(selectionCounts.get("delete") == 0 && selectionCounts.get("qualify") == 0,
              "Rejected metadata selection never deletes a cache entry or loads a model.")

        await failed(.invalidationFailed) {
            try await Repair.run(target: .bundledF16, nativeBuild: "11", osVersion: "test", store: errors,
                verifySource: { source }, invalidate: { _ in errorCounts.add("delete"); throw nativeFailure() },
                qualify: { errorCounts.add("qualify"); return original })
        }
        check(errorCounts.get("delete") == 1 && errorCounts.get("qualify") == 0, "A busy/referenced/failed cache entry is neither retried nor followed by a load.")
        check(try report(errors).steps.map(\.stage) == [.verifyingSource, .invalidatingEntry, .failed], "Keep the last attempted cache boundary on failure.")

        await failed(.qualificationFailed) {
            try await Repair.run(target: .bundledF16, nativeBuild: "11", osVersion: "test", store: errors,
                verifySource: { source }, invalidate: { _ in }, qualify: { throw nativeFailure() })
        }
        check(try report(errors).errorCode == Repair.Failure.qualificationFailed.rawValue, "Separate diagnostic failure from cache invalidation failure.")
        for invalid in ["[]", "null", "1", "not JSON", String(repeating: " ", count: Repair.maximumDiagnosticBytes + 1)] {
            await failed(.diagnosticInvalid) {
                try await Repair.run(target: .bundledF16, nativeBuild: "11", osVersion: "test", store: errors,
                    verifySource: { source }, invalidate: { _ in }, qualify: { invalid })
            }
        }

        // Failure to save invalidation's return must stop before qualification.
        let afterDelete = Repair.Store(directory: temporary.appendingPathComponent("after-delete"))
        let afterDeleteCounts = Counts()
        await failed(.persistence) {
            try await Repair.run(target: .bundledF16, nativeBuild: "11", osVersion: "test", store: afterDelete,
                verifySource: { source }, invalidate: { _ in
                    afterDeleteCounts.add("delete")
                    let marker = try afterDelete.url
                    let localManager = FileManager.default
                    try localManager.removeItem(at: marker)
                    try localManager.createDirectory(at: marker, withIntermediateDirectories: false)
                }, qualify: { afterDeleteCounts.add("qualify"); return original })
        }
        check(afterDeleteCounts.get("delete") == 1 && afterDeleteCounts.get("qualify") == 0,
              "After a successful cache call, a persistence failure still forbids additional work.")

        // Cancellation is checked before verification, deletion and qualification.
        for boundary in ["before-verification", "before-deletion", "before-qualification"] {
            let cancellationStore = Repair.Store(directory: temporary.appendingPathComponent(boundary))
            let cancellationCounts = Counts()
            let task = Task {
                if boundary == "before-verification" { withUnsafeCurrentTask { $0?.cancel() } }
                return try await Repair.run(target: .bundledF16, nativeBuild: "11", osVersion: "test", store: cancellationStore,
                    verifySource: {
                        cancellationCounts.add("verify")
                        if boundary == "before-deletion" { withUnsafeCurrentTask { $0?.cancel() } }
                        return source
                    }, invalidate: { _ in
                        cancellationCounts.add("delete")
                        if boundary == "before-qualification" { withUnsafeCurrentTask { $0?.cancel() } }
                    }, qualify: { cancellationCounts.add("qualify"); return original })
            }
            await failed(.cancelled) { try await task.value }
            check(cancellationCounts.get("qualify") == 0, "Cancellation never runs the diagnostic afterward.")
            check(cancellationCounts.get("delete") == (boundary == "before-qualification" ? 1 : 0),
                  "Cancellation prevents the next cache effect.")
            check(try report(cancellationStore).errorCode == Repair.Failure.cancelled.rawValue, "Persist cancellation without an automatic retry.")
        }

        // On-disk data is untrusted: enforce constants, bounds, order and safe evidence on restore.
        try store.save(completed)
        let clean = try object(store.readJSON())
        for (key, value) in [("schemaVersion", 2 as Any), ("scope", "all_cache" as Any),
                             ("target", "arbitrary_target" as Any), ("modelName", "/private/model" as Any),
                             ("sourceAssetSHA256", String(repeating: "0", count: 64) as Any),
                             ("computePreference", "cpu_only" as Any), ("stage", "invalidating_entry" as Any),
                             ("nativeBuild", "/private/build" as Any), ("errorCode", "unbounded message" as Any)] {
            var changed = clean
            changed[key] = value
            try JSONSerialization.data(withJSONObject: changed).write(to: savedURL)
            rejected { _ = try store.readJSON() }
        }
        var changed = clean
        changed["steps"] = Array(repeating: ["stage": "verifying_source", "elapsedMs": 0], count: 7)
        try JSONSerialization.data(withJSONObject: changed).write(to: savedURL)
        rejected { _ = try store.readJSON() }
        try Data(repeating: 32, count: Repair.maximumReportBytes + 1).write(to: savedURL)
        rejected { _ = try store.readJSON() }
        try store.save(completed)
        changed = clean
        changed["unknownPath"] = "/private/do-not-export"
        try JSONSerialization.data(withJSONObject: changed).write(to: savedURL)
        check(!(try store.readJSON()).contains("unknownPath"), "Do not replay unknown stored fields.")

        var chain: NSError = NSError(domain: "Safe.End", code: 1)
        for _ in 0..<6 { chain = NSError(domain: "Safe.Parent", code: -2, userInfo: [NSUnderlyingErrorKey: chain]) }
        check(Repair.NativeErrorEvidence.capture(chain).count == 3, "Bound native error traversal.")
        for elapsed in [-1.0, Double.nan, Double.infinity] {
            var invalid = try Repair.Report(target: .bundledF16, nativeBuild: "11", osVersion: "test")
            rejected { try invalid.observe(.verifyingSource, elapsedMs: elapsed) }
        }
        rejected(.invalidRequest) { _ = try Repair.Report(target: .bundledF16, nativeBuild: "11\nsecret", osVersion: "test") }
        print("PASS: explicit specialization repair ordering, single effects, cancellation, bounded persistence, privacy and original diagnostic contract")
    }
}
