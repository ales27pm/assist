import Foundation

/// An explicit, single-entry repair. The caller owns the exclusive-operation/no-live-model guard.
/// Core AI is deliberately injected: this file never opens a model or resumes a pending attempt.
enum AssistSpecializationRepair {
    static let maximumReportBytes = 32 * 1024
    static let maximumDiagnosticBytes = 512 * 1024
    private static let maximumWrapperBytes = maximumReportBytes + maximumDiagnosticBytes + 1024
    static let measurementMethods = [
        "scope": "One manually selected model and Neural Engine preference; no other model or compute-option cache entries are deleted",
        "cache": "One public deleteEntry call; a returned call does not establish that an entry previously existed; a thrown call stops the repair",
        "source": "The injected source verifier completes before invalidation; only the two fixed source identities are supported; source files are not modified",
        "markers": "One bounded atomic private Application Support record is persisted before each risky call; a pending record is not proof of a crash and is never resumed automatically",
        "attempt": "Fresh UUID, UTC start and process ID identify this explicit manual repair",
        "elapsedMs": "ContinuousClock elapsed time includes observations and persistence, not isolated execution timing",
        "nativeErrors": "At most three sanitized NSError domains, signed codes and Swift type names; descriptions and userInfo are omitted",
        "completion": "Completed means the original diagnostic returned a JSON object; it does not assert numerical qualification, generation readiness or accelerator placement",
    ]
    static let abliteratedMeasurementMethods: [String: String] = {
        var methods = measurementMethods
        methods["source"] = "The injected source verifier completes before invalidation; the selected abliterated source is pinned independently; source files are not modified"
        return methods
    }()

    enum Target: String, Codable, Sendable {
        case bundledF16 = "bundled_f16_neural_engine"
        case selectedGemmaF16 = "selected_f16_neural_engine"
        case selectedAbliteratedGemmaF16 = "selected_abliterated_f16_neural_engine"

        static func selected(modelName: String) throws -> Target {
            guard let target = [Self.selectedGemmaF16, .selectedAbliteratedGemmaF16].first(where: { $0.modelName == modelName }) else {
                throw Failure.invalidRequest
            }
            return target
        }

        var measurementMethods: [String: String] {
            self == .selectedAbliteratedGemmaF16 ? AssistSpecializationRepair.abliteratedMeasurementMethods
                : AssistSpecializationRepair.measurementMethods
        }

        var modelName: String {
            switch self {
            case .bundledF16: return "rmsnorm-f16-boundary"
            case .selectedGemmaF16: return "gemma4-e2b-32k-group8-rmscomposite"
            case .selectedAbliteratedGemmaF16: return "gemma4-e2b-32k-group8-abliterated-rmscomposite"
            }
        }

        var sourceAssetSHA256: String {
            switch self {
            case .bundledF16: return "46932657bf6ea3e4a3e99abba91b377b1ddbfb731a8553a4d5728fc414f54c8c"
            case .selectedGemmaF16: return "bd71bc0793677c4c4789b78109426b96afa2af7fc4df332f0c88695a43967362"
            case .selectedAbliteratedGemmaF16: return "a46f84f3bf569ac06da3b86eb24400c31b367da5b831566da0786987f863c8f0"
            }
        }
    }

    enum Stage: String, Codable, Sendable {
        case verifyingSource = "verifying_source"
        case invalidatingEntry = "invalidating_entry"
        case entryInvalidated = "entry_invalidated"
        case qualifying
        case completed
        case failed
    }

    enum Failure: String, Error, LocalizedError, Sendable {
        case invalidRequest = "E_SPECIALIZATION_REPAIR_INVALID_REQUEST"
        case persistence = "E_SPECIALIZATION_REPAIR_PERSISTENCE"
        case corruptReport = "E_SPECIALIZATION_REPAIR_CORRUPT_REPORT"
        case sourceFailed = "E_SPECIALIZATION_REPAIR_SOURCE_FAILED"
        case invalidationFailed = "E_SPECIALIZATION_REPAIR_INVALIDATION_FAILED"
        case qualificationFailed = "E_SPECIALIZATION_REPAIR_QUALIFICATION_FAILED"
        case diagnosticInvalid = "E_SPECIALIZATION_REPAIR_DIAGNOSTIC_INVALID"
        case cancelled = "E_SPECIALIZATION_REPAIR_CANCELLED"

        var errorDescription: String? {
            switch self {
            case .invalidRequest: return "Demande de réparation invalide."
            case .persistence: return "Impossible de sauvegarder la réparation ; aucune étape supplémentaire n’a été lancée."
            case .corruptReport: return "Le rapport de réparation enregistré est invalide ou trop volumineux."
            case .sourceFailed: return "Les fichiers source n’ont pas été vérifiés ; aucune entrée de cache n’a été supprimée."
            case .invalidationFailed: return "La suppression ciblée a échoué ; aucun nouveau chargement n’a été lancé."
            case .qualificationFailed: return "Le diagnostic après suppression ciblée n’a pas terminé."
            case .diagnosticInvalid: return "Le diagnostic retourné est invalide ou trop volumineux."
            case .cancelled: return "La réparation a été annulée ; aucune reprise automatique n’est effectuée."
            }
        }

        fileprivate var isRecordedFailure: Bool {
            switch self {
            case .sourceFailed, .invalidationFailed, .qualificationFailed, .diagnosticInvalid, .cancelled: return true
            default: return false
            }
        }
    }

    struct Attempt: Codable, Sendable {
        let id: String
        let startedAtUTC: String
        let processIdentifier: Int32
        var entryPoint = "manual_single_entry_repair"

        private static func formatter() -> ISO8601DateFormatter {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            return formatter
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
                  entryPoint == "manual_single_entry_repair" else { throw Failure.corruptReport }
        }
    }

    struct NativeErrorEvidence: Codable, Sendable {
        let domain: String
        let code: Int?
        let swiftType: String

        private static func label(_ value: String) -> String {
            let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._".utf8)
            guard !value.isEmpty, value.utf8.count <= 160,
                  value.utf8.allSatisfy({ allowed.contains($0) }) else { return "redacted" }
            return value
        }

        static func capture(_ error: any Error) -> [NativeErrorEvidence] {
            var evidence: [NativeErrorEvidence] = []
            var next: (any Error)? = error
            var seen = Set<ObjectIdentifier>()
            while let current = next, evidence.count < 3 {
                let native = current as NSError
                guard seen.insert(ObjectIdentifier(native)).inserted else { break }
                let code = (-9_007_199_254_740_991...9_007_199_254_740_991).contains(native.code) ? native.code : nil
                evidence.append(NativeErrorEvidence(domain: label(native.domain), code: code,
                    swiftType: label(String(reflecting: type(of: current)))))
                next = native.userInfo[NSUnderlyingErrorKey] as? any Error
            }
            return evidence
        }

        func validate() throws {
            guard domain == Self.label(domain), swiftType == Self.label(swiftType),
                  code.map({ (-9_007_199_254_740_991...9_007_199_254_740_991).contains($0) }) ?? true
            else { throw Failure.corruptReport }
        }
    }

    struct Step: Codable, Sendable {
        let stage: Stage
        let elapsedMs: Double
    }

    struct Report: Codable, Sendable {
        var schemaVersion = 1
        var kind = "assistSpecializationRepair"
        var scope = "single_model_neural_engine_cache_entry"
        let target: Target
        let modelName: String
        let sourceAssetSHA256: String
        var computePreference = "neural_engine_preferred"
        let nativeBuild: String
        let osVersion: String
        var attempt: Attempt
        var stage = Stage.verifyingSource
        var steps: [Step] = []
        var errorCode: String?
        var nativeErrors: [NativeErrorEvidence]?
        var measurementMethods = AssistSpecializationRepair.measurementMethods

        init(target: Target, nativeBuild: String, osVersion: String) throws {
            guard Self.safeVersion(nativeBuild), Self.safeVersion(osVersion) else { throw Failure.invalidRequest }
            self.target = target
            modelName = target.modelName
            sourceAssetSHA256 = target.sourceAssetSHA256
            measurementMethods = target.measurementMethods
            self.nativeBuild = nativeBuild
            self.osVersion = osVersion
            attempt = .current()
        }

        private static func safeVersion(_ value: String) -> Bool {
            let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._ -():".utf8)
            return !value.isEmpty && value.utf8.count <= 160 && value.utf8.allSatisfy { allowed.contains($0) }
                && value.trimmingCharacters(in: .whitespaces) == value
        }

        mutating func observe(_ next: Stage, elapsedMs: Double, failure: Failure? = nil, nativeError: (any Error)? = nil) throws {
            guard steps.count < 6, elapsedMs.isFinite, elapsedMs >= (steps.last?.elapsedMs ?? 0),
                  (next == .failed) == (failure != nil), failure?.isRecordedFailure ?? true,
                  nativeError == nil || failure != nil else { throw Failure.corruptReport }
            stage = next
            errorCode = failure?.rawValue
            nativeErrors = nativeError.map(NativeErrorEvidence.capture)
            steps.append(Step(stage: next, elapsedMs: elapsedMs))
            try validate()
        }

        func validate() throws {
            guard schemaVersion == 1, kind == "assistSpecializationRepair",
                  scope == "single_model_neural_engine_cache_entry", modelName == target.modelName,
                  sourceAssetSHA256 == target.sourceAssetSHA256, computePreference == "neural_engine_preferred",
                  Self.safeVersion(nativeBuild), Self.safeVersion(osVersion), (1...6).contains(steps.count),
                  measurementMethods == target.measurementMethods else { throw Failure.corruptReport }
            try attempt.validate()
            let prefix: [Stage] = [.verifyingSource, .invalidatingEntry, .entryInvalidated, .qualifying, .completed]
            let observed = steps.map(\.stage)
            if stage == .failed {
                guard observed.last == .failed, observed.count >= 2,
                      Array(observed.dropLast()) == Array(prefix.prefix(observed.count - 1)),
                      observed.dropLast().last != .completed,
                      let errorCode, let failure = Failure(rawValue: errorCode), failure.isRecordedFailure else {
                    throw Failure.corruptReport
                }
                // Error classification must agree with the last attempted operation.
                switch failure {
                case .sourceFailed: guard observed == [.verifyingSource, .failed] else { throw Failure.corruptReport }
                case .invalidationFailed: guard observed == [.verifyingSource, .invalidatingEntry, .failed] else { throw Failure.corruptReport }
                case .qualificationFailed, .diagnosticInvalid:
                    guard observed == [.verifyingSource, .invalidatingEntry, .entryInvalidated, .qualifying, .failed]
                    else { throw Failure.corruptReport }
                case .cancelled: break
                default: throw Failure.corruptReport
                }
            } else {
                guard observed == Array(prefix.prefix(observed.count)), observed.last == stage,
                      errorCode == nil, nativeErrors == nil else { throw Failure.corruptReport }
            }
            if let nativeErrors {
                guard stage == .failed, (1...3).contains(nativeErrors.count) else { throw Failure.corruptReport }
                for evidence in nativeErrors { try evidence.validate() }
            }
            var previous = 0.0
            for step in steps {
                guard step.elapsedMs.isFinite, step.elapsedMs >= previous else { throw Failure.corruptReport }
                previous = step.elapsedMs
            }
        }
    }

    /// A fixed filename and lazily resolved default avoid an unchecked/fallback storage path.
    struct Store: Sendable {
        private let providedDirectory: URL?

        init(directory: URL) { providedDirectory = directory }
        private init() { providedDirectory = nil }
        static let `default` = Store()

        static func applicationSupport() throws -> Store {
            do {
                let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                       appropriateFor: nil, create: true)
                return Store(directory: base.appendingPathComponent("AssistLoadDiagnostic", isDirectory: true))
            } catch { throw Failure.persistence }
        }

        private func resolvedDirectory() throws -> URL {
            if let providedDirectory { return providedDirectory }
            guard let directory = try Self.applicationSupport().providedDirectory else { throw Failure.persistence }
            return directory
        }

        var url: URL {
            get throws { try resolvedDirectory().appendingPathComponent("specialization-repair.json", isDirectory: false) }
        }

        @discardableResult
        func save(_ report: Report) throws -> String {
            try report.validate()
            let bytes = try AssistSpecializationRepair.encode(report)
            guard bytes.count <= maximumReportBytes else { throw Failure.persistence }
            do {
                let directory = try resolvedDirectory()
                let destination = try url
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])
                let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
                guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw Failure.persistence }
                if FileManager.default.fileExists(atPath: destination.path) {
                    let existing = try FileManager.default.attributesOfItem(atPath: destination.path)
                    guard existing[.type] as? FileAttributeType == .typeRegular else { throw Failure.persistence }
                }
                try bytes.write(to: destination, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
                return String(decoding: bytes, as: UTF8.self)
            } catch { throw Failure.persistence }
        }

        func readJSON() throws -> String {
            let destination: URL
            do { destination = try url } catch { throw Failure.corruptReport }
            let attributes: [FileAttributeKey: Any]
            do { attributes = try FileManager.default.attributesOfItem(atPath: destination.path) }
            catch {
                let native = error as NSError
                if native.domain == NSCocoaErrorDomain,
                   native.code == NSFileNoSuchFileError || native.code == NSFileReadNoSuchFileError { return "null" }
                throw Failure.corruptReport
            }
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  let size = attributes[.size] as? NSNumber, size.int64Value > 0,
                  size.int64Value <= maximumReportBytes else { throw Failure.corruptReport }
            do {
                let handle = try FileHandle(forReadingFrom: destination)
                defer { try? handle.close() }
                guard let bytes = try handle.read(upToCount: maximumReportBytes + 1),
                      !bytes.isEmpty, bytes.count <= maximumReportBytes else { throw Failure.corruptReport }
                let report = try JSONDecoder().decode(Report.self, from: bytes)
                try report.validate()
                // Unknown on-disk fields are never reflected into a shared report.
                return String(decoding: try AssistSpecializationRepair.encode(report), as: UTF8.self)
            } catch { throw Failure.corruptReport }
        }
    }

    static func lastReportJSON() throws -> String { try Store.applicationSupport().readJSON() }

    private static func encode(_ report: Report) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(report)
    }

    private static func diagnosticObject(_ raw: String) throws -> [String: Any] {
        let bytes = Data(raw.utf8)
        guard !bytes.isEmpty, bytes.count <= maximumDiagnosticBytes,
              let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw Failure.diagnosticInvalid
        }
        return object
    }

    private static func resultJSON(report: Report, diagnostic: [String: Any]) throws -> String {
        let repair = try JSONSerialization.jsonObject(with: encode(report))
        let result: [String: Any] = ["schemaVersion": 1, "kind": "assistSpecializationRepairResult",
                                   "repair": repair, "diagnostic": diagnostic]
        let bytes = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count <= maximumWrapperBytes else { throw Failure.diagnosticInvalid }
        return String(decoding: bytes, as: UTF8.self)
    }

    /// Exactly one invalidation precedes exactly one original diagnostic; failures stop progression.
    /// `verifySource` returns only a URL, so no prepared model is retained by this orchestrator before deletion.
    static func run(
        target: Target, nativeBuild: String, osVersion: String, store: Store = .default,
        verifySource: @Sendable () throws -> URL,
        invalidate: @Sendable (URL) throws -> Void,
        qualify: @Sendable () async throws -> String
    ) async throws -> String {
        var report = try Report(target: target, nativeBuild: nativeBuild, osVersion: osVersion)
        let started = ContinuousClock.now
        func elapsed() -> Double {
            let duration = started.duration(to: ContinuousClock.now).components
            return max(0, Double(duration.seconds) * 1_000 + Double(duration.attoseconds) / 1e15)
        }
        func recordFailure(_ failure: Failure, _ error: any Error) throws {
            try report.observe(.failed, elapsedMs: elapsed(), failure: failure, nativeError: error)
            try store.save(report)
        }
        try report.observe(.verifyingSource, elapsedMs: elapsed())
        try store.save(report)
        let source: URL
        do {
            try Task.checkCancellation()
            source = try verifySource()
            guard source.isFileURL, (source.path as NSString).isAbsolutePath else { throw Failure.sourceFailed }
        } catch {
            let failure: Failure = error is CancellationError ? .cancelled : .sourceFailed
            try recordFailure(failure, error)
            throw failure
        }
        // Cancellation and marker persistence must both succeed before touching a cache entry.
        do { try Task.checkCancellation() }
        catch { try recordFailure(.cancelled, error); throw Failure.cancelled }
        try report.observe(.invalidatingEntry, elapsedMs: elapsed())
        try store.save(report)
        do { try Task.checkCancellation() }
        catch { try recordFailure(.cancelled, error); throw Failure.cancelled }
        do { try invalidate(source) }
        catch {
            let failure: Failure = error is CancellationError ? .cancelled : .invalidationFailed
            try recordFailure(failure, error)
            throw failure
        }
        try report.observe(.entryInvalidated, elapsedMs: elapsed())
        try store.save(report)
        do { try Task.checkCancellation() }
        catch { try recordFailure(.cancelled, error); throw Failure.cancelled }
        try report.observe(.qualifying, elapsedMs: elapsed())
        try store.save(report)
        do { try Task.checkCancellation() }
        catch { try recordFailure(.cancelled, error); throw Failure.cancelled }
        let raw: String
        do {
            raw = try await qualify()
            try Task.checkCancellation()
        }
        catch {
            let failure: Failure = error is CancellationError ? .cancelled : .qualificationFailed
            try recordFailure(failure, error)
            throw failure
        }
        let diagnostic: [String: Any]
        do { diagnostic = try diagnosticObject(raw) }
        catch { try recordFailure(.diagnosticInvalid, error); throw Failure.diagnosticInvalid }
        var completed = report
        try completed.observe(.completed, elapsedMs: elapsed())
        let wrapper: String
        do { wrapper = try resultJSON(report: completed, diagnostic: diagnostic) }
        catch { try recordFailure(.diagnosticInvalid, error); throw Failure.diagnosticInvalid }
        try store.save(completed)
        return wrapper
    }
}
