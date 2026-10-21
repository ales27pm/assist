import Foundation
#if canImport(os)
import os
#endif

/// Local, content-free flight recorder. It cannot call the model, tools or a server.
/// Independent of the inference owner, so inspection/configuration stays available
/// while that owner is loading, generating or draining cancellation.
actor AssistDebugDiagnostics {
    static let shared = AssistDebugDiagnostics()
    static let maximumRecords = 512
    static let maximumSessionBytes = 262_144
    static let detailedSeconds = 900
    /// Bounded FIFO for synchronous native callbacks. It preserves callback
    /// order without awaiting disk work on a UIKit/transaction callback.
    nonisolated static func observe(category: Category, stage: Stage, outcome: Outcome,
                                    requestId: String? = nil, reason: Reason? = nil,
                                    field: Field? = nil, metrics: [Metric: Double] = [:]) {
        DebugSubmissionQueue.shared.enqueue(.init(category: category, stage: stage, outcome: outcome,
            requestId: requestId.flatMap { !$0.isEmpty && $0.utf8.count <= 200 ? $0 : nil },
            reason: reason, field: field, metrics: metrics))
    }
    enum Mode: String, Codable, Sendable { case off, standard, detailed }
    enum Category: String, Codable, Sendable, CaseIterable {
        case engine, planning, context, tools, consent, voice, network, apple, documents
        case translation, alarms, storage, bridge, lifecycle, performance, system
    }
    enum Stage: String, Codable, Sendable {
        case admission, context, tokenization, roots, leaves, generation, validation, proposal
        case permission, confirmation, execution, receipt, presentation, cancellation
        case modelLoad, lifecycle, systemReport, configuration
    }
    enum Outcome: String, Codable, Sendable { case began, completed, rejected, failed, cancelled, unknown, stalled }
    enum Reason: String, Codable, Sendable {
        case context, prompt, budget, json, shape, branch, text, distinctness, unsupported
        case boundary, stop, length, deadline, engine, unknown, eos1, turn106, tool50, otherStop, noStop
        case typeMismatch, missingField, unexpectedKeys, integerRange, duplicateID, fieldTooLong
        case controlCharacter, reservedContent, permissionDenied, outcomeUnknown, imageUnavailable
        case connectionUnavailable, cancelRequested, notObserved, systemCrash, systemHang, systemCPU
        case systemDisk, systemMemory, systemAppLaunch, memoryWarning, thermalSerious, thermalCritical
    }
    enum Field: String, Codable, Sendable { case roots, leaves, id, root, mode, tool, intent, condition, fit, grounding, payload, `protocol`, output }
    enum Metric: String, Codable, Sendable, CaseIterable {
        case durationMs, inputBytes, outputBytes, promptTokens, generatedTokens, budgetTokens
        case contextCapacity, messageCount, passIndex, branchIndex, fieldBytes, limitBytes, itemCount
        case pendingOperations, physicalFootprintBytes, availableMemoryBytes, cpuPercent
        case signal, exceptionType, reportCount, hangDurationMs
    }
    /// Only fixed native error identities are inspected. Never classify by an
    /// error message, URL or underlying arbitrary payload. ApplePlaces numeric
    /// identities are guarded against its policy enum by the wiring checks.
    nonisolated static func classifyNativeError(_ error: NSError?) -> Reason? {
        guard let error else { return nil }
        if error.domain == "Assist.ApplePlaces" {
            switch error.code {
            case 3: return .cancelRequested
            case 4: return .connectionUnavailable
            case 5: return .permissionDenied
            case 7: return .imageUnavailable
            default: return .unknown
            }
        }
        if error.domain == "Assist.WeatherAttribution", error.code == 1 { return .imageUnavailable }
        if error.domain == NSURLErrorDomain {
            return error.code == NSURLErrorCancelled ? .cancelRequested : .connectionUnavailable
        }
        switch error.userInfo["code"] as? String {
        case "E_PERMISSION", "E_AUTHORIZATION", "E_WEATHER_AUTHORIZATION", "E_CALENDAR_PERMISSION",
             "E_CONTACTS_PERMISSION", "E_REMINDERS_PERMISSION", "E_NOTIFICATION_PERMISSION": return .permissionDenied
        case "E_OUTCOME_UNKNOWN": return .outcomeUnknown
        case "E_APPLE_NETWORK", "E_PRIVATE_SERVICE_NETWORK": return .connectionUnavailable
        case "E_WEATHER_ATTRIBUTION": return .imageUnavailable
        case "E_CANCELLED", "E_CANCELED": return .cancelRequested
        default: return .unknown
        }
    }
    struct Record: Codable, Sendable {
        let sequence: Int
        let elapsedMs: Double
        let traceId: String?
        let category: Category
        let stage: Stage
        let outcome: Outcome
        let reason: Reason?
        let field: Field?
        let metrics: [String: Double]
        enum CodingKeys: String, CodingKey { case sequence, elapsedMs, traceId, category, stage, outcome, reason, field, metrics }
        func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(sequence, forKey: .sequence); try c.encode(elapsedMs, forKey: .elapsedMs)
            try c.encode(traceId, forKey: .traceId); try c.encode(category, forKey: .category)
            try c.encode(stage, forKey: .stage); try c.encode(outcome, forKey: .outcome)
            try c.encode(reason, forKey: .reason); try c.encode(field, forKey: .field); try c.encode(metrics, forKey: .metrics)
        }
        var valid: Bool {
            sequence > 0 && sequence <= Int(Int32.max) && elapsedMs.isFinite && elapsedMs >= 0 &&
            traceId.map(Self.validTrace) != false && metrics.count <= Metric.allCases.count &&
            metrics.allSatisfy { Metric(rawValue: $0.key) != nil && $0.value.isFinite && (0...9_007_199_254_740_991).contains($0.value) }
        }
        static func validTrace(_ value: String) -> Bool {
            guard value.first == "t", let n = Int(value.dropFirst()), n > 0, n <= Int(Int32.max) else { return false }
            return value == "t\(n)"
        }
    }
    struct Session: Codable, Sendable {
        let schemaVersion: Int
        let kind: String
        let sessionId: String
        let nativeBuild: String
        let osVersion: String
        let startedAt: Date
        let capturedAt: Date
        var records: [Record]
        var omittedRecords: Int
        let rejectedRecords: Int
        var valid: Bool {
            schemaVersion == 1 && kind == "assistDebugSession" && UUID(uuidString: sessionId)?.uuidString.lowercased() == sessionId &&
            Self.safeVersion(nativeBuild, maximum: 64) && Self.safeVersion(osVersion, maximum: 256) &&
            records.count <= maximumRecords && omittedRecords >= 0 && rejectedRecords >= 0 &&
            omittedRecords <= Int(Int32.max) && rejectedRecords <= Int(Int32.max) && records.allSatisfy(\.valid) &&
            zip(records, records.dropFirst()).allSatisfy { $0.sequence < $1.sequence && $0.elapsedMs <= $1.elapsedMs }
        }
        static func safeVersion(_ value: String, maximum: Int) -> Bool {
            !value.isEmpty && value.utf8.count <= maximum && value.unicodeScalars.allSatisfy {
                (65...90).contains($0.value) || (97...122).contains($0.value) || (48...57).contains($0.value) ||
                " ()_.-".unicodeScalars.contains($0)
            }
        }
    }
    struct Finding: Encodable, Sendable {
        let code: String
        let severity: String
        let evidence: String
        let sequence: Int?
        let traceId: String?
        enum CodingKeys: String, CodingKey { case code, severity, evidence, sequence, traceId }
        func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(code, forKey: .code); try c.encode(severity, forKey: .severity); try c.encode(evidence, forKey: .evidence)
            try c.encode(sequence, forKey: .sequence); try c.encode(traceId, forKey: .traceId)
        }
    }
    struct Coverage: Encodable, Sendable { let category: Category; let state: String }
    struct Limits: Encodable, Sendable {
        let maxRecords = maximumRecords
        let maxSessionBytes = maximumSessionBytes
        let maxPreviousSessions = 2
        let detailedSeconds = AssistDebugDiagnostics.detailedSeconds
    }
    struct Privacy: Encodable, Sendable { let contentCaptured = false; let automaticUpload = false }
    struct Status: Encodable, Sendable {
        let schemaVersion = 1
        let kind = "assistDebugStatus"
        let sessionId: String
        let revision: Int
        let mode: Mode
        let detailExpiresAt: Date?
        let recordCount: Int
        let omittedRecords: Int
        let rejectedRecords: Int
        let previousSessionCount: Int
        let persistence: String
        let records: [Record]
        let findings: [Finding]
        let coverage: [Coverage]
        let limits = Limits()
        let privacy = Privacy()
        enum CodingKeys: String, CodingKey {
            case schemaVersion, kind, sessionId, revision, mode, detailExpiresAt, recordCount, omittedRecords
            case rejectedRecords, previousSessionCount, persistence, records, findings, coverage, limits, privacy
        }
        func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(schemaVersion, forKey: .schemaVersion); try c.encode(kind, forKey: .kind)
            try c.encode(sessionId, forKey: .sessionId); try c.encode(revision, forKey: .revision); try c.encode(mode, forKey: .mode)
            try c.encode(detailExpiresAt, forKey: .detailExpiresAt); try c.encode(recordCount, forKey: .recordCount)
            try c.encode(omittedRecords, forKey: .omittedRecords); try c.encode(rejectedRecords, forKey: .rejectedRecords)
            try c.encode(previousSessionCount, forKey: .previousSessionCount); try c.encode(persistence, forKey: .persistence)
            try c.encode(records, forKey: .records); try c.encode(findings, forKey: .findings); try c.encode(coverage, forKey: .coverage)
            try c.encode(limits, forKey: .limits); try c.encode(privacy, forKey: .privacy)
        }
    }
    private struct Configuration: Codable { let schemaVersion: Int; let mode: Mode }
    private struct Settings: Codable { let enabled: Bool }
    private struct Bundle: Encodable {
        let schemaVersion = 1
        let kind = "assistDebugBundle"
        let exportedAt: Date
        let status: Status
        let current: Session
        let previous: [Session]
    }
    private let directory: URL
    private let clock: @Sendable () -> ContinuousClock.Instant
    private let wallClock: @Sendable () -> Date
    private let nativeBuild: String
    private let osVersion: String
    private var began: ContinuousClock.Instant
    private var beganDate: Date
    private var sessionId = UUID().uuidString.lowercased()
    private var started = false
    private var rotated = false
    private var mode = Mode.standard
    private var revision = 0
    private var expiry: ContinuousClock.Instant?
    private var expiresAt: Date?
    private var expiryTask: Task<Void, Never>?
    private var checkpointTask: Task<Void, Never>?
    private var epoch = 0
    private var lastCheckpoint: ContinuousClock.Instant?
    private var persistence = "notAttempted"
    private var records: [Record] = []
    private var omitted = 0
    private var rejected = 0
    private var sequence = 0
    private var traceCounter = 0
    private var traces: [String: String] = [:]
    private var traceOrder: [String] = []
    private var previous: [Session] = []
    private var coverageOverrides: [Category: String] = [:]
    #if canImport(os)
    private let logger = Logger(subsystem: "org.27pm.assist", category: "Diagnostics")
    #endif

    init(directory: URL? = nil, nativeBuild: String? = nil, osVersion: String? = nil,
         clock: @escaping @Sendable () -> ContinuousClock.Instant = { .now },
         wallClock: @escaping @Sendable () -> Date = { Date() }) {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        self.directory = directory ?? support.appendingPathComponent("AssistDiagnostics/Advanced", isDirectory: true)
        self.clock = clock; self.wallClock = wallClock; began = clock(); beganDate = wallClock()
        let build = nativeBuild ?? (Foundation.Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown")
        let version = osVersion ?? ProcessInfo.processInfo.operatingSystemVersionString
        self.nativeBuild = Session.safeVersion(build, maximum: 64) ? build : "unknown"
        self.osVersion = Session.safeVersion(version, maximum: 256) ? version : "unknown"
    }
    deinit { expiryTask?.cancel(); checkpointTask?.cancel() }
    private static func increment(_ n: Int) -> Int { min(Int(Int32.max), n + 1) }
    private static func failure() -> NSError {
        NSError(domain: "Assist.DebugDiagnostics", code: 1, userInfo: [NSLocalizedDescriptionKey: "Le journal de diagnostic avancé est indisponible."])
    }
    private static func encode<T: Encodable>(_ value: T) throws -> Data {
        let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]; e.dateEncodingStrategy = .iso8601
        return try e.encode(value)
    }
    private static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return try d.decode(type, from: data)
    }
    /// Configuration is a tiny flat object. Foundation has already checked JSON
    /// syntax; count decoded keys as well so duplicate/escaped aliases cannot
    /// choose which setting the two platform decoders happen to retain.
    private static func configurationKeys(_ data: Data) throws -> [String] {
        let bytes = Array(data); var index = 0; var keys: [String] = []
        while index < bytes.count {
            guard bytes[index] == 34 else { index += 1; continue }
            let start = index; index += 1
            while index < bytes.count {
                if bytes[index] == 92 { index += 2; continue }
                if bytes[index] == 34 { break }; index += 1
            }
            guard index < bytes.count else { throw failure() }; index += 1
            let end = index
            while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 }
            if index < bytes.count && bytes[index] == 58 {
                keys.append(try JSONDecoder().decode(String.self, from: Data(bytes[start..<end])))
            }
        }
        return keys
    }
    private func path(_ name: String) -> URL { directory.appendingPathComponent(name) }
    private func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let a = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard a[.type] as? FileAttributeType == .typeDirectory else { throw Self.failure() }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        #if canImport(Darwin)
        var dir = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true; try dir.setResourceValues(values)
        #endif
    }
    private func read(_ name: String, maximum: Int = maximumSessionBytes) throws -> Data? {
        guard FileManager.default.fileExists(atPath: path(name).path) else { return nil }
        let a = try FileManager.default.attributesOfItem(atPath: path(name).path)
        guard a[.type] as? FileAttributeType == .typeRegular, let n = a[.size] as? NSNumber,
              n.intValue > 0, n.intValue <= maximum else { throw Self.failure() }
        let data = try Data(contentsOf: path(name)); guard data.count <= maximum else { throw Self.failure() }; return data
    }
    private func write(_ data: Data, _ name: String) throws {
        guard data.count <= Self.maximumSessionBytes else { throw Self.failure() }
        try prepareDirectory()
        // Atomic replacement does not follow a pre-existing destination symlink.
        #if canImport(UIKit)
        try data.write(to: path(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: path(name), options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path(name).path)
        #if canImport(Darwin)
        var file = path(name); var values = URLResourceValues(); values.isExcludedFromBackup = true; try file.setResourceValues(values)
        #endif
    }
    private func readSession(_ name: String) -> Session? {
        do {
            guard let data = try read(name), let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(object.keys) == ["schemaVersion", "kind", "sessionId", "nativeBuild", "osVersion", "startedAt", "capturedAt", "records", "omittedRecords", "rejectedRecords"],
                  let rows = object["records"] as? [[String: Any]], rows.count <= Self.maximumRecords,
                  rows.allSatisfy({ Set($0.keys) == ["sequence", "elapsedMs", "traceId", "category", "stage", "outcome", "reason", "field", "metrics"] }) else { return nil }
            let session = try Self.decode(Session.self, data); return session.valid ? session : nil
        } catch { return nil }
    }
    private func rotateIfNeeded() throws {
        guard !rotated else { return }
        let first = readSession("previous.json"), older = readSession("older.json")
        if let current = readSession("current.json") {
            if let first, first.sessionId != current.sessionId { try write(Self.encode(first), "older.json") }
            try write(Self.encode(current), "previous.json")
            previous = [current, first].compactMap { $0 }
        } else { previous = [first, older].compactMap { $0 } }
        var ids = Set([sessionId]); previous = Array(previous.filter { ids.insert($0.sessionId).inserted }.prefix(2))
        rotated = true
    }
    func start() {
        guard !started else { return }; started = true
        do {
            if let data = try read("settings.json", maximum: 128),
               let value = try? Self.decode(Settings.self, data) { mode = value.enabled ? .standard : .off }
            if mode == .off {
                // Off survives process relaunch. Inspection must not rotate or write.
                var ids = Set([sessionId])
                previous = Array([readSession("current.json"), readSession("previous.json"), readSession("older.json")]
                    .compactMap { $0 }.filter { ids.insert($0.sessionId).inserted }.prefix(2))
            } else { try rotateIfNeeded(); checkpoint(force: true) }
        } catch { persistence = "unavailable" }
    }
    /// Coverage is set only by compiled native collectors, never by imported config.
    func setCoverage(_ category: Category, available: Bool) { coverageOverrides[category] = available ? "partial" : "unavailable" }
    func recordOmission(_ count: Int) {
        start(); refreshLease(); guard mode != .off, count > 0 else { return }
        omitted = min(Int(Int32.max), omitted + min(count, Int(Int32.max)))
    }
    func acceptSubmission(_ input: DebugSubmissionQueue.Input?, lost: Int, generation: UInt64, source: DebugSubmissionQueue) {
        // Purge/Off invalidates callbacks already queued on another executor.
        // No suspension between checking the ticket and accepting the record.
        guard source.isCurrent(generation) else { return }
        if lost > 0 { recordOmission(lost) }
        if let input {
            record(category: input.category, stage: input.stage, outcome: input.outcome,
                requestId: input.requestId, reason: input.reason, field: input.field, metrics: input.metrics)
        }
    }
    private func refreshLease() {
        if let expiry, clock() >= expiry {
            mode = .standard; self.expiry = nil; expiresAt = nil; expiryTask?.cancel(); expiryTask = nil
            revision = Self.increment(revision)
        }
    }
    private func trace(_ raw: String?) -> String? {
        guard var key = raw, !key.isEmpty, key.utf8.count <= 200 else { return nil }
        for suffix in [":tree-roots", ":tree-leaves"] where key.hasSuffix(suffix) { key.removeLast(suffix.count) }
        if let value = traces[key] { return value }
        guard traceCounter < Int(Int32.max) else { return nil }
        traceCounter += 1; let value = "t\(traceCounter)"; traces[key] = value; traceOrder.append(key)
        if traceOrder.count > 64 { traces.removeValue(forKey: traceOrder.removeFirst()) }
        return value
    }
    func record(category: Category, stage: Stage, outcome: Outcome, requestId: String? = nil,
                reason: Reason? = nil, field: Field? = nil, metrics: [Metric: Double] = [:]) {
        start(); refreshLease(); guard mode != .off else { return }
        // Standard retains major boundaries/failures. Detail adds intermediate validation/context.
        if mode == .standard && (stage == .context || stage == .tokenization || stage == .validation) &&
            (outcome == .began || outcome == .completed) { return }
        guard metrics.count <= Metric.allCases.count,
              metrics.values.allSatisfy({ $0.isFinite && (0...9_007_199_254_740_991).contains($0) }) else {
            rejected = Self.increment(rejected); return
        }
        guard sequence < Int(Int32.max) else { omitted = Self.increment(omitted); return }
        sequence += 1
        let delta = began.duration(to: clock()).components
        let elapsed = max(records.last?.elapsedMs ?? 0, max(0, Double(delta.seconds) * 1000 + Double(delta.attoseconds) / 1e15))
        let row = Record(sequence: sequence, elapsedMs: elapsed, traceId: trace(requestId), category: category,
            stage: stage, outcome: outcome, reason: reason, field: field,
            metrics: Dictionary(uniqueKeysWithValues: metrics.map { ($0.key.rawValue, $0.value) }))
        records.append(row)
        if records.count > Self.maximumRecords { records.removeFirst(); omitted = Self.increment(omitted) }
        #if canImport(os)
        if outcome == .failed || outcome == .rejected {
            logger.error("Diagnostic category=\(category.rawValue, privacy: .public) stage=\(stage.rawValue, privacy: .public) outcome=\(outcome.rawValue, privacy: .public)")
        }
        #endif
        checkpoint(force: false)
    }
    private func session() -> Session {
        Session(schemaVersion: 1, kind: "assistDebugSession", sessionId: sessionId, nativeBuild: nativeBuild,
            osVersion: osVersion, startedAt: beganDate, capturedAt: wallClock(), records: records,
            omittedRecords: omitted, rejectedRecords: rejected)
    }
    private func checkpoint(force: Bool) {
        guard mode != .off else { return }
        if !force, let lastCheckpoint, lastCheckpoint.duration(to: clock()) < .seconds(1) {
            guard checkpointTask == nil else { return }; let currentEpoch = epoch
            checkpointTask = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                await self?.flush(epoch: currentEpoch)
            }; return
        }
        lastCheckpoint = clock()
        do {
            try rotateIfNeeded()
            var value = session(); var bytes = try Self.encode(value)
            while bytes.count > Self.maximumSessionBytes, !value.records.isEmpty {
                value.records.removeFirst(); value.omittedRecords = Self.increment(value.omittedRecords); bytes = try Self.encode(value)
            }
            records = value.records; omitted = value.omittedRecords
            try write(bytes, "current.json"); persistence = "saved"
        } catch { persistence = "unavailable" }
    }
    private func flush(epoch expected: Int) {
        guard expected == epoch else { return }; checkpointTask = nil; refreshLease(); checkpoint(force: false)
    }
    private func findings() -> [Finding] {
        var result: [Finding] = []
        if omitted > 0 { result.append(Finding(code: "collectionTruncated", severity: "warning", evidence: "observed", sequence: nil, traceId: nil)) }
        if persistence == "unavailable" { result.append(Finding(code: "persistenceUnavailable", severity: "warning", evidence: "observed", sequence: nil, traceId: nil)) }
        for row in records.reversed() {
            let code: String?
            switch row.reason {
            case .systemCrash: code = "systemCrashReport"
            case .systemHang: code = "systemHangReport"
            case .systemCPU, .systemDisk, .systemMemory, .systemAppLaunch: code = "systemResourceReport"
            case .permissionDenied: code = "permissionDenied"
            case .outcomeUnknown: code = "outcomeUnknown"
            default:
                if row.category == .planning && row.outcome == .rejected { code = "preparationRejected" }
                else if row.stage == .cancellation && row.outcome == .completed { code = "cancellationObserved" }
                else if row.outcome == .cancelled { code = "generationInterrupted" }
                else if row.outcome == .failed { code = "nativeFailure" }
                else { code = nil }
            }
            if let code { result.append(Finding(code: code, severity: row.reason == .systemCrash ? "critical" : "warning", evidence: "observed", sequence: row.sequence, traceId: row.traceId)) }
            if result.count >= 31 { break }
        }
        result.append(Finding(code: "noCausalEvidence", severity: "info", evidence: "unmeasured", sequence: nil, traceId: nil))
        return result
    }
    private func status() -> Status {
        let coverage = Category.allCases.map { category in
            Coverage(category: category, state: coverageOverrides[category] ?? "unavailable")
        }
        return Status(sessionId: sessionId, revision: revision, mode: mode, detailExpiresAt: expiresAt,
            recordCount: records.count, omittedRecords: omitted, rejectedRecords: rejected,
            previousSessionCount: previous.count, persistence: persistence, records: Array(records.suffix(30)),
            findings: findings(), coverage: coverage)
    }
    func snapshotJSON() throws -> String { start(); refreshLease(); return String(decoding: try Self.encode(status()), as: UTF8.self) }
    func configureJSON(_ json: String) throws -> String {
        start()
        guard json.utf8.count <= 128, let data = json.data(using: .utf8),
              let row = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(row.keys) == ["schemaVersion", "mode"],
              try Self.configurationKeys(data).count == 2 else { throw Self.failure() }
        let config = try Self.decode(Configuration.self, data); guard config.schemaVersion == 1 else { throw Self.failure() }
        DebugSubmissionQueue.shared.invalidate()
        expiryTask?.cancel(); expiryTask = nil; expiry = nil; expiresAt = nil
        mode = config.mode; revision = Self.increment(revision)
        if mode == .off { checkpointTask?.cancel(); checkpointTask = nil; epoch = Self.increment(epoch) }
        do { try write(Self.encode(Settings(enabled: mode != .off)), "settings.json") } catch { persistence = "unavailable" }
        if mode == .detailed {
            expiry = clock().advanced(by: .seconds(Self.detailedSeconds)); expiresAt = wallClock().addingTimeInterval(Double(Self.detailedSeconds))
            let expected = revision
            expiryTask = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(Self.detailedSeconds)) } catch { return }
                await self?.expire(revision: expected)
            }
        }
        if mode != .off { record(category: .lifecycle, stage: .configuration, outcome: .completed) }
        return try snapshotJSON()
    }
    private func expire(revision expected: Int) { guard revision == expected else { return }; refreshLease() }
    func exportJSON() throws -> String {
        start(); refreshLease()
        // A burst between checkpoints can fill the RAM ring. Enforce the byte
        // ceiling here too, and expose exactly the same trimmed count in status.
        var current = session(); var bytes = try Self.encode(current)
        while bytes.count > Self.maximumSessionBytes, !current.records.isEmpty {
            current.records.removeFirst(); current.omittedRecords = Self.increment(current.omittedRecords)
            bytes = try Self.encode(current)
        }
        records = current.records; omitted = current.omittedRecords
        let result = Bundle(exportedAt: wallClock(), status: status(), current: current, previous: previous)
        let data = try Self.encode(result); guard data.count <= 1_048_576 else { throw Self.failure() }
        return String(decoding: data, as: UTF8.self)
    }
    func clearJSON() throws -> String {
        start(); DebugSubmissionQueue.shared.invalidate()
        epoch = Self.increment(epoch); checkpointTask?.cancel(); checkpointTask = nil
        expiryTask?.cancel(); expiryTask = nil; expiry = nil; expiresAt = nil
        if mode == .detailed { mode = .standard }
        revision = Self.increment(revision)
        records.removeAll(); previous.removeAll(); traces.removeAll(); traceOrder.removeAll()
        omitted = 0; rejected = 0; sequence = 0; traceCounter = 0
        sessionId = UUID().uuidString.lowercased(); began = clock(); beganDate = wallClock(); lastCheckpoint = nil
        rotated = true
        do {
            for name in ["current.json", "previous.json", "older.json"] {
                if FileManager.default.fileExists(atPath: path(name).path) { try FileManager.default.removeItem(at: path(name)) }
            }
            persistence = "notAttempted"
        } catch { persistence = "unavailable"; throw Self.failure() }
        return try snapshotJSON()
    }
}

final class DebugSubmissionQueue: @unchecked Sendable {
    struct Input: Sendable {
        let category: AssistDebugDiagnostics.Category
        let stage: AssistDebugDiagnostics.Stage
        let outcome: AssistDebugDiagnostics.Outcome
        let requestId: String?
        let reason: AssistDebugDiagnostics.Reason?
        let field: AssistDebugDiagnostics.Field?
        let metrics: [AssistDebugDiagnostics.Metric: Double]
    }
    static let shared = DebugSubmissionQueue()
    private let lock = NSLock()
    private var queue: [(Input, UInt64)] = []
    private var lost = 0
    private var running = false
    private var generation: UInt64 = 0
    private let recorder: AssistDebugDiagnostics?
    init(recorder: AssistDebugDiagnostics? = nil) { self.recorder = recorder }
    func invalidate() {
        lock.lock(); defer { lock.unlock() }
        generation &+= 1; queue.removeAll(); lost = 0
    }
    func isCurrent(_ ticket: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }; return generation == ticket
    }
    func enqueue(_ input: Input) {
        lock.lock()
        if queue.count < 64 { queue.append((input, generation)) }
        else { lost = min(Int(Int32.max), lost + 1) }
        let launch = !running; running = true
        lock.unlock()
        if launch { Task(priority: .utility) { await self.drain() } }
    }
    private func take() -> (Input?, Int, UInt64) {
        lock.lock(); defer { lock.unlock() }
        let count = lost; lost = 0
        if queue.isEmpty { running = false; return (nil, count, generation) }
        let (input, ticket) = queue.removeFirst()
        return (input, count, ticket)
    }
    private func drain() async {
        while true {
            let (input, lost, ticket) = take()
            await (recorder ?? AssistDebugDiagnostics.shared).acceptSubmission(input, lost: lost, generation: ticket, source: self)
            if input == nil { return }
        }
    }
}

/// Serialize diagnostic controls in invocation order, independently of model
/// ownership. Starting separate Tasks for configure/clear would let an older
/// configuration enter the actor after a newer purge. Bound pending calls too.
final class AssistDebugControlQueue: @unchecked Sendable {
    static let shared = AssistDebugControlQueue()
    private let lock = NSLock()
    private var tail: Task<Void, Never>?
    private var serial: UInt64 = 0
    private var pending = 0
    @discardableResult
    func enqueue(_ operation: @escaping @Sendable () async -> Void) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard pending < 32 else { return false }
        pending += 1; serial &+= 1
        let ticket = serial; let previous = tail
        tail = Task(priority: .utility) {
            await previous?.value
            await operation()
            self.finished(ticket)
        }
        return true
    }
    private func finished(_ ticket: UInt64) {
        lock.lock(); defer { lock.unlock() }
        pending -= 1
        if serial == ticket { tail = nil }
    }
}

/// Restricted Objective-C seam. It never accepts a logger string, arbitrary
/// categories, a file path, script, URL, or instruction from JavaScript/Gemma.
#if canImport(ObjectiveC)
@objc(AssistDebugDiagnosticsBridge)
final class AssistDebugDiagnosticsBridge: NSObject {
    private static func perform(_ completion: @escaping @Sendable (String?, NSError?) -> Void,
                                _ operation: @escaping @Sendable () async throws -> String) {
        if !AssistDebugControlQueue.shared.enqueue({
            do { completion(try await operation(), nil) }
            catch { completion(nil, error as NSError) }
        }) {
            completion(nil, NSError(domain: "Assist.DebugDiagnostics", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Le journal avancé traite déjà plusieurs demandes."]))
        }
    }
    private final class CompletionLatch: @unchecked Sendable {
        let lock = NSLock()
        var settled = false
        func claim() -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard !settled else { return false }; settled = true; return true
        }
    }
    /// Internal native call sites pass a literal category. No request/result
    /// contents or raw NSError cross the queue; only byte count, duration and
    /// a small error classification are computed before invoking the caller.
    @objc(trace:completion:)
    static func trace(_ category: String, completion: @escaping @Sendable (String?, NSError?) -> Void) -> @Sendable (String?, NSError?) -> Void {
        guard let category = AssistDebugDiagnostics.Category(rawValue: category) else { return completion }
        let key = UUID().uuidString
        let clock = ContinuousClock(); let start = clock.now; let latch = CompletionLatch()
        AssistDebugDiagnostics.observe(category: category, stage: .execution, outcome: .began, requestId: key)
        return { result, error in
            guard latch.claim() else { return }
            let elapsed = start.duration(to: clock.now).components
            let duration = max(0, Double(elapsed.seconds) * 1000 + Double(elapsed.attoseconds) / 1e15)
            let reason = AssistDebugDiagnostics.classifyNativeError(error)
            // This observes a native callback, not the semantic success of an
            // action carried inside JSON. Broker receipts have their own hook.
            let outcome: AssistDebugDiagnostics.Outcome = reason == .cancelRequested ? .cancelled
                : (reason == .outcomeUnknown ? .unknown : (error == nil && result != nil ? .completed : .failed))
            AssistDebugDiagnostics.observe(category: category, stage: .execution,
                outcome: outcome,
                requestId: key, reason: reason,
                metrics: [.durationMs: duration, .outputBytes: Double(result?.utf8.count ?? 0)])
            completion(result, error)
        }
    }
    @objc(snapshot:)
    func snapshot(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        Self.perform(completion) { try await AssistDebugDiagnostics.shared.snapshotJSON() }
    }
    @objc(configure:completion:)
    func configure(_ json: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard json.utf8.count <= 128 else {
            completion(nil, NSError(domain: "Assist.DebugDiagnostics", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Configuration de diagnostic invalide."])); return
        }
        Self.perform(completion) { try await AssistDebugDiagnostics.shared.configureJSON(json) }
    }
    @objc(exportBundle:)
    func exportBundle(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        Self.perform(completion) { try await AssistDebugDiagnostics.shared.exportJSON() }
    }
    @objc(clear:)
    func clear(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        Self.perform(completion) { try await AssistDebugDiagnostics.shared.clearJSON() }
    }
}
#endif
