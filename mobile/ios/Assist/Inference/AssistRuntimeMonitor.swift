// Observability adapted from ales27pm/rork-swiftllm-mobile-stack,
// commit dbd1a56fc8130c5de77e6d11b2be58cc23699f8a:
// ios/NeuralEngine/Services/{MetricsLogger,ThermalGovernor}.swift.
// Uses bounded telemetry only; no recovery, throttling or inference policy is copied.
import Dispatch
import Foundation
#if canImport(Darwin)
import Darwin
#endif
#if canImport(os)
import os
#endif
#if canImport(UIKit)
import UIKit
#endif

struct AssistRuntimeSystemReading: Sendable {
    var physicalFootprintBytes: UInt64?
    var availableMemoryBytes: UInt64?
    var cumulativeCPUSeconds: Double?
    var thermalState = "unknown"
    var lowPowerMode: Bool?
}

struct AssistRuntimeSample: Codable, Sendable {
    let phase: String
    let voiceStage: String?
    let sessionElapsedMs: Double
    let physicalFootprintBytes: UInt64?
    let peakPhysicalFootprintBytes: UInt64?
    let availableMemoryBytes: UInt64?
    let cpuPercent: Double?
    let thermalState: String
    let memoryPressure: String
    let lowPowerMode: Bool?
    let promptTokens: Int?
    let generatedTokens: Int?
    let ttftMs: Double?
    let decodeTokensPerSecond: Double?
    let generationElapsedMs: Double?
    let contextCapacity: Int?
    let requestId: String?
}

struct AssistRuntimeEvent: Codable, Sendable {
    let sequence: Int
    let elapsedMs: Double
    let observedElapsedMs: Double?
    let code: String
    let severity: String
    let phase: String
}

struct AssistRuntimeDiagnostic: Codable, Sendable {
    var completed = 0
    let total: Int
    var failed = 0
}

/// Technical metadata only. Values, arbitrary model feature names and paths
/// must never cross the SDK/monitor boundary or survive archive decoding.
struct AssistRuntimePredictionTensor: Codable, Sendable {
    let name: String
    let shape: [Int]
    let dataType: String
    let count: Int

    static func knownName(_ name: String) -> Bool {
        let fixed = [
            "conditioning", "valid_len", "sequence", "bos_emb", "transformer_out", "latent_init", "latent",
            "audio_signal", "audio_signal_length", "audio", "audio_length", "length", "mel", "mel_length",
            "upsample_partial", "attn0_cache", "attn0_offset", "attn1_cache", "attn1_offset",
            "conv0_prev", "conv0_first", "convtr0_partial", "convtr1_partial", "convtr2_partial",
            "res0_conv0_prev", "res0_conv0_first", "res0_conv1_prev", "res0_conv1_first",
            "res1_conv0_prev", "res1_conv0_first", "res1_conv1_prev", "res1_conv1_first",
            "res2_conv0_prev", "res2_conv0_first", "res2_conv1_prev", "res2_conv1_first",
            "conv_final_prev", "conv_final_first",
        ]
        if fixed.contains(name) { return true }
        for prefix in ["cache", "position", "k_cache", "v_cache"] where name.hasPrefix(prefix) {
            let suffix = String(name.dropFirst(prefix.count))
            if let index = Int(suffix), (0..<24).contains(index), suffix == String(index) { return true }
        }
        return false
    }

    var isValid: Bool {
        Self.knownName(name) && shape.count <= 8 && shape.allSatisfy { (0...Int(Int32.max)).contains($0) } &&
            ["float16", "float32", "float64", "int32", "other"].contains(dataType) &&
            (0...Int(Int32.max)).contains(count)
    }
}

struct AssistRuntimePrediction: Codable, Sendable {
    static let components = Set(["pocket.conditioner", "pocket.flowlm", "pocket.flow", "pocket.mimi",
                                 "parakeet.preprocessor", "parakeet.encoder"])
    let id: String
    let component: String
    let state: String
    let computeUnits: String
    let inputs: [AssistRuntimePredictionTensor]
    let inputFeatureCount: Int
    let metadataTruncated: Bool
    let voiceTurn: Int
    let observedElapsedMs: Double

    var isValid: Bool {
        UUID(uuidString: id) != nil && Self.components.contains(component) &&
            ["began", "completed", "failed"].contains(state) &&
            ["all", "cpuAndGPU", "cpuOnly", "cpuAndNeuralEngine", "other"].contains(computeUnits) &&
            inputs.count <= 8 && inputs.allSatisfy(\.isValid) &&
            Set(inputs.map(\.name)).count == inputs.count && (0...128).contains(inputFeatureCount) &&
            inputs.count <= inputFeatureCount && (0...Int(Int32.max)).contains(voiceTurn) &&
            observedElapsedMs.isFinite && observedElapsedMs >= 0
    }
}

struct AssistRuntimeGenerationSummary: Codable, Sendable {
    let requestId: String?
    let promptTokens: Int?
    let generatedTokens: Int?
    let ttftMs: Double?
    let decodeTokensPerSecond: Double?
    let generationElapsedMs: Double?
    let contextCapacity: Int?
    let finishReason: String
}

/// A preparation outcome, never an assertion that a user-visible answer or an
/// OS action completed. Only fixed codes and measured counts are exported.
enum AssistRuntimeThoughtTreeOutcome: String, Sendable, CaseIterable {
    case ready, rejected, cancelled, error

    var finishReason: String { "tree_" + rawValue }
    var code: String { "THOUGHT_TREE_" + rawValue.uppercased() }
}

private struct AssistRuntimeThoughtTree: Sendable {
    let key: String
    let requestId: String
    let startedAtMs: Double
    var rootsStarted = false
    var leavesStarted = false
    var roots: AssistRuntimeGenerationSummary?
    var leaves: AssistRuntimeGenerationSummary?
    var invalid = false

    private func passIndex(_ key: String) -> Int? {
        let prefix = String(self.key.prefix(100))
        if key == prefix + ":tree-roots" { return 0 }
        if key == prefix + ":tree-leaves" { return 1 }
        return nil
    }

    mutating func beginPass(_ key: String) {
        guard let index = passIndex(key) else { return }
        if index == 0 {
            if rootsStarted { invalid = true }
            rootsStarted = true
        } else {
            if leavesStarted || !rootsStarted || roots == nil { invalid = true }
            leavesStarted = true
        }
    }

    mutating func endPass(_ key: String, summary: AssistRuntimeGenerationSummary, measured: Bool) {
        guard let index = passIndex(key) else { return }
        guard measured else { invalid = true; return }
        if index == 0 {
            guard rootsStarted, roots == nil else { invalid = true; return }
            roots = summary
        } else {
            guard leavesStarted, leaves == nil else { invalid = true; return }
            leaves = summary
        }
    }

    var completeEOS: Bool {
        !invalid && roots?.finishReason == "eos" && leaves?.finishReason == "eos"
    }

    /// A thrown/unended pass may have consumed tokens. In that case a partial
    /// sum would misrepresent the preparation total, so both counts stay nil.
    func total(_ value: (AssistRuntimeGenerationSummary) -> Int?) -> Int? {
        guard !invalid, (!rootsStarted || roots != nil), (!leavesStarted || leaves != nil) else { return nil }
        let summaries = [roots, leaves].compactMap { $0 }
        guard !summaries.isEmpty else { return nil }
        var sum = 0
        for summary in summaries {
            guard let count = value(summary), AssistRuntimeMetrics.count(count) != nil else { return nil }
            let added = sum.addingReportingOverflow(count)
            guard !added.overflow, AssistRuntimeMetrics.count(added.partialValue) != nil else { return nil }
            sum = added.partialValue
        }
        return sum
    }
}

/// A finite event vocabulary for native tool passes. No prompt, result, tool
/// name, arbitrary token ID or SDK cache contents cross this boundary.
enum AssistRuntimeToolPass {
    private enum Outcome: String, CaseIterable {
        case eosEmpty = "EOS_EMPTY", eosTokens = "EOS_TOKENS"
        case boundaryEmpty = "BOUNDARY_EMPTY", boundary = "BOUNDARY"
        case length = "LENGTH", cancelled = "CANCELLED", error = "ERROR"
    }

    static let codes = Set((0...4).flatMap { index in
        Outcome.allCases.map { "TOOL_PASS_\(index)_\($0.rawValue)" }
    })

    static func code(passIndex: Int, finishReason: String, stoppedAtToolResponse: Bool,
                     generatedTokens: Int?) -> String? {
        guard (0...4).contains(passIndex),
              generatedTokens.map({ AssistRuntimeMetrics.count($0) != nil }) != false else { return nil }
        let outcome: Outcome
        switch finishReason {
        case "eos":
            guard let generatedTokens else { return nil }
            outcome = stoppedAtToolResponse
                ? (generatedTokens == 0 ? .boundaryEmpty : .boundary)
                : (generatedTokens == 0 ? .eosEmpty : .eosTokens)
        case "length": outcome = .length
        case "cancelled": outcome = .cancelled
        case "error": outcome = .error
        default: return nil
        }
        return "TOOL_PASS_\(passIndex)_\(outcome.rawValue)"
    }
}

/// Fixed-capacity storage: appending does not shift or grow the history.
struct AssistRuntimeRing<Element: Sendable>: Sendable {
    private var storage: [Element?]
    private var next = 0
    private(set) var count = 0

    init(capacity: Int) {
        precondition(capacity > 0)
        storage = Array(repeating: nil, count: capacity)
    }

    mutating func append(_ value: Element) {
        storage[next] = value
        next = (next + 1) % storage.count
        count = min(count + 1, storage.count)
    }

    var values: [Element] {
        (0..<count).compactMap { storage[(next - count + storage.count + $0) % storage.count] }
    }
}

enum AssistRuntimeMetrics {
    static func milliseconds(_ duration: Duration) -> Double {
        let parts = duration.components
        return max(0, Double(parts.seconds) * 1_000 + Double(parts.attoseconds) / 1e15)
    }

    static func duration(_ value: Double?) -> Double? {
        guard let value, value.isFinite, value >= 0 else { return nil }
        return value
    }

    static func count(_ value: Int) -> Int? {
        (0...Int(Int32.max)).contains(value) ? value : nil
    }

    static func decodeSpeed(tokens: Int?, elapsedMs: Double?, ttftMs: Double?) -> Double? {
        guard let tokens, tokens >= 2, let elapsed = duration(elapsedMs),
              let ttft = duration(ttftMs), elapsed > ttft else { return nil }
        return duration(Double(tokens - 1) * 1_000 / (elapsed - ttft))
    }

    static func cpuPercent(previousCPU: Double?, currentCPU: Double?, wallMs: Double) -> Double? {
        guard let previous = duration(previousCPU), let current = duration(currentCPU),
              current >= previous, wallMs.isFinite, wallMs > 0 else { return nil }
        return duration((current - previous) * 100_000 / wallMs)
    }

    /// Export only the app's opaque counter IDs or canonical UUIDs, never arbitrary caller text.
    static func requestId(_ value: String) -> String? {
        guard value.utf8.count <= 128 else { return nil }
        for suffix in [":tree-roots", ":tree-leaves"] where value.hasSuffix(suffix) {
            let base = String(value.dropLast(suffix.count))
            guard !base.contains(":"), let safe = requestId(base) else { return nil }
            return safe + suffix
        }
        if let uuid = UUID(uuidString: value) { return uuid.uuidString.lowercased() }
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "request",
              parts.dropFirst().allSatisfy({ !$0.isEmpty && $0.utf8.allSatisfy { (48...57).contains($0) } }) else {
            return nil
        }
        return value
    }
}

private struct AssistRuntimeGeneration: Sendable {
    let key: String
    let requestId: String?
    var promptTokens: Int?
    var generatedTokens: Int?
    let contextCapacity: Int?
    var elapsedMs: Double?
    var ttftMs: Double?
    var updatedAtMs: Double
    var active = true
    var stoppedElapsedMs: Double?

    var decodeSpeed: Double? {
        AssistRuntimeMetrics.decodeSpeed(tokens: generatedTokens, elapsedMs: elapsedMs, ttftMs: ttftMs)
    }

    func displayedElapsed(at nowMs: Double) -> Double? {
        if let stoppedElapsedMs { return stoppedElapsedMs }
        guard let elapsedMs else { return nil }
        return AssistRuntimeMetrics.duration(elapsedMs + (active ? max(0, nowMs - updatedAtMs) : 0))
    }
}

/// Pure bounded reducer, shared with the Foundation-only checks.
struct AssistRuntimeMonitorState: Sendable {
    static let phases = Set(["idle", "loading", "ready", "generating", "cancelling", "failed", "diagnosing"])
    static let voiceStages = Set(["inactive", "preparing", "pocket", "parakeet", "silero", "session", "audio", "listening", "speaking", "failed"])
    static let codes = Set([
        "MODEL_LOAD_STARTED", "MODEL_LOAD_COMPLETED", "MODEL_LOAD_FAILED", "GENERATION_STARTED",
        "GENERATION_COMPLETED", "GENERATION_CANCELLED", "GENERATION_FAILED", "GENERATION_REJECTED",
        "CANCELLATION_REQUESTED", "CONVERSATION_RESET", "CONVERSATION_RESET_FAILED", "MODEL_UNLOADED",
        "MODEL_UNLOAD_FAILED", "LOAD_PROBE_STARTED", "LOAD_PROBE_COMPLETED", "LOAD_PROBE_FAILED",
        "ASSET_PROBE_STARTED", "ASSET_PROBE_COMPLETED", "ASSET_PROBE_FAILED",
        "SPECIALIZATION_REPAIR_STARTED", "SPECIALIZATION_REPAIR_COMPLETED", "SPECIALIZATION_REPAIR_FAILED",
        "DIAGNOSTIC_STARTED", "DIAGNOSTIC_CASE_PASSED", "DIAGNOSTIC_CASE_FAILED",
        "DIAGNOSTIC_COMPLETED", "DIAGNOSTIC_FAILED", "APP_ACTIVE", "APP_BACKGROUND", "APP_FOREGROUND",
        "APP_INACTIVE", "THERMAL_CHANGED", "MEMORY_PRESSURE_CHANGED", "MONITOR_STARTED", "MONITOR_STOPPED",
        "PHASE_CHANGED", "VOICE_STAGE_CHANGED",
    ]).union(AssistRuntimeToolPass.codes)
        .union(["THOUGHT_TREE_STARTED"] + AssistRuntimeThoughtTreeOutcome.allCases.map(\.code))
    private static let thermalStates = Set(["nominal", "fair", "serious", "critical", "unknown"])
    private static let pressureStates = Set(["normal", "warning", "critical", "unknown"])
    private var phase = "idle"
    private var voiceStage: String?
    private var reading = AssistRuntimeSystemReading()
    private var peakFootprint: UInt64?
    private var cpu: Double?
    private var previousCPU: Double?
    private var lastSampleMs: Double?
    private var lastPressureMs: Double?
    private var pressure = "unknown"
    private var sequence = 0
    private var lastEventMs = 0.0
    private var contextCapacity: Int?
    private var generation: AssistRuntimeGeneration?
    private var thoughtTree: AssistRuntimeThoughtTree?
    private var lastThoughtTreeKey: String?
    private(set) var diagnostic: AssistRuntimeDiagnostic?
    private var diagnosticActive = false
    private(set) var history = AssistRuntimeRing<AssistRuntimeSample>(capacity: 60)
    private(set) var events = AssistRuntimeRing<AssistRuntimeEvent>(capacity: 200)
    private(set) var generations = AssistRuntimeRing<AssistRuntimeGenerationSummary>(capacity: 100)

    func shouldSample(at nowMs: Double) -> Bool {
        guard nowMs.isFinite, nowMs >= 0 else { return false }
        return lastSampleMs.map { nowMs - $0 >= 500 } ?? true
    }

    mutating func sample(_ next: AssistRuntimeSystemReading, at nowMs: Double) {
        guard shouldSample(at: nowMs) else { return }
        cpu = lastSampleMs.flatMap {
            AssistRuntimeMetrics.cpuPercent(previousCPU: previousCPU, currentCPU: next.cumulativeCPUSeconds,
                                             wallMs: nowMs - $0)
        }
        previousCPU = AssistRuntimeMetrics.duration(next.cumulativeCPUSeconds)
        let oldThermal = reading.thermalState
        reading = next
        reading.thermalState = Self.thermalStates.contains(next.thermalState) ? next.thermalState : "unknown"
        if reading.thermalState != oldThermal {
            event(code: "THERMAL_CHANGED", severity: reading.thermalState == "critical" ? "critical" : (reading.thermalState == "serious" ? "warning" : "info"), at: nowMs)
        }
        if let footprint = next.physicalFootprintBytes { peakFootprint = max(peakFootprint ?? 0, footprint) }
        lastSampleMs = nowMs
        history.append(current(at: nowMs))
    }

    func current(at nowMs: Double) -> AssistRuntimeSample {
        AssistRuntimeSample(
            phase: phase, voiceStage: voiceStage, sessionElapsedMs: AssistRuntimeMetrics.duration(nowMs) ?? 0,
            physicalFootprintBytes: reading.physicalFootprintBytes, peakPhysicalFootprintBytes: peakFootprint,
            availableMemoryBytes: reading.availableMemoryBytes, cpuPercent: cpu,
            thermalState: reading.thermalState, memoryPressure: pressure, lowPowerMode: reading.lowPowerMode,
            promptTokens: generation?.promptTokens, generatedTokens: generation?.generatedTokens,
            ttftMs: generation?.ttftMs, decodeTokensPerSecond: generation?.decodeSpeed,
            generationElapsedMs: generation?.displayedElapsed(at: nowMs),
            contextCapacity: contextCapacity, requestId: generation?.requestId
        )
    }

    mutating func event(code: String, severity: String, at nowMs: Double) {
        sequence = min(sequence, Int.max - 1) + 1
        lastEventMs = max(lastEventMs, AssistRuntimeMetrics.duration(nowMs) ?? lastEventMs)
        events.append(AssistRuntimeEvent(
            sequence: sequence, elapsedMs: lastEventMs, observedElapsedMs: AssistRuntimeMetrics.duration(nowMs),
            code: Self.codes.contains(code) ? code : "PHASE_CHANGED",
            severity: ["info", "warning", "critical"].contains(severity) ? severity : "info", phase: phase
        ))
    }

    @discardableResult
    mutating func recordToolPass(passIndex: Int, finishReason: String, stoppedAtToolResponse: Bool,
                                generatedTokens: Int?, at nowMs: Double) -> Bool {
        guard let code = AssistRuntimeToolPass.code(passIndex: passIndex, finishReason: finishReason,
                                                    stoppedAtToolResponse: stoppedAtToolResponse,
                                                    generatedTokens: generatedTokens) else { return false }
        let warning = finishReason == "error" || code.hasSuffix("_EMPTY")
        event(code: code, severity: warning ? "warning" : "info", at: nowMs)
        return true
    }

    mutating func setContextCapacity(_ value: Int?) {
        contextCapacity = value.flatMap { AssistRuntimeMetrics.count($0) }.flatMap { $0 > 0 ? $0 : nil }
    }

    mutating func recordVoiceStage(_ value: String, at nowMs: Double) -> Bool {
        guard Self.voiceStages.contains(value), value != voiceStage else { return false }
        voiceStage = value
        event(code: "VOICE_STAGE_CHANGED", severity: value == "failed" ? "warning" : "info", at: nowMs)
        return true
    }

    mutating func transition(phase next: String, code: String, severity: String, at nowMs: Double) {
        if Self.phases.contains(next) { phase = next }
        if next == "failed" || ["GENERATION_FAILED", "GENERATION_REJECTED"].contains(code), var current = generation, current.active {
            current.stoppedElapsedMs = current.displayedElapsed(at: nowMs)
            current.active = false
            generation = current
        }
        if code == "DIAGNOSTIC_FAILED" { diagnosticActive = false }
        if ["idle", "loading"].contains(next) { generation = nil }
        event(code: code, severity: severity, at: nowMs)
    }

    mutating func memoryPressure(_ next: String, at nowMs: Double) {
        guard Self.pressureStates.contains(next), nowMs.isFinite, nowMs >= 0,
              lastPressureMs.map({ nowMs >= $0 }) ?? true else { return }
        lastPressureMs = nowMs
        if next != pressure {
            pressure = next
            event(code: "MEMORY_PRESSURE_CHANGED", severity: next == "critical" ? "critical" : (next == "warning" ? "warning" : "info"), at: nowMs)
        }
    }

    mutating func thermal(_ next: String, at nowMs: Double) {
        guard Self.thermalStates.contains(next) else { return }
        if next != reading.thermalState {
            reading.thermalState = next
            event(code: "THERMAL_CHANGED", severity: next == "critical" ? "critical" : (next == "serious" ? "warning" : "info"), at: nowMs)
        }
    }

    mutating func beginGeneration(requestId: String, promptTokens: Int, contextCapacity: Int, elapsedMs: Double, at nowMs: Double) {
        guard requestId.utf8.count <= 128 else { return }
        thoughtTree?.beginPass(requestId)
        phase = "generating"
        setContextCapacity(contextCapacity)
        generation = AssistRuntimeGeneration(
            key: requestId, requestId: AssistRuntimeMetrics.requestId(requestId),
            promptTokens: AssistRuntimeMetrics.count(promptTokens), generatedTokens: 0,
            contextCapacity: AssistRuntimeMetrics.count(contextCapacity), elapsedMs: AssistRuntimeMetrics.duration(elapsedMs),
            ttftMs: nil, updatedAtMs: nowMs
        )
        event(code: "GENERATION_STARTED", severity: "info", at: nowMs)
    }

    mutating func progress(requestId: String, promptTokens: Int, generatedTokens: Int, elapsedMs: Double, ttftMs: Double?, at nowMs: Double) {
        guard var current = generation, current.active, current.key == requestId else { return }
        guard let tokens = AssistRuntimeMetrics.count(generatedTokens),
              tokens >= (current.generatedTokens ?? 0), let elapsed = AssistRuntimeMetrics.duration(elapsedMs),
              elapsed >= (current.elapsedMs ?? 0) else { return }
        current.promptTokens = AssistRuntimeMetrics.count(promptTokens)
        current.generatedTokens = tokens
        current.elapsedMs = elapsed
        current.updatedAtMs = nowMs
        if let first = AssistRuntimeMetrics.duration(ttftMs), first <= elapsed { current.ttftMs = first }
        generation = current
    }

    mutating func endGeneration(requestId: String, promptTokens: Int, generatedTokens: Int, elapsedMs: Double, ttftMs: Double?, finishReason: String, at nowMs: Double) {
        guard let previous = generation, previous.active, previous.key == requestId else { return }
        progress(requestId: requestId, promptTokens: promptTokens, generatedTokens: generatedTokens,
                 elapsedMs: elapsedMs, ttftMs: ttftMs, at: nowMs)
        guard var current = generation else { return }
        current.active = false
        generation = current
        let reason = ["eos", "length", "cancelled", "error", "rejected", "interrupted"].contains(finishReason) ? finishReason : "unknown"
        phase = ["error", "rejected"].contains(reason) ? "failed" : "ready"
        let summary = AssistRuntimeGenerationSummary(
            requestId: current.requestId, promptTokens: current.promptTokens, generatedTokens: current.generatedTokens,
            ttftMs: current.ttftMs, decodeTokensPerSecond: current.decodeSpeed, generationElapsedMs: current.elapsedMs,
            contextCapacity: current.contextCapacity, finishReason: reason
        )
        generations.append(summary)
        thoughtTree?.endPass(requestId, summary: summary,
                             measured: AssistRuntimeMetrics.count(promptTokens) != nil &&
                                AssistRuntimeMetrics.count(generatedTokens) != nil &&
                                AssistRuntimeMetrics.duration(elapsedMs) != nil &&
                                current.promptTokens == promptTokens && current.generatedTokens == generatedTokens &&
                                current.elapsedMs == elapsedMs)
        event(code: reason == "cancelled" ? "GENERATION_CANCELLED" : (reason == "error" ? "GENERATION_FAILED" : "GENERATION_COMPLETED"),
              severity: reason == "error" ? "warning" : "info", at: nowMs)
    }

    @discardableResult
    mutating func recordThoughtTreeStart(requestId: String, at nowMs: Double) -> Bool {
        guard thoughtTree == nil, requestId != lastThoughtTreeKey,
              !requestId.contains(":"), let safe = AssistRuntimeMetrics.requestId(requestId),
              AssistRuntimeMetrics.duration(nowMs) != nil else { return false }
        thoughtTree = AssistRuntimeThoughtTree(key: requestId, requestId: safe, startedAtMs: nowMs)
        event(code: "THOUGHT_TREE_STARTED", severity: "info", at: nowMs)
        return true
    }

    @discardableResult
    mutating func recordThoughtTreeEnd(requestId: String, outcome: AssistRuntimeThoughtTreeOutcome,
                                      at nowMs: Double) -> Bool {
        guard let tree = thoughtTree, tree.key == requestId,
              let now = AssistRuntimeMetrics.duration(nowMs), now >= tree.startedAtMs else { return false }
        thoughtTree = nil
        lastThoughtTreeKey = requestId
        // Incomplete telemetry cannot establish readiness. Retire its identity
        // without inventing either a successful or rejected controller result.
        guard outcome != .ready || tree.completeEOS else { return false }
        generations.append(AssistRuntimeGenerationSummary(
            requestId: tree.requestId, promptTokens: tree.total(\.promptTokens),
            generatedTokens: tree.total(\.generatedTokens), ttftMs: nil, decodeTokensPerSecond: nil,
            generationElapsedMs: now - tree.startedAtMs, contextCapacity: nil,
            finishReason: outcome.finishReason
        ))
        event(code: outcome.code, severity: [.rejected, .error].contains(outcome) ? "warning" : "info", at: now)
        return true
    }

    mutating func beginDiagnostic(total: Int, at nowMs: Double) {
        guard (1...512).contains(total) else { return }
        generation = nil
        phase = "diagnosing"
        diagnostic = AssistRuntimeDiagnostic(total: total)
        diagnosticActive = true
        event(code: "DIAGNOSTIC_STARTED", severity: "info", at: nowMs)
    }

    mutating func diagnosticCase(passed: Bool, at nowMs: Double) {
        guard diagnosticActive, var current = diagnostic, current.completed < current.total else { return }
        current.completed += 1
        if !passed { current.failed += 1 }
        diagnostic = current
        event(code: passed ? "DIAGNOSTIC_CASE_PASSED" : "DIAGNOSTIC_CASE_FAILED",
              severity: passed ? "info" : "warning", at: nowMs)
    }

    mutating func endDiagnostic(phase restoredPhase: String = "idle", at nowMs: Double) {
        guard diagnosticActive else { return }
        diagnosticActive = false
        phase = Self.phases.contains(restoredPhase) ? restoredPhase : "idle"
        let complete = diagnostic.map { $0.completed == $0.total } ?? false
        event(code: complete ? "DIAGNOSTIC_COMPLETED" : "DIAGNOSTIC_FAILED",
              severity: complete && diagnostic?.failed == 0 ? "info" : "warning", at: nowMs)
    }
}

private struct AssistRuntimePersistence: Codable, Sendable {
    var status = "notAttempted"
    var lastSuccessfulCheckpointAt: Date?
}

private struct AssistRuntimeReport: Codable, Sendable {
    let schemaVersion = 1
    let kind = "assistRuntimeMonitoring"
    let aneExecution = "unverified"
    let nativeBuild: String
    let osVersion: String
    let sessionId: String
    let sessionStartedAt: Date
    let capturedAt: Date
    var persistence: AssistRuntimePersistence
    let measurementMethods = [
        "physicalFootprintBytes": "task_info TASK_VM_INFO.phys_footprint; current process; unknown on syscall failure",
        "peakPhysicalFootprintBytes": "maximum of monitor samples; transient and unsampled load peaks may be missed",
        "availableMemoryBytes": "os_proc_available_memory; remaining per-app allocation budget, not free device RAM",
        "cpuPercent": "delta getrusage(RUSAGE_SELF) user+system CPU seconds / delta ContinuousClock wall time; 100% equals one CPU core; unavailable on first/failed sample",
        "thermalState": "ProcessInfo.thermalState categorical observation; no temperature estimate",
        "memoryPressure": "DispatchSource normal/warning/critical events; unknown until an event is observed",
        "lowPowerMode": "ProcessInfo.isLowPowerModeEnabled",
        "decodeTokensPerSecond": "generation average (native generatedTokens - 1) / (native elapsedMs - TTFT); requires >=2 tokens and positive duration; held between native count updates, not a rolling window or character/event rate",
        "generationElapsedMs": "native generation duration, advanced between progress callbacks with ContinuousClock while active; failure transitions freeze the display without inventing token counts; final summaries use native end duration",
        "sampling": "native foreground sampler targets one second independently of JS; syscalls at most once per 500 ms; exports do not append history; history 60 samples, events 200, generations 100; scheduler delays may miss peaks",
        "persistence": "best-effort atomic local checkpoint at most every five seconds while sampling, plus rate-limited stage, pressure and lifecycle checkpoints; two sessions, each <=128 KiB; not a crash handler; abrupt termination may lose observations after the last successful checkpoint",
        "events": "bounded constant codes; observedElapsedMs preserves source ContinuousClock time, elapsedMs is monotonic delivery order; stale lifecycle observations cannot replace a newer foreground state",
        "toolPasses": "TOOL_PASS_0...4 constant events distinguish native pass index, EOS with zero accepted tokens, token-50 tool boundary, length, cancellation and error before output validation; token counts remain in generation summaries; no prompt, arguments, text, arbitrary token IDs or cache contents; EOS_EMPTY alone does not identify a model, protocol or cache cause",
        "thoughtTree": "THOUGHT_TREE_STARTED/READY/REJECTED/CANCELLED/ERROR mark private preparation only; tree_roots/leaves generation IDs use fixed :tree-roots/:tree-leaves suffixes; tree_ready/rejected/cancelled/error summaries reuse the external request ID and sum only measured completed preparation passes; counts are absent if any started pass is unmeasured; generationElapsedMs is native wall time from preparation start through selection/rejection/drained cancellation, not total user turn latency; TTFT, decode speed and context capacity are absent on aggregates; ready requires two measured EOS summaries plus caller validation, not proof of an executed action or answer quality",
        "acceleratorUtilization": "GPU/ANE utilization and actual execution placement are not measured",
        "coreMLPredictions": "latest observed asynchronous operation per allowlisted component, not every in-flight operation; voiceTurn counts observed transitions to voice preparing, not conversation turns; native observer is awaited before submission; first begin per component after observed voice preparing requests an immediate best-effort atomic checkpoint (at most six), later successes use periodic checkpoints and failures are rate limited; metadata only, no tensor values; not an NSException handler; an older checkpoint does not prove the crashing component",
    ]
    let current: AssistRuntimeSample
    var history: [AssistRuntimeSample]
    var events: [AssistRuntimeEvent]
    let diagnostic: AssistRuntimeDiagnostic?
    var generations: [AssistRuntimeGenerationSummary]
    let coreMLPredictions: [AssistRuntimePrediction]

    enum CodingKeys: String, CodingKey {
        case schemaVersion, kind, aneExecution, nativeBuild, osVersion, sessionId, sessionStartedAt, capturedAt, persistence
        case measurementMethods, current, history, events, diagnostic, generations, coreMLPredictions
    }

    func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(schemaVersion, forKey: .schemaVersion)
        try values.encode(kind, forKey: .kind)
        try values.encode(aneExecution, forKey: .aneExecution)
        try values.encode(nativeBuild, forKey: .nativeBuild)
        try values.encode(osVersion, forKey: .osVersion)
        try values.encode(sessionId, forKey: .sessionId)
        try values.encode(sessionStartedAt, forKey: .sessionStartedAt)
        try values.encode(capturedAt, forKey: .capturedAt)
        try values.encode(persistence, forKey: .persistence)
        try values.encode(measurementMethods, forKey: .measurementMethods)
        try values.encode(current, forKey: .current)
        try values.encode(history, forKey: .history)
        try values.encode(events, forKey: .events)
        try values.encode(diagnostic, forKey: .diagnostic)
        try values.encode(generations, forKey: .generations)
        try values.encode(coreMLPredictions, forKey: .coreMLPredictions)
    }

    init(nativeBuild: String, osVersion: String, sessionId: String, sessionStartedAt: Date, capturedAt: Date,
         persistence: AssistRuntimePersistence, current: AssistRuntimeSample, history: [AssistRuntimeSample],
         events: [AssistRuntimeEvent], diagnostic: AssistRuntimeDiagnostic?, generations: [AssistRuntimeGenerationSummary],
         coreMLPredictions: [AssistRuntimePrediction] = []) {
        self.nativeBuild = nativeBuild; self.osVersion = osVersion; self.sessionId = sessionId
        self.sessionStartedAt = sessionStartedAt; self.capturedAt = capturedAt; self.persistence = persistence
        self.current = current; self.history = history; self.events = events
        self.diagnostic = diagnostic; self.generations = generations
        self.coreMLPredictions = coreMLPredictions
    }

    init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard try values.decode(Int.self, forKey: .schemaVersion) == 1,
              try values.decode(String.self, forKey: .kind) == "assistRuntimeMonitoring" else {
            throw AssistRuntimeArchive.error()
        }
        nativeBuild = try values.decode(String.self, forKey: .nativeBuild)
        osVersion = try values.decode(String.self, forKey: .osVersion)
        sessionId = try values.decode(String.self, forKey: .sessionId)
        sessionStartedAt = try values.decode(Date.self, forKey: .sessionStartedAt)
        capturedAt = try values.decode(Date.self, forKey: .capturedAt)
        persistence = try values.decode(AssistRuntimePersistence.self, forKey: .persistence)
        current = try values.decode(AssistRuntimeSample.self, forKey: .current)
        history = try values.decode([AssistRuntimeSample].self, forKey: .history)
        events = try values.decode([AssistRuntimeEvent].self, forKey: .events)
        diagnostic = try values.decodeIfPresent(AssistRuntimeDiagnostic.self, forKey: .diagnostic)
        generations = try values.decode([AssistRuntimeGenerationSummary].self, forKey: .generations)
        coreMLPredictions = try values.decodeIfPresent([AssistRuntimePrediction].self, forKey: .coreMLPredictions) ?? []
        guard UUID(uuidString: sessionId) != nil, nativeBuild.count <= 64, osVersion.count <= 256,
              !nativeBuild.contains("/"), !osVersion.contains("/"), history.count <= 60, events.count <= 200,
              generations.count <= 100, coreMLPredictions.count <= 6, coreMLPredictions.allSatisfy(\.isValid),
              Set(coreMLPredictions.map(\.component)).count == coreMLPredictions.count,
              ["notAttempted", "saved", "unavailable"].contains(persistence.status),
              ([current] + history).allSatisfy({ sample in
                  AssistRuntimeMonitorState.phases.contains(sample.phase) &&
                  sample.voiceStage.map(AssistRuntimeMonitorState.voiceStages.contains) != false &&
                  ["nominal", "fair", "serious", "critical", "unknown"].contains(sample.thermalState) &&
                  ["normal", "warning", "critical", "unknown"].contains(sample.memoryPressure) &&
                  sample.requestId.map({ AssistRuntimeMetrics.requestId($0) == $0 }) != false &&
                  sample.sessionElapsedMs.isFinite && sample.sessionElapsedMs >= 0
              }), events.allSatisfy({
                  AssistRuntimeMonitorState.codes.contains($0.code) && AssistRuntimeMonitorState.phases.contains($0.phase) &&
                  ["info", "warning", "critical"].contains($0.severity) && $0.sequence >= 0 && $0.elapsedMs >= 0
              }), generations.allSatisfy({
                  $0.requestId.map({ AssistRuntimeMetrics.requestId($0) == $0 }) != false &&
                  (Set(["eos", "length", "cancelled", "error", "rejected", "interrupted", "unknown"])
                    .union(AssistRuntimeThoughtTreeOutcome.allCases.map(\.finishReason))).contains($0.finishReason)
              }) else { throw AssistRuntimeArchive.error() }
    }

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(self)
    }

    func boundedData() throws -> Data {
        var report = self
        var data = try report.encoded()
        while data.count > AssistRuntimeArchive.maximumBytes {
            if !report.generations.isEmpty { report.generations.removeFirst() }
            else if !report.events.isEmpty { report.events.removeFirst() }
            else if !report.history.isEmpty { report.history.removeFirst() }
            else { throw AssistRuntimeArchive.error() }
            data = try report.encoded()
        }
        return data
    }
}

/// Actor-owned, fixed-name two-session storage. Reads are capped before allocating;
/// only typed, allowlisted reports are re-encoded for export. No device content is saved.
struct AssistRuntimeArchive: Sendable {
    static let maximumBytes = 128 * 1_024
    let directory: URL
    private(set) var rotated = false

    static func error() -> NSError {
        NSError(domain: "Assist.RuntimeMonitor", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Le diagnostic local précédent est indisponible."])
    }

    private func read(_ name: String) throws -> Data? {
        let file = directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue > 0,
              size.intValue <= Self.maximumBytes else { return nil }
        let data = try Data(contentsOf: file)
        guard data.count <= Self.maximumBytes else { return nil }
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        guard let report = try? decoder.decode(AssistRuntimeReport.self, from: data) else { return nil }
        return try report.boundedData()
    }

    mutating func prepare() throws {
        guard !rotated else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw Self.error() }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        #if canImport(Darwin)
        var resourceValues = URLResourceValues(); resourceValues.isExcludedFromBackup = true
        var protectedDirectory = directory
        try protectedDirectory.setResourceValues(resourceValues)
        #endif
        #if canImport(UIKit)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                             ofItemAtPath: directory.path)
        #endif
        // Do not overwrite a valid previous report with a corrupt/truncated current.
        if let data = try read("current.json") { try write(data, name: "previous.json") }
        rotated = true
    }

    mutating func checkpoint(_ data: Data) throws {
        try prepare()
        try write(data, name: "current.json")
    }

    func previousJSON() throws -> String {
        guard let data = try read("previous.json") else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }

    private func write(_ data: Data, name: String) throws {
        guard data.count <= Self.maximumBytes else { throw Self.error() }
        let file = directory.appendingPathComponent(name)
        #if canImport(UIKit)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        #if canImport(Darwin)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var protectedFile = file; try protectedFile.setResourceValues(values)
        #endif
    }
}

/// Owned only by the monitor actor. Closures capture the monitor weakly, never
/// this bag; releasing the actor also unregisters notifications/dispatch sources.
private final class AssistRuntimeObservationBag {
    var tokens: [any NSObjectProtocol] = []
    #if canImport(Darwin)
    var memorySources: [any DispatchSourceMemoryPressure] = []
    #endif
    func stop() {
        for token in tokens { NotificationCenter.default.removeObserver(token) }
        tokens.removeAll()
        #if canImport(Darwin)
        for source in memorySources { source.cancel() }
        memorySources.removeAll()
        #endif
    }
    deinit { stop() }
}

/// Independent of JS and the busy inference actor. No method starts or changes model work.
actor AssistRuntimeMonitor {
    private let started: ContinuousClock.Instant
    private let clock: @Sendable () -> ContinuousClock.Instant
    private let startedDate = Date()
    private let sessionId = UUID().uuidString.lowercased()
    private var state = AssistRuntimeMonitorState()
    private var registered = false
    private var stoppedAtMs: Double?
    private let observations = AssistRuntimeObservationBag()
    private var lifecycleSetup: Task<Void, Never>?
    private var sampler: Task<Void, Never>?
    private var foreground = true
    private var lastLifecycleObserved: ContinuousClock.Instant?
    private let sampleInterval: Duration
    private let checkpointIntervalMs: Double
    private var lastCheckpointAttemptMs: Double?
    private var pendingCheckpoint = false
    private var persistence = AssistRuntimePersistence()
    private var archive: AssistRuntimeArchive
    private var predictionVoiceTurn = 0
    private var predictionFirstBegins = Set<String>()
    private var predictions: [String: AssistRuntimePrediction] = [:]

    init(directory: URL? = nil, sampleInterval: Duration = .seconds(1), checkpointInterval: Duration = .seconds(5),
         clock: @escaping @Sendable () -> ContinuousClock.Instant = { ContinuousClock.now }) {
        self.clock = clock
        started = clock()
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        archive = AssistRuntimeArchive(directory: directory ?? support.appendingPathComponent("AssistDiagnostics/RuntimeMonitoring", isDirectory: true))
        self.sampleInterval = max(.milliseconds(20), sampleInterval)
        checkpointIntervalMs = min(5_000, max(100, AssistRuntimeMetrics.milliseconds(checkpointInterval)))
    }

    deinit {
        sampler?.cancel()
        lifecycleSetup?.cancel()
    }

    /// Called by native ownership, without waiting for a JS snapshot. Idempotent
    /// for the monitor lifetime, including rotation before the first export.
    func start() {
        startObservingIfNeeded()
    }

    func snapshotJSON() throws -> String {
        startObservingIfNeeded()
        let now = stoppedAtMs ?? elapsed()
        return String(decoding: try report(at: now).boundedData(), as: UTF8.self)
    }

    func previousSnapshotJSON() throws -> String {
        startObservingIfNeeded()
        do { return try archive.previousJSON() }
        catch { throw AssistRuntimeArchive.error() }
    }

    func recordVoiceStage(_ value: String) {
        guard running(), state.recordVoiceStage(value, at: elapsed()) else { return }
        if value == "preparing" {
            predictionVoiceTurn = min(Int(Int32.max), predictionVoiceTurn + 1)
            predictionFirstBegins.removeAll(keepingCapacity: true)
        }
        checkpointEvent()
    }

    /// Awaited by the SDK before async prediction submission. Disk failure is
    /// contained here and must never suppress inference or claim recovery.
    func recordCoreMLPrediction(id: String, component: String, state operationState: String, computeUnits: String,
                               inputs: [AssistRuntimePredictionTensor], inputFeatureCount: Int, metadataTruncated: Bool) {
        guard running() else { return }
        let now = elapsed()
        let operationTurn = operationState == "began" ? predictionVoiceTurn : (predictions[component]?.voiceTurn ?? predictionVoiceTurn)
        let value = AssistRuntimePrediction(id: id.lowercased(), component: component, state: operationState,
                                           computeUnits: computeUnits, inputs: inputs, inputFeatureCount: inputFeatureCount,
                                           metadataTruncated: metadataTruncated, voiceTurn: operationTurn,
                                           observedElapsedMs: now)
        guard value.isValid else { return }
        if operationState != "began", predictions[component]?.id != value.id { return }
        predictions[component] = value
        if operationState == "began", predictionFirstBegins.insert(component).inserted {
            checkpoint(at: now)
        } else if operationState == "failed" {
            checkpointEvent()
        }
        // No per-frame event or pendingCheckpoint flag: repeated successful
        // Flow/Mimi submissions use only the existing periodic checkpoint.
    }

    private func report(at now: Double, persistence override: AssistRuntimePersistence? = nil) -> AssistRuntimeReport {
        AssistRuntimeReport(
            nativeBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
            osVersion: Self.osVersion(),
            sessionId: sessionId, sessionStartedAt: startedDate,
            capturedAt: startedDate.addingTimeInterval(now / 1_000), persistence: override ?? persistence,
            current: state.current(at: now), history: state.history.values, events: state.events.values,
            diagnostic: state.diagnostic, generations: state.generations.values,
            coreMLPredictions: predictions.values.sorted { $0.component < $1.component }
        )
    }

    func transition(phase: String, code: String, severity: String = "info") {
        guard running() else { return }
        state.transition(phase: phase, code: code, severity: severity, at: elapsed())
        checkpointEvent()
    }

    func setContextCapacity(_ value: Int?) {
        guard running() else { return }
        state.setContextCapacity(value)
    }

    func beginGeneration(requestId: String, promptTokens: Int, contextCapacity: Int, elapsedMs: Double) {
        guard running() else { return }
        state.beginGeneration(requestId: requestId, promptTokens: promptTokens, contextCapacity: contextCapacity,
                              elapsedMs: elapsedMs, at: elapsed())
        checkpointEvent()
    }

    func progress(requestId: String, promptTokens: Int, generatedTokens: Int, elapsedMs: Double, ttftMs: Double?) {
        guard running() else { return }
        state.progress(requestId: requestId, promptTokens: promptTokens, generatedTokens: generatedTokens,
                       elapsedMs: elapsedMs, ttftMs: ttftMs, at: elapsed())
    }

    func endGeneration(requestId: String, promptTokens: Int, generatedTokens: Int, elapsedMs: Double, ttftMs: Double?, finishReason: String) {
        guard running() else { return }
        state.endGeneration(requestId: requestId, promptTokens: promptTokens, generatedTokens: generatedTokens,
                            elapsedMs: elapsedMs, ttftMs: ttftMs, finishReason: finishReason, at: elapsed())
        checkpointEvent()
    }

    /// Await before parsing a completed tool turn, including empty EOS. This
    /// observes an outcome only; it cannot reset, retry or change the engine.
    func recordToolPass(passIndex: Int, finishReason: String, stoppedAtToolResponse: Bool = false,
                        generatedTokens: Int? = nil) {
        guard running(), state.recordToolPass(passIndex: passIndex, finishReason: finishReason,
                                              stoppedAtToolResponse: stoppedAtToolResponse,
                                              generatedTokens: generatedTokens, at: elapsed()) else { return }
        checkpointEvent()
    }

    /// This timer is separate from individual model generations and does not
    /// change admission, phase, active generation metrics or public progress.
    func recordThoughtTreeStart(requestId: String) {
        guard running(), state.recordThoughtTreeStart(requestId: requestId, at: elapsed()) else { return }
        checkpointEvent()
    }

    /// Await after controller validation, or after cancellation has drained.
    /// No branch content, model output, raw error or user-visible TTFT is taken.
    func recordThoughtTreeEnd(requestId: String, outcome: AssistRuntimeThoughtTreeOutcome) {
        guard running(), state.recordThoughtTreeEnd(requestId: requestId, outcome: outcome,
                                                   at: elapsed()) else { return }
        checkpointEvent()
    }

    func beginDiagnostic(total: Int) {
        guard running() else { return }
        state.beginDiagnostic(total: total, at: elapsed())
        checkpointEvent()
    }

    func diagnosticCase(variant _: String, mode _: String, function _: String, passed: Bool) {
        guard running() else { return }
        state.diagnosticCase(passed: passed, at: elapsed())
        if !passed { checkpointEvent() }
    }

    func endDiagnostic(phase: String = "idle") {
        guard running() else { return }
        state.endDiagnostic(phase: phase, at: elapsed())
        checkpointEvent()
    }

    /// Terminal and idempotent: later transitions/progress cannot register observers again.
    func shutdown() {
        guard stoppedAtMs == nil else { return }
        let now = elapsed()
        state.event(code: "MONITOR_STOPPED", severity: "info", at: now)
        stoppedAtMs = now
        sampler?.cancel()
        sampler = nil
        checkpoint(at: now)
        lifecycleSetup?.cancel()
        lifecycleSetup = nil
        observations.stop()
    }

    private func elapsed(_ observed: ContinuousClock.Instant? = nil) -> Double {
        AssistRuntimeMetrics.milliseconds(started.duration(to: observed ?? clock()))
    }

    private func running() -> Bool {
        guard stoppedAtMs == nil else { return false }
        startObservingIfNeeded()
        return true
    }

    private func resumeSampler() {
        guard sampler == nil, foreground, stoppedAtMs == nil else { return }
        let interval = sampleInterval
        // Keep only a weak reference across sleep. A stored loop that unwraps
        // self before sleeping would prevent the actor and observers deallocating.
        sampler = Task(priority: .utility) { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: interval) } catch { return }
                guard !Task.isCancelled, await self?.sampleIfForeground() == true else { return }
            }
        }
    }

    private func sampleIfForeground() -> Bool {
        guard stoppedAtMs == nil, foreground else { return false }
        let now = elapsed()
        if state.shouldSample(at: now) { state.sample(Self.readSystem(), at: now) }
        let since = now - (lastCheckpointAttemptMs ?? -checkpointIntervalMs)
        if since >= checkpointIntervalMs || (pendingCheckpoint && since >= min(1_000, checkpointIntervalMs)) {
            checkpoint(at: now)
        }
        return true
    }

    private func checkpointEvent() {
        let now = elapsed()
        pendingCheckpoint = true
        // Event records never force extra system calls inside the 500 ms floor.
        if foreground, state.shouldSample(at: now) { state.sample(Self.readSystem(), at: now) }
        if now - (lastCheckpointAttemptMs ?? -1_000) >= min(1_000, checkpointIntervalMs) {
            checkpoint(at: now)
        }
    }

    private func checkpoint(at now: Double) {
        lastCheckpointAttemptMs = now
        pendingCheckpoint = false
        var saved = persistence
        saved.status = "saved"
        saved.lastSuccessfulCheckpointAt = startedDate.addingTimeInterval(now / 1_000)
        do {
            let data = try report(at: now, persistence: saved).boundedData()
            try archive.checkpoint(data)
            persistence = saved
        } catch {
            // Do not record paths or a framework's raw error, and do not claim
            // persistence worked. Sampling/inference continue; retries are bounded.
            persistence.status = "unavailable"
        }
    }

    private func startObservingIfNeeded() {
        guard !registered, stoppedAtMs == nil else { return }
        registered = true
        state.event(code: "MONITOR_STARTED", severity: "info", at: elapsed())
        state.sample(Self.readSystem(), at: elapsed())
        checkpoint(at: elapsed())
        resumeSampler()
        #if canImport(Darwin)
        let thermal = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil
        ) { [weak self] _ in
            let observed = ContinuousClock.now
            Task { [weak self] in await self?.thermalChanged(observed: observed) }
        }
        observations.tokens.append(thermal)
        // One event kind per source avoids retaining a DispatchSource in its own handler.
        let queue = DispatchQueue(label: "org.27pm.assist.runtime-monitor", qos: .utility)
        let pressureEvents: [(DispatchSource.MemoryPressureEvent, String)] = [
            (.normal, "normal"), (.warning, "warning"), (.critical, "critical"),
        ]
        for (mask, level) in pressureEvents {
            let source = DispatchSource.makeMemoryPressureSource(eventMask: mask, queue: queue)
            source.setEventHandler { [weak self] in
                let observed = ContinuousClock.now
                Task { [weak self] in await self?.memoryPressureChanged(level, observed: observed) }
            }
            source.activate()
            observations.memorySources.append(source)
        }
        #endif
        #if canImport(UIKit)
        lifecycleSetup = Task { [weak self] in
            let names = await Self.lifecycleNames()
            guard !Task.isCancelled else { return }
            await self?.registerLifecycle(names)
            guard !Task.isCancelled else { return }
            // Register first, then observe the current state on MainActor. A
            // transition before registration is covered by this snapshot; one
            // after registration is also notified. Timestamp ordering prevents
            // a delayed snapshot/callback overwriting a more recent event.
            let (isForeground, observed) = await Self.lifecycleState()
            guard !Task.isCancelled else { return }
            await self?.initialLifecycleState(foreground: isForeground, observed: observed)
        }
        #endif
    }

    #if canImport(UIKit)
    @MainActor
    private static func lifecycleNames() -> [(Notification.Name, String)] {
        [
            (UIApplication.didBecomeActiveNotification, "APP_ACTIVE"),
            (UIApplication.didEnterBackgroundNotification, "APP_BACKGROUND"),
            (UIApplication.willEnterForegroundNotification, "APP_FOREGROUND"),
            (UIApplication.willResignActiveNotification, "APP_INACTIVE"),
        ]
    }

    @MainActor
    private static func lifecycleState() -> (Bool, ContinuousClock.Instant) {
        (UIApplication.shared.applicationState != .background, ContinuousClock.now)
    }

    private func registerLifecycle(_ names: [(Notification.Name, String)]) {
        guard stoppedAtMs == nil else { return }
        for (name, code) in names {
            let observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                let observed = ContinuousClock.now
                Task { [weak self] in await self?.recordLifecycle(code, observed: observed) }
            }
            observations.tokens.append(observer)
        }
    }
    #endif

    private func initialLifecycleState(foreground value: Bool, observed: ContinuousClock.Instant) {
        guard stoppedAtMs == nil, lastLifecycleObserved.map({ observed >= $0 }) ?? true else { return }
        lastLifecycleObserved = observed
        foreground = value
        if foreground { resumeSampler() }
        else { sampler?.cancel(); sampler = nil; checkpoint(at: elapsed()) }
        lifecycleSetup = nil
    }

    func recordLifecycle(_ code: String, observed: ContinuousClock.Instant = ContinuousClock.now) {
        guard stoppedAtMs == nil, ["APP_ACTIVE", "APP_BACKGROUND", "APP_FOREGROUND", "APP_INACTIVE"].contains(code) else { return }
        state.event(code: code, severity: "info", at: elapsed(observed))
        guard lastLifecycleObserved.map({ observed >= $0 }) ?? true else { checkpointEvent(); return }
        lastLifecycleObserved = observed
        if code == "APP_BACKGROUND" {
            foreground = false
            sampler?.cancel(); sampler = nil
            checkpoint(at: elapsed())
        } else if code == "APP_ACTIVE" || code == "APP_FOREGROUND" {
            foreground = true
            resumeSampler()
            checkpointEvent()
        } else { checkpointEvent() }
    }

    func memoryPressureChanged(_ level: String, observed: ContinuousClock.Instant = ContinuousClock.now) {
        guard stoppedAtMs == nil else { return }
        state.memoryPressure(level, at: elapsed(observed))
        checkpointEvent()
    }

    private func thermalChanged(observed: ContinuousClock.Instant) {
        guard stoppedAtMs == nil else { return }
        state.thermal(Self.thermalState(), at: elapsed(observed))
        checkpointEvent()
    }

    private static func thermalState() -> String {
        #if canImport(Darwin)
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
        #else
        return "unknown"
        #endif
    }

    private static func osVersion() -> String {
        #if canImport(Darwin)
        // Preserve the iOS build identifier, including beta releases, for
        // correlation with the operating system's termination reports.
        return ProcessInfo.processInfo.operatingSystemVersionString
        #else
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
        #endif
    }

    private static func readSystem() -> AssistRuntimeSystemReading {
        #if canImport(Darwin)
        var usage = rusage()
        let cpu: Double?
        if getrusage(RUSAGE_SELF, &usage) == 0 {
            cpu = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1e6
                + Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1e6
        } else { cpu = nil }
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        #if os(iOS) || os(tvOS) || os(watchOS) || os(visionOS)
        let availableMemory = UInt64(os_proc_available_memory())
        #else
        let availableMemory: UInt64? = nil
        #endif
        return AssistRuntimeSystemReading(
            physicalFootprintBytes: result == KERN_SUCCESS ? info.phys_footprint : nil,
            availableMemoryBytes: availableMemory, cumulativeCPUSeconds: cpu,
            thermalState: thermalState(), lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled
        )
        #else
        return AssistRuntimeSystemReading()
        #endif
    }
}
