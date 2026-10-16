import Foundation
#if canImport(CoreAI) && canImport(CoreAILanguageModels)
import CoreAI
import CoreAILanguageModels
#endif
#if canImport(Darwin)
import Darwin
#endif
#if canImport(os)
import os
#endif
#if canImport(Metal)
import Metal
#endif
#if canImport(FileProvider)
import FileProvider
#endif

/// A separate, opt-in single-function load observation. The caller excludes any live engine/operation.
/// Pending markers describe the last persisted boundary; they do not establish why a run stopped.
enum AssistModelLoadProbe {
    static let functionNames: Set<String> = [
        "extend_1024_8", "extend_32768_8", "extend_8192_8",
        "prompt_opt_1024_64", "prompt_opt_32768_64", "prompt_opt_8192_64",
    ]
    static let maximumReportBytes = 32 * 1024
    static let maximumModelNameBytes = 160
    static let maximumExactJSONInteger: UInt64 = 9_007_199_254_740_991
    private static let legacyMeasurementMethods = [
        "scope": "One selected function is loaded; no generation, execution timing, quality qualification or recovery is performed",
        "preparation": "One AIModel with the production static-model Neural Engine preference; initialization may specialize the model before the selected function load; no StaticShapeEngine, embedding/state preload or retained warmup bank",
        "cache": "Cache state is unmeasured and untouched; no cache inspection load, clearing or automatic retry",
        "markers": "One bounded atomic Application Support JSON record, written synchronously before each risky call; a pending record alone is not proof of a crash",
        "elapsedMs": "ContinuousClock elapsed time for this diagnostic; observations and persistence are included",
        "physicalFootprintBytes": "task_info TASK_VM_INFO.phys_footprint; process snapshot, not a peak; absent on syscall failure",
        "availableMemoryBytes": "os_proc_available_memory; remaining per-app allocation budget, not free device RAM",
        "metalCurrentAllocatedBytes": "Default Metal device resource total at observation time, not a peak or Core AI allocation/placement measurement",
        "metalMaxBufferLengthBytes": "Default Metal device maximum single-buffer length; not a heap-size or app-memory limit",
        "metalRecommendedWorkingSetBytes": "Default Metal device performance recommendation; not a hard allocation limit",
        "thermalState": "ProcessInfo.thermalState category; no temperature estimate",
        "lowPowerMode": "ProcessInfo.isLowPowerModeEnabled",
        "aneExecution": "Actual ANE/GPU placement and utilization are not measured",
    ]
    private static let schema2MeasurementMethods = legacyMeasurementMethods.merging([
        "attempt": "Fresh UUID, wall-clock UTC start and process ID identify this manual probe; wall time is for crash correlation, not duration measurement",
        "nativeErrors": "At most three NSError domains, signed codes and Swift type names; unsafe labels are redacted and codes beyond exact JSON range omitted; descriptions, debug messages and other userInfo are omitted",
    ]) { _, new in new }
    static let measurementMethods = schema2MeasurementMethods.merging([
        "preparedLibrary": "Metadata inspection of the prepared AIModel before the selected function load: full function-name count, sorted sanitized prefix capped at 32 identifiers of 160 bytes, equality with source-summary name set and selected descriptor presence; no tensor allocation or execution",
    ]) { _, new in new }

    enum Stage: String, Codable, Sendable {
        case preparingModel = "preparing_model"
        case loadingFunction = "loading_function"
        case completed
        case failed
    }

    enum SampleStage: String, Codable, Sendable {
        case beforePrepare = "before_prepare"
        case beforeFunctionLoad = "before_function_load"
        case afterFunctionLoad = "after_function_load"
        case failed
    }

    enum Failure: String, Error, LocalizedError, Sendable {
        case invalidRequest = "E_LOAD_PROBE_INVALID_REQUEST"
        case invalidBundle = "E_LOAD_PROBE_INVALID_BUNDLE"
        case persistence = "E_LOAD_PROBE_PERSISTENCE"
        case corruptReport = "E_LOAD_PROBE_CORRUPT_REPORT"
        case unsupported = "E_LOAD_PROBE_UNSUPPORTED"

        var errorDescription: String? {
            switch self {
            case .invalidRequest: return "Choisis l’un des six graphes autorisés pour le diagnostic."
            case .invalidBundle: return "Le diagnostic nécessite le dossier local complet de Gemma 4 E2B à 32K."
            case .persistence: return "Impossible de sauvegarder le diagnostic ; aucune étape native supplémentaire n’a été lancée."
            case .corruptReport: return "Le dernier diagnostic enregistré est invalide ou trop volumineux."
            case .unsupported: return "Le diagnostic de chargement nécessite Core AI sur iOS 27.2."
            }
        }
    }

    enum NativeErrorCode: String, Codable, Sendable {
        case preparationFailed = "E_MODEL_PREPARATION_FAILED"
        case functionLoadFailed = "E_FUNCTION_LOAD_FAILED"
        case functionNotFound = "E_FUNCTION_NOT_FOUND"
    }

    struct Attempt: Codable, Sendable {
        let id: String
        let startedAtUTC: String
        let processIdentifier: Int32
        var entryPoint = "single_function_load_probe"

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
                  entryPoint == "single_function_load_probe" else { throw Failure.corruptReport }
        }
    }

    struct NativeErrorEvidence: Codable, Sendable {
        let domain: String
        let code: Int?
        let swiftType: String

        // These are identifiers, never descriptions or arbitrarily truncated messages.
        private static func label(_ value: String) -> String {
            let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._".utf8)
            guard !value.isEmpty, value.utf8.count <= 160,
                  value.utf8.allSatisfy({ allowed.contains($0) }) else { return "redacted" }
            return value
        }

        static func capture(_ error: any Error) -> [NativeErrorEvidence] {
            var result: [NativeErrorEvidence] = []
            var next: (any Error)? = error
            var seen = Set<ObjectIdentifier>()
            while let current = next, result.count < 3 {
                let native = current as NSError
                guard seen.insert(ObjectIdentifier(native)).inserted else { break }
                let code = (-9_007_199_254_740_991...9_007_199_254_740_991).contains(native.code) ? native.code : nil
                result.append(NativeErrorEvidence(domain: label(native.domain), code: code,
                    swiftType: label(String(reflecting: type(of: current)))))
                next = native.userInfo[NSUnderlyingErrorKey] as? any Error
            }
            return result
        }

        func validate() throws {
            guard domain == Self.label(domain), swiftType == Self.label(swiftType),
                  code.map({ (-9_007_199_254_740_991...9_007_199_254_740_991).contains($0) }) ?? true else { throw Failure.corruptReport }
        }
    }

    struct PreparedLibraryEvidence: Codable, Sendable {
        let functionCount: Int
        let functionNamesPrefix: [String]
        let functionNamesTruncated: Bool
        let matchesSourceSummary: Bool
        let selectedDescriptorPresent: Bool

        private static func label(_ value: String) -> String {
            let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._".utf8)
            guard !value.isEmpty, value.utf8.count <= 160,
                  value.utf8.allSatisfy({ allowed.contains($0) }) else { return "redacted" }
            return value
        }

        static func capture(functionNames: [String], sourceFunctionNames: Set<String>,
                            selectedDescriptorPresent: Bool) -> PreparedLibraryEvidence {
            PreparedLibraryEvidence(functionCount: functionNames.count,
                functionNamesPrefix: Array(functionNames.map(label).sorted().prefix(32)),
                functionNamesTruncated: functionNames.count > 32,
                matchesSourceSummary: Set(functionNames) == sourceFunctionNames,
                selectedDescriptorPresent: selectedDescriptorPresent)
        }

        func validate() throws {
            guard functionCount >= 0, UInt64(functionCount) <= maximumExactJSONInteger,
                  functionNamesPrefix.count == min(functionCount, 32),
                  functionNamesPrefix == functionNamesPrefix.sorted(),
                  functionNamesPrefix.allSatisfy({ $0 == Self.label($0) }),
                  functionNamesTruncated == (functionCount > 32) else { throw Failure.corruptReport }
        }
    }

    struct Reading: Sendable {
        var physicalFootprintBytes: UInt64?
        var availableMemoryBytes: UInt64?
        var metalCurrentAllocatedBytes: UInt64?
        var metalMaxBufferLengthBytes: UInt64?
        var metalRecommendedWorkingSetBytes: UInt64?
        var thermalState = "unknown"
        var lowPowerMode: Bool?
    }

    struct Sample: Codable, Sendable {
        let stage: SampleStage
        let elapsedMs: Double
        let physicalFootprintBytes: UInt64?
        let availableMemoryBytes: UInt64?
        let metalCurrentAllocatedBytes: UInt64?
        let metalMaxBufferLengthBytes: UInt64?
        let metalRecommendedWorkingSetBytes: UInt64?
        let thermalState: String
        let lowPowerMode: Bool?

        init(stage: SampleStage, elapsedMs: Double, reading: Reading) throws {
            guard elapsedMs.isFinite, elapsedMs >= 0 else { throw Failure.corruptReport }
            self.stage = stage
            self.elapsedMs = elapsedMs
            physicalFootprintBytes = Self.exact(reading.physicalFootprintBytes)
            availableMemoryBytes = Self.exact(reading.availableMemoryBytes)
            metalCurrentAllocatedBytes = Self.exact(reading.metalCurrentAllocatedBytes)
            metalMaxBufferLengthBytes = Self.exact(reading.metalMaxBufferLengthBytes)
            metalRecommendedWorkingSetBytes = Self.exact(reading.metalRecommendedWorkingSetBytes)
            thermalState = thermalStates.contains(reading.thermalState) ? reading.thermalState : "unknown"
            lowPowerMode = reading.lowPowerMode
        }

        private static func exact(_ value: UInt64?) -> UInt64? {
            value.flatMap { $0 <= maximumExactJSONInteger ? $0 : nil }
        }
    }

    struct Report: Codable, Sendable {
        var schemaVersion = 3
        var kind = "assistModelLoadDiagnostic"
        var scope = "single_function_load_only_no_generation"
        var aneExecution = "unverified"
        let nativeBuild: String
        let osVersion: String
        let functionName: String
        var contextCapacity = 32_768
        let modelName: String
        var attempt: Attempt?
        var stage = Stage.preparingModel
        var samples: [Sample] = []
        var errorCode: NativeErrorCode?
        var nativeErrors: [NativeErrorEvidence]?
        var preparedLibrary: PreparedLibraryEvidence?
        var measurementMethods = AssistModelLoadProbe.measurementMethods

        init(nativeBuild: String, osVersion: String, functionName: String, modelName: String) throws {
            guard functionNames.contains(functionName) else { throw Failure.invalidRequest }
            self.nativeBuild = Self.systemLabel(nativeBuild, maximumBytes: 32)
            self.osVersion = Self.systemLabel(osVersion, maximumBytes: 160)
            self.functionName = functionName
            self.modelName = sanitizedModelName(modelName)
            self.attempt = .current()
        }

        mutating func observe(_ stage: Stage, sampleStage: SampleStage, reading: Reading, elapsedMs: Double,
                              errorCode: NativeErrorCode? = nil, nativeError: (any Error)? = nil) throws {
            guard samples.count < 4 else { throw Failure.corruptReport }
            let sample = try Sample(stage: sampleStage, elapsedMs: elapsedMs, reading: reading)
            guard sample.elapsedMs >= (samples.last?.elapsedMs ?? 0) else { throw Failure.corruptReport }
            self.stage = stage
            self.errorCode = errorCode
            self.nativeErrors = nativeError.map(NativeErrorEvidence.capture)
            samples.append(sample)
        }

        private static func systemLabel(_ value: String, maximumBytes: Int) -> String {
            guard !value.isEmpty, value.utf8.count <= maximumBytes,
                  value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { return "unknown" }
            return value
        }

        func validate() throws {
            let expectedMethods: [String: String]
            switch schemaVersion {
            case 1: expectedMethods = legacyMeasurementMethods
            case 2: expectedMethods = schema2MeasurementMethods
            case 3: expectedMethods = AssistModelLoadProbe.measurementMethods
            default: throw Failure.corruptReport
            }
            guard kind == "assistModelLoadDiagnostic",
                  scope == "single_function_load_only_no_generation", aneExecution == "unverified",
                  functionNames.contains(functionName), contextCapacity == 32_768,
                  nativeBuild == Self.systemLabel(nativeBuild, maximumBytes: 32),
                  osVersion == Self.systemLabel(osVersion, maximumBytes: 160),
                  modelName == sanitizedModelName(modelName),
                  measurementMethods == expectedMethods,
                  (1...4).contains(samples.count) else { throw Failure.corruptReport }
            if schemaVersion < 3 {
                guard preparedLibrary == nil else { throw Failure.corruptReport }
            } else {
                let inspected = samples.contains(where: { $0.stage == .beforeFunctionLoad })
                guard inspected == (preparedLibrary != nil) else { throw Failure.corruptReport }
                try preparedLibrary?.validate()
                if stage == .failed {
                    guard (inspected ? (errorCode == .functionLoadFailed || errorCode == .functionNotFound)
                        : errorCode == .preparationFailed) else { throw Failure.corruptReport }
                }
            }
            if schemaVersion == 1 {
                guard attempt == nil, nativeErrors == nil else { throw Failure.corruptReport }
            } else {
                guard let attempt else { throw Failure.corruptReport }
                try attempt.validate()
                let threw = errorCode == .preparationFailed || errorCode == .functionLoadFailed
                guard threw == (nativeErrors != nil) else { throw Failure.corruptReport }
                if let nativeErrors {
                    guard (1...3).contains(nativeErrors.count) else { throw Failure.corruptReport }
                    try nativeErrors.forEach { try $0.validate() }
                }
            }
            let expected: [[SampleStage]]
            switch stage {
            case .preparingModel: expected = [[.beforePrepare]]
            case .loadingFunction: expected = [[.beforePrepare, .beforeFunctionLoad]]
            case .completed: expected = [[.beforePrepare, .beforeFunctionLoad, .afterFunctionLoad]]
            case .failed: expected = [[.beforePrepare, .failed], [.beforePrepare, .beforeFunctionLoad, .failed]]
            }
            guard expected.contains(samples.map(\.stage)), (stage == .failed) == (errorCode != nil) else {
                throw Failure.corruptReport
            }
            var previous = 0.0
            for sample in samples {
                guard sample.elapsedMs.isFinite, sample.elapsedMs >= previous,
                      thermalStates.contains(sample.thermalState),
                      [sample.physicalFootprintBytes, sample.availableMemoryBytes, sample.metalCurrentAllocatedBytes,
                       sample.metalMaxBufferLengthBytes, sample.metalRecommendedWorkingSetBytes]
                        .allSatisfy({ $0.map { $0 <= maximumExactJSONInteger } ?? true }) else { throw Failure.corruptReport }
                previous = sample.elapsedMs
            }
        }
    }

    private static let thermalStates: Set<String> = ["nominal", "fair", "serious", "critical", "unknown"]

    static func sanitizedModelName(_ value: String) -> String {
        let allowed: Set<UInt8> = Set(Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._ -".utf8))
        guard !value.isEmpty, value.utf8.count <= maximumModelNameBytes,
              value != ".", value != "..", value.utf8.allSatisfy({ allowed.contains($0) }),
              value.trimmingCharacters(in: .whitespaces) == value else { return "gemma4-e2b-local" }
        return value
    }

    /// Injected directory makes persistence and pre-call ordering testable without a model SDK.
    struct Store: Sendable {
        let directory: URL
        var url: URL { directory.appendingPathComponent("model-load-diagnostic.json", isDirectory: false) }

        static func applicationSupport() throws -> Store {
            do {
                let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                       appropriateFor: nil, create: true)
                return Store(directory: base.appendingPathComponent("AssistLoadDiagnostic", isDirectory: true))
            } catch { throw Failure.persistence }
        }

        @discardableResult
        func save(_ report: Report) throws -> String {
            try report.validate()
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let bytes = try encoder.encode(report)
            guard bytes.count <= maximumReportBytes else { throw Failure.persistence }
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])
                let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
                guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw Failure.persistence }
                if FileManager.default.fileExists(atPath: url.path) {
                    let existing = try FileManager.default.attributesOfItem(atPath: url.path)
                    guard existing[.type] as? FileAttributeType == .typeRegular else { throw Failure.persistence }
                }
                // The atomic replacement has finished before the caller proceeds to Core AI.
                try bytes.write(to: url, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
                return String(decoding: bytes, as: UTF8.self)
            } catch { throw Failure.persistence }
        }

        func readJSON() throws -> String {
            let attributes: [FileAttributeKey: Any]
            do { attributes = try FileManager.default.attributesOfItem(atPath: url.path) }
            catch {
                let error = error as NSError
                if error.domain == NSCocoaErrorDomain,
                   error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError { return "null" }
                throw Failure.corruptReport
            }
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  let size = attributes[.size] as? NSNumber, size.int64Value > 0,
                  size.int64Value <= maximumReportBytes else { throw Failure.corruptReport }
            do {
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                guard let bytes = try handle.read(upToCount: maximumReportBytes + 1),
                      !bytes.isEmpty, bytes.count <= maximumReportBytes else { throw Failure.corruptReport }
                let report = try JSONDecoder().decode(Report.self, from: bytes)
                try report.validate()
                // Decode/re-encode only declared fields; never replay unknown data from disk.
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
                return String(decoding: try encoder.encode(report), as: UTF8.self)
            } catch { throw Failure.corruptReport }
        }
    }

    static func lastReportJSON() throws -> String { try Store.applicationSupport().readJSON() }

    /// Factories are injected solely for bounded Foundation checks of persistence-before-call and lifetime.
    static func execute<Prepared: Sendable, Loaded>(
        report initial: Report, store: Store,
        reading: @Sendable () -> Reading, elapsed: @Sendable () -> Double,
        prepare: @Sendable () async throws -> Prepared,
        inspect: @Sendable (Prepared) -> PreparedLibraryEvidence,
        load: @Sendable (Prepared) throws -> Loaded?
    ) async throws -> String {
        var report = initial
        try report.observe(.preparingModel, sampleStage: .beforePrepare, reading: reading(), elapsedMs: elapsed())
        try store.save(report)
        let prepared: Prepared
        do { prepared = try await prepare() }
        catch {
            try report.observe(.failed, sampleStage: .failed, reading: reading(), elapsedMs: elapsed(),
                               errorCode: .preparationFailed, nativeError: error)
            return try store.save(report)
        }
        return try withExtendedLifetime(prepared) {
            report.preparedLibrary = inspect(prepared)
            try report.observe(.loadingFunction, sampleStage: .beforeFunctionLoad, reading: reading(), elapsedMs: elapsed())
            try store.save(report)
            let loaded: Loaded?
            do { loaded = try load(prepared) }
            catch {
                try report.observe(.failed, sampleStage: .failed, reading: reading(), elapsedMs: elapsed(),
                                   errorCode: .functionLoadFailed, nativeError: error)
                return try store.save(report)
            }
            guard let loaded else {
                try report.observe(.failed, sampleStage: .failed, reading: reading(), elapsedMs: elapsed(), errorCode: .functionNotFound)
                return try store.save(report)
            }
            return try withExtendedLifetime(loaded) {
                try report.observe(.completed, sampleStage: .afterFunctionLoad, reading: reading(), elapsedMs: elapsed())
                return try store.save(report)
            }
        }
    }

    @concurrent
    static func run(path: String, functionName: String) async throws -> String {
        guard functionNames.contains(functionName) else { throw Failure.invalidRequest }
        #if canImport(CoreAI) && canImport(CoreAILanguageModels) && canImport(Darwin)
        guard #available(iOS 27.2, *) else { throw Failure.unsupported }
        let bundle: LanguageModelBundle
        let assetURL: URL
        let sourceFunctionNames: Set<String>
        do {
            guard (path as NSString).isAbsolutePath else { throw Failure.invalidBundle }
            let root = URL(fileURLWithPath: path, isDirectory: true).resolvingSymlinksInPath().standardizedFileURL
            try validateLocalDirectory(root)
            bundle = try LanguageModelBundle(at: root)
            try AssistInferencePolicy.validateModel(tokenizer: bundle.tokenizer, context: bundle.maxContextLength,
                                                    embeddedTokenizer: bundle.hasEmbeddedTokenizer)
            guard bundle.maxContextLength == 32_768, bundle.modelBundle.kind == .llm, bundle.visionConfig == nil,
                  Set(bundle.modelBundle.assets.keys) == ["main"],
                  Set(bundle.modelBundle.auxiliaryAssets.keys) == ["per_layer_embeddings"] else { throw Failure.invalidBundle }
            for relative in Array(bundle.modelBundle.assets.values) + Array(bundle.modelBundle.auxiliaryAssets.values) {
                _ = try AssistInferencePolicy.confinedURL(relative, root: root)
            }
            for relative in ["tokenizer", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"] {
                _ = try AssistInferencePolicy.confinedURL(relative, root: root)
            }
            assetURL = try bundle.modelBundle.requireModelURL(for: "main")
            let asset = try AIModelAsset(contentsOf: assetURL)
            guard let summary = try asset.summary(includingStatistics: false) else { throw Failure.invalidBundle }
            let names = summary.functions.map(\.name)
            try AssistInferencePolicy.validateGraphs(names, context: 32_768)
            guard names.count == 9, Set(names) == functionNames.union(["load_embeddings", "gather_embeddings_8", "gather_embeddings_64"])
            else { throw Failure.invalidBundle }
            sourceFunctionNames = Set(names)
        } catch { throw Failure.invalidBundle }
        let store = try Store.applicationSupport()
        let report = try Report(nativeBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
                                osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
                                functionName: functionName, modelName: bundle.name)
        let started = ContinuousClock.now
        return try await execute(report: report, store: store, reading: readSystem, elapsed: {
            let duration = started.duration(to: ContinuousClock.now).components
            return max(0, Double(duration.seconds) * 1_000 + Double(duration.attoseconds) / 1e15)
        }, prepare: {
            try await AIModel(contentsOf: assetURL, options: SpecializationOptions(preferredComputeUnitKind: .neuralEngine))
        }, inspect: { model in
            PreparedLibraryEvidence.capture(functionNames: Array(model.functionNames), sourceFunctionNames: sourceFunctionNames,
                selectedDescriptorPresent: model.functionDescriptor(for: functionName) != nil)
        }, load: { model in try loadFunctionForProbe(model: model, name: functionName) })
        #else
        throw Failure.unsupported
        #endif
    }

    #if canImport(CoreAI) && canImport(CoreAILanguageModels) && canImport(Darwin)
    /// A named, non-inlined boundary helps distinguish probe loads in symbolicated reports.
    @inline(never)
    @available(iOS 27.2, *)
    private static func loadFunctionForProbe(model: AIModel, name: String) throws -> InferenceFunction? {
        let function = try model.loadFunction(named: name)
        return withExtendedLifetime(model) { function }
    }

    private static func validateLocalDirectory(_ root: URL) throws {
        let manager = FileManager.default
        try AssistModelDirectoryPolicy.validate(root, entry: { candidate in
            var status = stat()
            guard candidate.withUnsafeFileSystemRepresentation({ pointer in pointer.map { lstat($0, &status) } ?? -1 }) == 0
            else { throw Failure.invalidBundle }
            let values = try candidate.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isUbiquitousItemKey,
                .ubiquitousItemDownloadingStatusKey, .ubiquitousItemIsDownloadingKey])
            #if canImport(FileProvider)
            let hasPlaceholder = manager.fileExists(atPath: NSFileProviderManager.placeholderURL(for: candidate).path)
            #else
            let hasPlaceholder = false
            #endif
            let downloaded = values.ubiquitousItemDownloadingStatus
            return AssistModelDirectoryPolicy.Entry(isDirectory: values.isDirectory == true,
                isSymbolicLink: values.isSymbolicLink != false, isReadable: manager.isReadableFile(atPath: candidate.path),
                isUbiquitous: values.isUbiquitousItem == true,
                isDownloaded: status.st_flags & UInt32(SF_DATALESS) == 0 && !hasPlaceholder
                    && values.ubiquitousItemIsDownloading != true
                    && (downloaded == nil || downloaded == .current || downloaded == .downloaded))
        }, children: { try manager.contentsOfDirectory(at: $0, includingPropertiesForKeys: nil) })
    }
    #endif

    private static func readSystem() -> Reading {
        var reading = Reading()
        #if canImport(Darwin)
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        reading.physicalFootprintBytes = result == KERN_SUCCESS ? info.phys_footprint : nil
        #if os(iOS) || os(tvOS) || os(watchOS) || os(visionOS)
        reading.availableMemoryBytes = UInt64(os_proc_available_memory())
        #endif
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: reading.thermalState = "nominal"
        case .fair: reading.thermalState = "fair"
        case .serious: reading.thermalState = "serious"
        case .critical: reading.thermalState = "critical"
        @unknown default: reading.thermalState = "unknown"
        }
        reading.lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        #endif
        #if canImport(Metal)
        if let device = MTLCreateSystemDefaultDevice() {
            reading.metalCurrentAllocatedBytes = device.currentAllocatedSize >= 0 ? UInt64(device.currentAllocatedSize) : nil
            reading.metalMaxBufferLengthBytes = device.maxBufferLength >= 0 ? UInt64(device.maxBufferLength) : nil
            reading.metalRecommendedWorkingSetBytes = device.recommendedMaxWorkingSetSize
        }
        #endif
        return reading
    }
}
