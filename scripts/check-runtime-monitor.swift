import Foundation

/// Compile alongside AssistRuntimeMonitor.swift with Swift 6. No model/runtime SDK is needed.
@main
struct RuntimeMonitorChecks {
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        precondition(condition(), message)
    }

    static func json<T: Encodable>(_ value: T) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
    }

    static func report(_ monitor: AssistRuntimeMonitor) async throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(try await monitor.snapshotJSON().utf8)) as! [String: Any]
    }

    static func main() async throws {
        check(AssistRuntimeMetrics.cpuPercent(previousCPU: 1, currentCPU: 2, wallMs: 1_000) == 100,
              "One CPU-second per wall-second must equal 100%.")
        check(AssistRuntimeMetrics.cpuPercent(previousCPU: 1, currentCPU: 5, wallMs: 1_000) == 400,
              "CPU usage must not be normalized or capped at 100%.")
        check(AssistRuntimeMetrics.cpuPercent(previousCPU: nil, currentCPU: 2, wallMs: 1_000) == nil,
              "The first CPU observation is unknown.")
        check(AssistRuntimeMetrics.cpuPercent(previousCPU: 2, currentCPU: 1, wallMs: 1_000) == nil,
              "A reset CPU counter must not produce negative usage.")
        check(AssistRuntimeMetrics.cpuPercent(previousCPU: 1, currentCPU: .infinity, wallMs: 1_000) == nil,
              "Nonfinite CPU values must remain unavailable.")
        check(AssistRuntimeMetrics.decodeSpeed(tokens: 5, elapsedMs: 2_000, ttftMs: 1_000) == 4,
              "Decode speed uses four token intervals after the first token.")
        for (tokens, elapsed, ttft) in [(1, 2_000.0, 1_000.0), (2, 1_000, 1_000), (2, 500, 1_000), (2, .nan, 0)] {
            check(AssistRuntimeMetrics.decodeSpeed(tokens: tokens, elapsedMs: elapsed, ttftMs: ttft) == nil,
                  "Decode speed needs at least two tokens and a finite positive interval.")
        }
        check(AssistRuntimeMetrics.requestId("private prompt /path") == nil, "Do not export caller text as a request ID.")
        check(AssistRuntimeMetrics.requestId("request-123-4") == "request-123-4", "Keep the app's counter IDs.")
        check(AssistRuntimeMetrics.requestId("BA42DA5A-9CCB-4F24-B813-BE9B8F5FB937") == "ba42da5a-9ccb-4f24-b813-be9b8f5fb937",
              "Canonical UUID IDs are supported.")

        var state = AssistRuntimeMonitorState()
        check(state.current(at: 0).memoryPressure == "unknown", "Pressure starts unknown.")
        check(state.shouldSample(at: 0), "The first snapshot must be sampled.")
        state.sample(AssistRuntimeSystemReading(physicalFootprintBytes: 100, availableMemoryBytes: 50,
                                               cumulativeCPUSeconds: 1, thermalState: "nominal", lowPowerMode: false), at: 0)
        check(!state.shouldSample(at: 499), "Do not sample more often than 500 ms.")
        state.sample(AssistRuntimeSystemReading(physicalFootprintBytes: 9_999), at: 499)
        check(state.history.count == 1 && state.current(at: 499).peakPhysicalFootprintBytes == 100,
              "Throttled calls cannot change the sampled peak.")
        check(state.shouldSample(at: 500), "The 500 ms boundary permits sampling.")
        state.sample(AssistRuntimeSystemReading(physicalFootprintBytes: 200, availableMemoryBytes: 25,
                                               cumulativeCPUSeconds: 1.5, thermalState: "serious", lowPowerMode: true), at: 500)
        check(state.current(at: 500).cpuPercent == 100, "CPU uses the actual sampling interval.")
        state.sample(AssistRuntimeSystemReading(), at: 1_000)
        let unknown = state.current(at: 1_000)
        check(unknown.physicalFootprintBytes == nil && unknown.availableMemoryBytes == nil && unknown.cpuPercent == nil,
              "Failed metrics must not be invented from earlier values.")
        check(unknown.peakPhysicalFootprintBytes == 200, "A sampled peak remains historical when a later sample fails.")
        state.memoryPressure("critical", at: 1_001)
        state.memoryPressure("normal", at: 1_002)
        state.memoryPressure("warning", at: 1_001)
        check(state.current(at: 1_002).memoryPressure == "normal", "Late pressure callbacks cannot regress state.")
        state.setContextCapacity(32_768)
        check(state.current(at: 1_002).contextCapacity == 32_768, "Model capacity is visible before generation.")
        state.setContextCapacity(nil)
        check(state.current(at: 1_002).contextCapacity == nil, "Unloading clears capacity.")
        state.setContextCapacity(Int.max)
        check(state.current(at: 1_002).contextCapacity == nil, "Invalid context capacity remains unknown.")

        var bounded = AssistRuntimeMonitorState()
        for index in 0..<80 {
            bounded.sample(AssistRuntimeSystemReading(physicalFootprintBytes: UInt64(index)), at: Double(index * 500))
        }
        check(bounded.history.count == 60, "Sample history is capped at 60.")
        check(bounded.history.values.first?.sessionElapsedMs == 10_000 && bounded.history.values.last?.sessionElapsedMs == 39_500,
              "Sample retention is chronological and keeps the latest 60.")
        for index in 0..<250 {
            bounded.transition(phase: "private /path", code: "private prompt", severity: "private error", at: Double(index))
        }
        let events = bounded.events.values
        check(events.count == 200 && events.first!.sequence < events.last!.sequence, "Events are capped and ordered.")
        check(events.allSatisfy { $0.code == "PHASE_CHANGED" && $0.severity == "info" && $0.phase == "idle" },
              "Only whitelisted event and phase strings may leave the monitor.")
        check(zip(events, events.dropFirst()).allSatisfy { $0.elapsedMs <= $1.elapsedMs },
              "Late callbacks cannot move event elapsed times backwards.")

        var generations = AssistRuntimeMonitorState()
        for index in 0..<105 {
            let id = "request-123-\(index)"
            generations.beginGeneration(requestId: id, promptTokens: 32, contextCapacity: 32_768, elapsedMs: 0, at: 0)
            generations.progress(requestId: "stale", promptTokens: 32, generatedTokens: 999, elapsedMs: 999, ttftMs: 1, at: 1)
            check(generations.current(at: 1).generatedTokens == 0, "Stale requests cannot update a new generation.")
            generations.progress(requestId: id, promptTokens: 32, generatedTokens: 5, elapsedMs: 1_200, ttftMs: 200, at: 1_200)
            check(generations.current(at: 1_300).generationElapsedMs == 1_300, "Active elapsed time advances monotonically between updates.")
            generations.progress(requestId: id, promptTokens: 32, generatedTokens: 4, elapsedMs: 1_100, ttftMs: 200, at: 1_300)
            check(generations.current(at: 1_300).generatedTokens == 5, "Out-of-order progress cannot decrease native counters.")
            generations.endGeneration(requestId: id, promptTokens: 32, generatedTokens: 5, elapsedMs: 1_200,
                                      ttftMs: 200, finishReason: "eos", at: 1_400)
            generations.endGeneration(requestId: id, promptTokens: 32, generatedTokens: 5, elapsedMs: 1_200,
                                      ttftMs: 200, finishReason: "eos", at: 1_401)
        }
        let summaries = generations.generations.values
        check(summaries.count == 100 && summaries.first?.requestId == "request-123-5", "Summaries are bounded and duplicate ends do not append.")
        check(summaries.last?.generatedTokens == 5 && summaries.last?.generationElapsedMs == 1_200
              && summaries.last?.decodeTokensPerSecond == 4, "Summary metrics use the final native counts and duration.")
        check(generations.current(at: 10_000).generationElapsedMs == 1_200, "Finished durations do not keep increasing.")
        check(generations.current(at: 10_000).phase == "ready", "A completed generation restores the ready monitoring phase.")
        generations.setContextCapacity(nil)
        check(generations.current(at: 10_000).contextCapacity == nil, "Last-generation context cannot mask unload.")
        generations.beginGeneration(requestId: "private prompt /path", promptTokens: -1, contextCapacity: Int.max,
                                    elapsedMs: .nan, at: 10_000)
        let privateSample = try json(generations.current(at: 10_000))
        check(privateSample["requestId"] == nil && privateSample["promptTokens"] == nil && privateSample["contextCapacity"] == nil,
              "Unknown metrics and arbitrary IDs must remain absent/null.")
        generations.beginGeneration(requestId: "request-1-2", promptTokens: 32, contextCapacity: 32_768,
                                    elapsedMs: 0, at: 10_000)
        generations.progress(requestId: "request-1-2", promptTokens: 32, generatedTokens: 5,
                             elapsedMs: 1_200, ttftMs: 200, at: 11_200)
        generations.transition(phase: "failed", code: "GENERATION_FAILED", severity: "warning", at: 11_500)
        let frozen = generations.current(at: 20_000)
        check(frozen.phase == "failed" && frozen.generatedTokens == 5 && frozen.generationElapsedMs == 1_500,
              "Failure freezes elapsed at observation without inventing output tokens.")
        check(frozen.decodeTokensPerSecond == 4, "Failure does not invent a new native decode timestamp.")
        generations.beginGeneration(requestId: "request-1-3", promptTokens: 32, contextCapacity: 32_768,
                                    elapsedMs: 0, at: 20_000)
        generations.endGeneration(requestId: "request-1-3", promptTokens: 32, generatedTokens: 0,
                                  elapsedMs: 100, ttftMs: nil, finishReason: "cancelled", at: 20_100)
        check(generations.current(at: 30_000).phase == "ready", "A drained cancellation is ready again.")
        generations.beginGeneration(requestId: "request-1-4", promptTokens: 32, contextCapacity: 32_768,
                                    elapsedMs: 0, at: 30_000)
        generations.endGeneration(requestId: "request-1-4", promptTokens: 32, generatedTokens: 0,
                                  elapsedMs: 100, ttftMs: nil, finishReason: "error", at: 30_100)
        check(generations.current(at: 40_000).phase == "failed", "An explicitly failed end remains failed.")

        state.beginDiagnostic(total: 0, at: 1_009)
        check(state.diagnostic == nil, "Zero diagnostic cases is not a valid public total.")
        state.beginDiagnostic(total: 48, at: 1_010)
        state.diagnosticCase(passed: true, at: 1_011)
        state.diagnosticCase(passed: false, at: 1_012)
        state.diagnosticCase(passed: true, at: 1_013)
        state.endDiagnostic(at: 1_014)
        state.diagnosticCase(passed: true, at: 1_015)
        check(state.diagnostic?.completed == 3 && state.diagnostic?.total == 48 && state.diagnostic?.failed == 1,
              "Partial diagnostics preserve the actual completed/failed counts.")
        check(state.events.values.last?.code == "DIAGNOSTIC_FAILED", "A partial diagnostic is not reported as fully completed.")
        check(state.current(at: 2_000).phase == "idle", "Ending a diagnostic restores idle.")
        state.beginDiagnostic(total: 48, at: 2_000)
        state.diagnosticCase(passed: true, at: 2_001)
        state.endDiagnostic(phase: "failed", at: 2_002)
        check(state.current(at: 2_002).phase == "failed" && state.diagnostic?.completed == 1,
              "A probe entered after a failed load restores the actual coordinator phase.")
        state.beginDiagnostic(total: 48, at: 2_000)
        state.diagnosticCase(passed: false, at: 2_001)
        state.transition(phase: "idle", code: "DIAGNOSTIC_FAILED", severity: "warning", at: 2_002)
        state.diagnosticCase(passed: true, at: 2_003)
        check(state.diagnostic?.completed == 1 && state.diagnostic?.failed == 1,
              "A failed diagnostic transition stops counting without fabricating completion.")

        let monitor = AssistRuntimeMonitor()
        let first = try await report(monitor)
        let second = try await report(monitor)
        check(first["kind"] as? String == "assistRuntimeMonitoring" && first["schemaVersion"] as? Int == 1,
              "The public monitoring envelope is stable.")
        check(first["diagnostic"] is NSNull, "Unknown diagnostic status encodes explicit null.")
        check((second["history"] as! [Any]).count == 1, "Immediate native snapshots share one system sample.")
        await monitor.beginDiagnostic(total: 48)
        await monitor.diagnosticCase(variant: "private prompt", mode: "/path", function: "raw error", passed: false)
        await monitor.shutdown()
        let stopped = try await report(monitor)
        await monitor.transition(phase: "loading", code: "MODEL_LOAD_STARTED")
        await monitor.beginGeneration(requestId: "request-1-1", promptTokens: 1, contextCapacity: 32_768, elapsedMs: 0)
        await monitor.progress(requestId: "request-1-1", promptTokens: 1, generatedTokens: 10, elapsedMs: 1, ttftMs: 0)
        await monitor.setContextCapacity(32_768)
        await monitor.shutdown()
        let after = try await report(monitor)
        check(NSDictionary(dictionary: stopped).isEqual(to: after), "Shutdown is terminal, idempotent and prevents re-registration/mutation.")
        let data = try JSONSerialization.data(withJSONObject: after)
        let text = String(decoding: data, as: UTF8.self)
        check(!text.contains("private prompt") && !text.contains("raw error") && !text.contains("/path"),
              "Diagnostic arguments never enter snapshots.")
        print("PASS: runtime monitor finite metrics, CPU units, decode timing, bounded histories, privacy, context, partial diagnostics, sampling and terminal shutdown")
    }
}
