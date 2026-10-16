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

struct AssistRuntimeSample: Encodable, Sendable {
    let phase: String
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

struct AssistRuntimeEvent: Encodable, Sendable {
    let sequence: Int
    let elapsedMs: Double
    let code: String
    let severity: String
    let phase: String
}

struct AssistRuntimeDiagnostic: Encodable, Sendable {
    var completed = 0
    let total: Int
    var failed = 0
}

struct AssistRuntimeGenerationSummary: Encodable, Sendable {
    let requestId: String?
    let promptTokens: Int?
    let generatedTokens: Int?
    let ttftMs: Double?
    let decodeTokensPerSecond: Double?
    let generationElapsedMs: Double?
    let contextCapacity: Int?
    let finishReason: String
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
    private static let phases = Set(["idle", "loading", "ready", "generating", "cancelling", "failed", "diagnosing"])
    private static let codes = Set([
        "MODEL_LOAD_STARTED", "MODEL_LOAD_COMPLETED", "MODEL_LOAD_FAILED", "GENERATION_STARTED",
        "GENERATION_COMPLETED", "GENERATION_CANCELLED", "GENERATION_FAILED", "GENERATION_REJECTED",
        "CANCELLATION_REQUESTED", "CONVERSATION_RESET", "CONVERSATION_RESET_FAILED", "MODEL_UNLOADED",
        "MODEL_UNLOAD_FAILED", "DIAGNOSTIC_STARTED", "DIAGNOSTIC_CASE_PASSED", "DIAGNOSTIC_CASE_FAILED",
        "DIAGNOSTIC_COMPLETED", "DIAGNOSTIC_FAILED", "APP_ACTIVE", "APP_BACKGROUND", "APP_FOREGROUND",
        "APP_INACTIVE", "THERMAL_CHANGED", "MEMORY_PRESSURE_CHANGED", "MONITOR_STARTED", "MONITOR_STOPPED",
        "PHASE_CHANGED",
    ])
    private static let thermalStates = Set(["nominal", "fair", "serious", "critical", "unknown"])
    private static let pressureStates = Set(["normal", "warning", "critical", "unknown"])
    private var phase = "idle"
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
            phase: phase, sessionElapsedMs: AssistRuntimeMetrics.duration(nowMs) ?? 0,
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
            sequence: sequence, elapsedMs: lastEventMs,
            code: Self.codes.contains(code) ? code : "PHASE_CHANGED",
            severity: ["info", "warning", "critical"].contains(severity) ? severity : "info", phase: phase
        ))
    }

    mutating func setContextCapacity(_ value: Int?) {
        contextCapacity = value.flatMap { AssistRuntimeMetrics.count($0) }.flatMap { $0 > 0 ? $0 : nil }
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
        generations.append(AssistRuntimeGenerationSummary(
            requestId: current.requestId, promptTokens: current.promptTokens, generatedTokens: current.generatedTokens,
            ttftMs: current.ttftMs, decodeTokensPerSecond: current.decodeSpeed, generationElapsedMs: current.elapsedMs,
            contextCapacity: current.contextCapacity, finishReason: reason
        ))
        event(code: reason == "cancelled" ? "GENERATION_CANCELLED" : (reason == "error" ? "GENERATION_FAILED" : "GENERATION_COMPLETED"),
              severity: reason == "error" ? "warning" : "info", at: nowMs)
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

private struct AssistRuntimeReport: Encodable, Sendable {
    let schemaVersion = 1
    let kind = "assistRuntimeMonitoring"
    let aneExecution = "unverified"
    let nativeBuild: String
    let osVersion: String
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
        "sampling": "foreground JS requests snapshots; syscalls at most once per 500 ms; no native periodic timer; history 60 samples, events 200, generations 100",
        "events": "bounded constant codes with ContinuousClock elapsed times; late callback delivery cannot move event times backwards",
        "acceleratorUtilization": "GPU/ANE utilization and actual execution placement are not measured",
    ]
    let current: AssistRuntimeSample
    let history: [AssistRuntimeSample]
    let events: [AssistRuntimeEvent]
    let diagnostic: AssistRuntimeDiagnostic?
    let generations: [AssistRuntimeGenerationSummary]

    enum CodingKeys: String, CodingKey {
        case schemaVersion, kind, aneExecution, nativeBuild, osVersion, measurementMethods, current, history, events, diagnostic, generations
    }

    func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(schemaVersion, forKey: .schemaVersion)
        try values.encode(kind, forKey: .kind)
        try values.encode(aneExecution, forKey: .aneExecution)
        try values.encode(nativeBuild, forKey: .nativeBuild)
        try values.encode(osVersion, forKey: .osVersion)
        try values.encode(measurementMethods, forKey: .measurementMethods)
        try values.encode(current, forKey: .current)
        try values.encode(history, forKey: .history)
        try values.encode(events, forKey: .events)
        try values.encode(diagnostic, forKey: .diagnostic)
        try values.encode(generations, forKey: .generations)
    }
}

/// Independent of the busy inference actor. No method starts or changes model work.
actor AssistRuntimeMonitor {
    private let started = ContinuousClock.now
    private var state = AssistRuntimeMonitorState()
    private var registered = false
    private var stoppedAtMs: Double?
    private var observers: [any NSObjectProtocol] = []
    private var lifecycleSetup: Task<Void, Never>?
    #if canImport(Darwin)
    private var memorySources: [any DispatchSourceMemoryPressure] = []
    #endif

    func snapshotJSON() throws -> String {
        startObservingIfNeeded()
        let now = stoppedAtMs ?? elapsed()
        if stoppedAtMs == nil, state.shouldSample(at: now) { state.sample(Self.readSystem(), at: now) }
        let report = AssistRuntimeReport(
            nativeBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            current: state.current(at: now), history: state.history.values, events: state.events.values,
            diagnostic: state.diagnostic, generations: state.generations.values
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(report), as: UTF8.self)
    }

    func transition(phase: String, code: String, severity: String = "info") {
        guard running() else { return }
        state.transition(phase: phase, code: code, severity: severity, at: elapsed())
    }

    func setContextCapacity(_ value: Int?) {
        guard running() else { return }
        state.setContextCapacity(value)
    }

    func beginGeneration(requestId: String, promptTokens: Int, contextCapacity: Int, elapsedMs: Double) {
        guard running() else { return }
        state.beginGeneration(requestId: requestId, promptTokens: promptTokens, contextCapacity: contextCapacity,
                              elapsedMs: elapsedMs, at: elapsed())
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
    }

    func beginDiagnostic(total: Int) {
        guard running() else { return }
        state.beginDiagnostic(total: total, at: elapsed())
    }

    func diagnosticCase(variant _: String, mode _: String, function _: String, passed: Bool) {
        guard running() else { return }
        state.diagnosticCase(passed: passed, at: elapsed())
    }

    func endDiagnostic(phase: String = "idle") {
        guard running() else { return }
        state.endDiagnostic(phase: phase, at: elapsed())
    }

    /// Terminal and idempotent: later transitions/progress cannot register observers again.
    func shutdown() {
        guard stoppedAtMs == nil else { return }
        let now = elapsed()
        state.event(code: "MONITOR_STOPPED", severity: "info", at: now)
        stoppedAtMs = now
        lifecycleSetup?.cancel()
        lifecycleSetup = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        #if canImport(Darwin)
        for source in memorySources { source.cancel() }
        memorySources.removeAll()
        #endif
    }

    private func elapsed(_ observed: ContinuousClock.Instant? = nil) -> Double {
        AssistRuntimeMetrics.milliseconds(started.duration(to: observed ?? ContinuousClock.now))
    }

    private func running() -> Bool {
        guard stoppedAtMs == nil else { return false }
        startObservingIfNeeded()
        return true
    }

    private func startObservingIfNeeded() {
        guard !registered, stoppedAtMs == nil else { return }
        registered = true
        state.event(code: "MONITOR_STARTED", severity: "info", at: elapsed())
        #if canImport(Darwin)
        let thermal = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil
        ) { [weak self] _ in
            let observed = ContinuousClock.now
            Task { [weak self] in await self?.thermalChanged(observed: observed) }
        }
        observers.append(thermal)
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
            memorySources.append(source)
        }
        #endif
        #if canImport(UIKit)
        lifecycleSetup = Task { [weak self] in
            let names = await Self.lifecycleNames()
            guard !Task.isCancelled else { return }
            await self?.registerLifecycle(names)
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

    private func registerLifecycle(_ names: [(Notification.Name, String)]) {
        guard stoppedAtMs == nil else { return }
        for (name, code) in names {
            let observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                let observed = ContinuousClock.now
                Task { [weak self] in await self?.lifecycleChanged(code, observed: observed) }
            }
            observers.append(observer)
        }
        lifecycleSetup = nil
    }
    #endif

    private func lifecycleChanged(_ code: String, observed: ContinuousClock.Instant) {
        guard stoppedAtMs == nil else { return }
        state.event(code: code, severity: "info", at: elapsed(observed))
    }

    private func memoryPressureChanged(_ level: String, observed: ContinuousClock.Instant) {
        guard stoppedAtMs == nil else { return }
        state.memoryPressure(level, at: elapsed(observed))
    }

    private func thermalChanged(observed: ContinuousClock.Instant) {
        guard stoppedAtMs == nil else { return }
        state.thermal(Self.thermalState(), at: elapsed(observed))
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
        return AssistRuntimeSystemReading(
            physicalFootprintBytes: result == KERN_SUCCESS ? info.phys_footprint : nil,
            availableMemoryBytes: UInt64(os_proc_available_memory()), cumulativeCPUSeconds: cpu,
            thermalState: thermalState(), lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled
        )
        #else
        return AssistRuntimeSystemReading()
        #endif
    }
}
