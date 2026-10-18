import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

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

    /// Observe autonomous persisted progress, not a presumed VM timer deadline.
    /// Reads only: this cannot manufacture a native sample through an export.
    static func waitForSavedHistory(_ file: URL, count: Int) async throws -> [String: Any] {
        var latest: [String: Any] = [:]
        for _ in 0..<100 {
            latest = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
            if (latest["history"] as? [Any])?.count ?? 0 >= count { return latest }
            try await Task.sleep(for: .milliseconds(50))
        }
        return latest
    }

    static func main() async throws {
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--abrupt-monitor-child" {
            let monitor = AssistRuntimeMonitor(directory: URL(fileURLWithPath: CommandLine.arguments[2]), sampleInterval: .milliseconds(50))
            await monitor.start()
            await monitor.recordVoiceStage("preparing")
            await monitor.recordVoiceStage("speaking")
            await prediction(monitor, component: "pocket.flowlm")
            // The parent kills only this exact subprocess. Do not run shutdown:
            // recovery must use a periodic checkpoint, not graceful teardown.
            while true { try await Task.sleep(for: .seconds(30)) }
        }
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

        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let monitor = AssistRuntimeMonitor(directory: temporary.appendingPathComponent("baseline"))
        let first = try await report(monitor)
        _ = try await report(monitor)
        check(first["kind"] as? String == "assistRuntimeMonitoring" && first["schemaVersion"] as? Int == 1,
              "The public monitoring envelope is stable.")
        check(first["diagnostic"] is NSNull, "Unknown diagnostic status encodes explicit null.")
        check((first["history"] as! [Any]).count == 1, "The first native snapshot contains one system sample.")
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
        try await persistenceAndSamplingChecks(root: temporary)
        try await predictionChecks(root: temporary)
        try await abruptProcessRecovery(root: temporary)
        print("PASS: runtime monitor finite metrics, CPU units, decode timing, bounded histories, privacy, context, partial diagnostics, sampling and terminal shutdown")
    }

    static func prediction(_ monitor: AssistRuntimeMonitor, component: String,
                           id: String = UUID().uuidString, state: String = "began",
                           inputs: [AssistRuntimePredictionTensor] = [
                            .init(name: "sequence", shape: [1, 1, 32], dataType: "float32", count: 32)
                           ], featureCount: Int = 1) async {
        await monitor.recordCoreMLPrediction(id: id, component: component, state: state, computeUnits: "all",
                                            inputs: inputs, inputFeatureCount: featureCount, metadataTruncated: false)
    }

    static func predictionChecks(root: URL) async throws {
        let bridge = try String(contentsOfFile: "mobile/ios/Assist/Inference/AssistCoreAI.swift", encoding: .utf8)
        let hookStart = bridge.range(of: "// BEGIN CORE ML MONITOR OBSERVER")!
        let hookEnd = bridge.range(of: "// END CORE ML MONITOR OBSERVER", range: hookStart.upperBound..<bridge.endIndex)!
        let hook = bridge[hookStart.upperBound..<hookEnd.lowerBound]
        check(hook.contains("CoreMLPredictionDiagnostics.observer = { [weak monitor] event in") &&
              hook.contains("await monitor?.recordCoreMLPrediction("),
              "The native engine installs an awaited observer without retaining the bridge or monitor.")
        let voiceRuntime = try String(contentsOfFile: "mobile/ios/Assist/Voice/AssistFluidVoiceRuntime.swift", encoding: .utf8)
        check(!voiceRuntime.contains("CoreMLPredictionDiagnostics.observer ="),
              "Replacing a voice runtime must not replace the engine-owned global prediction observer.")
        let directory = root.appendingPathComponent("predictions")
        let current = directory.appendingPathComponent("current.json")
        let fixedNow = ContinuousClock.now
        let monitor = AssistRuntimeMonitor(directory: directory, clock: { fixedNow })
        await monitor.start()
        await monitor.recordVoiceStage("preparing")
        let firstID = UUID().uuidString.lowercased()
        await prediction(monitor, component: "pocket.flowlm", id: firstID)
        let beganData = try Data(contentsOf: current)
        let began = try JSONSerialization.jsonObject(with: beganData) as! [String: Any]
        let firstDisk = (began["coreMLPredictions"] as! [[String: Any]]).first
        check(firstDisk?["id"] as? String == firstID && firstDisk?["state"] as? String == "began",
              "The first component begin must already be checkpointed when its awaited callback returns.")
        check(firstDisk?["voiceTurn"] as? Int == 1, "Preparing starts a new native voice-turn checkpoint allowance.")
        await prediction(monitor, component: "pocket.flowlm", id: firstID, state: "completed")
        let completedReport = try await report(monitor)
        check((completedReport["coreMLPredictions"] as! [[String: Any]]).first?["state"] as? String == "completed",
              "A matching successful operation records completion without claiming that it remains in flight.")
        let newerID = UUID().uuidString.lowercased()
        await prediction(monitor, component: "pocket.flowlm", id: newerID)
        await prediction(monitor, component: "pocket.flowlm", id: firstID, state: "failed")
        let inMemory = try await report(monitor)
        let newer = (inMemory["coreMLPredictions"] as! [[String: Any]]).first!
        check(newer["id"] as? String == newerID && newer["state"] as? String == "began",
              "A late completion/failure cannot overwrite a newer operation of the same component.")
        await prediction(monitor, component: "pocket.flowlm", id: newerID, state: "failed")
        let failureReport = try await report(monitor)
        check((failureReport["coreMLPredictions"] as! [[String: Any]]).first?["state"] as? String == "failed",
              "A matching Swift failure remains distinguishable from a completed or open operation.")
        for _ in 0..<500 {
            let id = UUID().uuidString
            await prediction(monitor, component: "pocket.flowlm", id: id)
            await prediction(monitor, component: "pocket.flowlm", id: id, state: "completed")
        }
        let hotLoopDisk = try Data(contentsOf: current)
        check(hotLoopDisk == beganData,
              "A hot prediction loop cannot force one checkpoint per frame, begin or completion.")
        for component in AssistRuntimePrediction.components.sorted() where component != "pocket.flowlm" {
            await prediction(monitor, component: component)
            let disk = try JSONSerialization.jsonObject(with: Data(contentsOf: current)) as! [String: Any]
            check((disk["coreMLPredictions"] as! [[String: Any]]).contains { $0["component"] as? String == component && $0["state"] as? String == "began" },
                  "Each of the six components gets its first awaited begin checkpoint.")
        }
        let sixBegins = try Data(contentsOf: current)
        await monitor.recordVoiceStage("preparing")
        for component in AssistRuntimePrediction.components {
            await prediction(monitor, component: component)
        }
        let repeatedBegins = try Data(contentsOf: current)
        check(repeatedBegins == sixBegins, "Only six first-begin allowances exist in a voice turn.")
        let beforeInvalid = try await report(monitor)["coreMLPredictions"] as! [[String: Any]]
        let previousTurnFlowID = beforeInvalid.first { $0["component"] as? String == "pocket.flow" }!["id"] as! String
        await prediction(monitor, component: "/private/Speaker")
        await prediction(monitor, component: "pocket.flowlm", id: "private transcript")
        await prediction(monitor, component: "pocket.flowlm", state: "private /path")
        for tensor in [
            AssistRuntimePredictionTensor(name: "PrivateSpeaker", shape: [1], dataType: "float32", count: 1),
            .init(name: "sequence", shape: Array(repeating: 1, count: 9), dataType: "float32", count: 1),
            .init(name: "sequence", shape: [Int.max], dataType: "float32", count: 1),
            .init(name: "sequence", shape: [1], dataType: "private /path", count: 1),
            .init(name: "sequence", shape: [1], dataType: "float32", count: -1),
        ] {
            await prediction(monitor, component: "pocket.flowlm", inputs: [tensor])
        }
        await prediction(monitor, component: "pocket.flowlm", featureCount: 129)
        let afterInvalid = try await report(monitor)
        let afterInvalidPredictions = afterInvalid["coreMLPredictions"] as! [[String: Any]]
        check(NSDictionary(dictionary: ["values": beforeInvalid]).isEqual(to: ["values": afterInvalidPredictions]),
              "Invalid components, IDs and tensor metadata never enter monitoring storage.")
        await monitor.recordVoiceStage("speaking")
        await monitor.recordVoiceStage("preparing")
        let nextTurnID = UUID().uuidString.lowercased()
        await prediction(monitor, component: "pocket.flowlm", id: nextTurnID)
        let nextTurn = try JSONSerialization.jsonObject(with: Data(contentsOf: current)) as! [String: Any]
        let nextDisk = (nextTurn["coreMLPredictions"] as! [[String: Any]]).first { $0["component"] as? String == "pocket.flowlm" }!
        check(nextDisk["id"] as? String == nextTurnID && nextDisk["voiceTurn"] as? Int == 2,
              "A new preparing stage restores the first-begin allowance without changing the LLM phase.")
        await prediction(monitor, component: "pocket.flow", id: previousTurnFlowID, state: "completed")
        let lateTurnReport = try await report(monitor)
        let lateTurnFlow = (lateTurnReport["coreMLPredictions"] as! [[String: Any]]).first { $0["component"] as? String == "pocket.flow" }!
        check(lateTurnFlow["voiceTurn"] as? Int == 1 && lateTurnFlow["state"] as? String == "completed",
              "A delayed completion keeps the turn of its original begin, not the current preparing turn.")
        let exported = try await monitor.snapshotJSON()
        for forbidden in ["PrivateSpeaker", "private transcript", "/private/", "private /path"] {
            check(!exported.contains(forbidden), "Prediction metadata must never retain arbitrary names or user values.")
        }
        await monitor.shutdown()
        let validData = try Data(contentsOf: current)
        check(validData.count <= 128 * 1_024, "Tensor metadata remains inside the existing report cap.")
        try validData.write(to: directory.appendingPathComponent("previous.json"), options: .atomic)
        var corrupted = try JSONSerialization.jsonObject(with: validData) as! [String: Any]
        var badPredictions = corrupted["coreMLPredictions"] as! [[String: Any]]
        badPredictions[0]["inputs"] = [["name": "PrivateSpeaker", "shape": [1], "dataType": "float32", "count": 1]]
        corrupted["coreMLPredictions"] = badPredictions
        try JSONSerialization.data(withJSONObject: corrupted).write(to: current, options: .atomic)
        let restarted = AssistRuntimeMonitor(directory: directory)
        await restarted.start()
        let previous = try await restarted.previousSnapshotJSON()
        check(previous == String(decoding: validData, as: UTF8.self),
              "Corrupted prediction metadata cannot replace the previous valid checkpoint on restart.")
        await restarted.shutdown()
        let blocked = root.appendingPathComponent("prediction-disk-failure")
        try Data("occupied".utf8).write(to: blocked)
        let failing = AssistRuntimeMonitor(directory: blocked)
        await prediction(failing, component: "pocket.mimi")
        let failed = try await report(failing)
        check((failed["persistence"] as! [String: Any])["status"] as? String == "unavailable" &&
              (failed["coreMLPredictions"] as! [Any]).count == 1,
              "Checkpoint failure returns normally, preserves metadata in memory, and cannot claim persistence.")
        await failing.shutdown()
        print("PASS: awaited first prediction checkpoints, six-per-turn allowance, hot-loop rate bounds, UUID correlation, tensor privacy and corrupt/disk-failure recovery")
    }

    static func persistenceAndSamplingChecks(root: URL) async throws {
        let manager = FileManager.default
        let directory = root.appendingPathComponent("restart")
        let current = directory.appendingPathComponent("current.json")
        let previous = directory.appendingPathComponent("previous.json")
        let first = AssistRuntimeMonitor(directory: directory, sampleInterval: .milliseconds(30), checkpointInterval: .milliseconds(100))
        await first.start()
        // No JS snapshot/export has occurred: native start must already persist.
        check(manager.fileExists(atPath: current.path), "Native start checkpoints without any JS export.")
        let initial = try Data(contentsOf: current)
        let initialObject = try JSONSerialization.jsonObject(with: initial) as! [String: Any]
        let id = initialObject["sessionId"] as! String
        check(UUID(uuidString: id) != nil && initialObject["sessionStartedAt"] is String && initialObject["capturedAt"] is String,
              "Session ID and UTC timestamps correlate records across restart.")
        let fileAttributes = try manager.attributesOfItem(atPath: current.path)
        check((fileAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,
              "Diagnostics are private to the local app user.")
        #if canImport(Darwin)
        let backupValues = try current.resourceValues(forKeys: [.isExcludedFromBackupKey])
        check(backupValues.isExcludedFromBackup == true, "Diagnostics must be excluded from device backup.")
        #endif
        await first.start()
        check(!manager.fileExists(atPath: previous.path), "Repeated start cannot rotate the current session into previous.")
        let periodic = try await waitForSavedHistory(current, count: 2)
        check((periodic["history"] as! [Any]).count >= 2, "Native sampling advances without requesting JS snapshots.")
        await first.recordVoiceStage("pocket")
        await first.transition(phase: "ready", code: "MODEL_LOAD_COMPLETED")
        await first.recordVoiceStage("listening")
        await first.recordVoiceStage("private prompt /path")
        let live = try await report(first)
        let sample = live["current"] as! [String: Any]
        check(sample["phase"] as? String == "ready" && sample["voiceStage"] as? String == "listening",
              "Whitelisted voice stage is independent of the inference phase.")
        await first.recordLifecycle("APP_BACKGROUND")
        let background = try await report(first)
        let backgroundCount = (background["history"] as! [Any]).count
        // Pause the sampler explicitly: a legitimate autonomous sample during
        // slow exports must not be mistaken for an export-created sample.
        for _ in 0..<50 { _ = try await report(first) }
        let afterExports = try await report(first)
        check((afterExports["history"] as! [Any]).count == backgroundCount, "Exports cannot append native samples while the sampler is paused.")
        try await Task.sleep(for: .milliseconds(600))
        let afterBackground = try await report(first)
        check((afterBackground["history"] as! [Any]).count == backgroundCount, "Background stops the native sampler.")
        let oldBackground = ContinuousClock.now
        await first.recordLifecycle("APP_ACTIVE")
        await first.recordLifecycle("APP_BACKGROUND", observed: oldBackground)
        let resumed = try await report(first)
        let resumedCount = (resumed["history"] as! [Any]).count
        _ = try await waitForSavedHistory(current, count: resumedCount + 1)
        let afterForeground = try await report(first)
        check((afterForeground["history"] as! [Any]).count > resumedCount,
              "Foreground restarts sampling; a delayed older background callback cannot stop it again.")
        let lifecycleEvents = afterForeground["events"] as! [[String: Any]]
        let delayed = lifecycleEvents.last { $0["code"] as? String == "APP_BACKGROUND" }!
        let active = lifecycleEvents.last { $0["code"] as? String == "APP_ACTIVE" }!
        check((delayed["observedElapsedMs"] as! Double) <= (active["observedElapsedMs"] as! Double),
              "Delayed lifecycle events preserve their actual observation timestamp.")
        await first.shutdown()
        let stoppedData = try Data(contentsOf: current)
        try await Task.sleep(for: .milliseconds(120))
        _ = try await report(first)
        let afterStopData = try Data(contentsOf: current)
        check(afterStopData == stoppedData, "Shutdown and later exports do not resume disk writes.")

        // Restart must preserve the old session before any export, even if the
        // second process is closed before its first export.
        let second = AssistRuntimeMonitor(directory: directory)
        await second.start()
        let saved = try await second.previousSnapshotJSON()
        let savedObject = try JSONSerialization.jsonObject(with: Data(saved.utf8)) as! [String: Any]
        check(savedObject["sessionId"] as? String == id,
              "Restart rotates the last session at native start, not first export.")
        let previousData = try Data(contentsOf: previous)
        await second.start()
        let previousAfterStart = try Data(contentsOf: previous)
        check(previousAfterStart == previousData, "One session rotates once.")
        await second.shutdown()

        for damaged in [Data("{\"schemaVersion\":".utf8), Data(repeating: 32, count: AssistRuntimeArchive.maximumBytes + 1)] {
            try damaged.write(to: current, options: .atomic)
            let recovered = AssistRuntimeMonitor(directory: directory)
            await recovered.start()
            let preserved = try Data(contentsOf: previous)
            let recoveredJSON = try await recovered.previousSnapshotJSON()
            check(preserved == previousData, "Corrupt/truncated/oversized current cannot replace valid previous.")
            check(recoveredJSON == saved, "A valid previous remains exportable after current corruption.")
            await recovered.shutdown()
        }
        // Both files invalid: report absence rather than exporting arbitrary JSON.
        try Data("{\"private\":\"raw error /path\"}".utf8).write(to: previous, options: .atomic)
        try Data("{broken".utf8).write(to: current, options: .atomic)
        let invalid = AssistRuntimeMonitor(directory: directory)
        await invalid.start()
        let invalidJSON = try await invalid.previousSnapshotJSON()
        check(invalidJSON == "null", "Invalid archives are not exported.")
        await invalid.shutdown()

        let blockedDirectory = root.appendingPathComponent("not-a-directory")
        try Data("occupied".utf8).write(to: blockedDirectory)
        let failing = AssistRuntimeMonitor(directory: blockedDirectory, sampleInterval: .milliseconds(30))
        await failing.start()
        await failing.recordVoiceStage("listening")
        let failedReport = try await report(failing)
        check((failedReport["persistence"] as! [String: Any])["status"] as? String == "unavailable",
              "Disk failure remains visible without failing sampling or model work.")
        check((failedReport["current"] as! [String: Any])["voiceStage"] as? String == "listening", "Disk failure does not block stage recording.")
        await failing.shutdown()

        let boundedDirectory = root.appendingPathComponent("bounded")
        let fixedNow = ContinuousClock.now
        let bounded = AssistRuntimeMonitor(directory: boundedDirectory, clock: { fixedNow })
        await bounded.start()
        await bounded.memoryPressureChanged("critical", observed: fixedNow)
        await bounded.memoryPressureChanged("normal", observed: fixedNow.advanced(by: .milliseconds(1)))
        let pressureReport = try await report(bounded)
        let pressureEvents = (pressureReport["events"] as! [[String: Any]]).filter { $0["code"] as? String == "MEMORY_PRESSURE_CHANGED" }
        check(pressureEvents.count == 2 && pressureEvents.first?["severity"] as? String == "critical",
              "A critical pressure event remains recorded even when it clears before the next checkpoint.")
        for index in 0..<500 {
            await bounded.recordVoiceStage(index.isMultiple(of: 2) ? "pocket" : "failed")
            await bounded.beginGeneration(requestId: "request-123-\(index)", promptTokens: 1,
                                          contextCapacity: 32_768, elapsedMs: 0)
            await bounded.endGeneration(requestId: "request-123-\(index)", promptTokens: 1,
                                        generatedTokens: 1, elapsedMs: 1, ttftMs: 1, finishReason: "error")
        }
        // Rapid checkpoint-producing events remain in the bounded in-memory log;
        // they cannot each write a checkpoint during the one-second event throttle.
        let throttledDisk = try JSONSerialization.jsonObject(with: Data(contentsOf: boundedDirectory.appendingPathComponent("current.json"))) as! [String: Any]
        check((throttledDisk["events"] as! [Any]).count < 200, "Rapid stage/error events do not force one disk write per event.")
        await bounded.shutdown()
        let boundedSize = try Data(contentsOf: boundedDirectory.appendingPathComponent("current.json")).count
        check(boundedSize <= 128 * 1_024, "Every persisted session respects the 128 KiB bound.")
        let restarted = AssistRuntimeMonitor(directory: boundedDirectory)
        await restarted.start()
        for name in ["current.json", "previous.json"] {
            let size = try Data(contentsOf: boundedDirectory.appendingPathComponent(name)).count
            check(size <= 128 * 1_024,
                  "Rotation keeps both persisted sessions within the cap.")
        }
        let names = try manager.contentsOfDirectory(atPath: boundedDirectory.path).sorted()
        check(names == ["current.json", "previous.json"],
              "Successful atomic checkpoints retain only two fixed report files.")
        await restarted.shutdown()

        var disposable: AssistRuntimeMonitor? = AssistRuntimeMonitor(directory: root.appendingPathComponent("weak"), sampleInterval: .milliseconds(30))
        weak let weakMonitor = disposable
        await disposable?.start()
        disposable = nil
        try await Task.sleep(for: .milliseconds(100))
        check(weakMonitor == nil, "The sampler must not retain its monitor across sleep.")
        print("PASS: native sampler without JS, foreground lifecycle, terminal stop, independent voice stages, bounded atomic two-session storage, restart/rotation/corruption/disk failures, throttled checkpoints and weak lifetime")
    }

    static func abruptProcessRecovery(root: URL) async throws {
        let directory = root.appendingPathComponent("abrupt-process")
        let current = directory.appendingPathComponent("current.json")
        let child = Process()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        child.arguments = ["--abrupt-monitor-child", directory.path]
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        let childPID = child.processIdentifier
        check(childPID > 0, "Only a successfully spawned child may be terminated.")
        defer {
            if child.isRunning { _ = kill(childPID, SIGKILL) }
        }
        var checkpoint: [String: Any]?
        for _ in 0..<100 {
            if let data = try? Data(contentsOf: current),
               let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let sample = object["current"] as? [String: Any], sample["voiceStage"] as? String == "speaking",
               let predictions = object["coreMLPredictions"] as? [[String: Any]],
               predictions.contains(where: { $0["component"] as? String == "pocket.flowlm" && $0["state"] as? String == "began" }) {
                checkpoint = object
                break
            }
            check(child.isRunning, "The sampler child must stay alive until its checkpoint is observed.")
            try await Task.sleep(for: .milliseconds(50))
        }
        check(checkpoint != nil, "A subprocess must checkpoint its native state without JS or shutdown.")
        check(kill(childPID, SIGKILL) == 0, "Terminate only the exact subprocess created by this test.")
        for _ in 0..<100 {
            if !child.isRunning { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        check(!child.isRunning, "The killed child must exit before testing a new session.")
        let restarted = AssistRuntimeMonitor(directory: directory)
        await restarted.start()
        let previousJSON = try await restarted.previousSnapshotJSON()
        let previous = try JSONSerialization.jsonObject(with: Data(previousJSON.utf8)) as! [String: Any]
        check(previous["sessionId"] as? String == checkpoint?["sessionId"] as? String,
              "A fresh native monitor recovers the session killed before any export or graceful shutdown.")
        check((previous["current"] as! [String: Any])["voiceStage"] as? String == "speaking",
              "The recovered checkpoint preserves the last saved voice stage.")
        check((previous["coreMLPredictions"] as! [[String: Any]]).contains { $0["component"] as? String == "pocket.flowlm" && $0["state"] as? String == "began" },
              "A begin checkpoint survives SIGKILL without a completion callback or graceful shutdown.")
        check(!(previous["events"] as! [[String: Any]]).contains { $0["code"] as? String == "MONITOR_STOPPED" },
              "Recovery must not fabricate a graceful shutdown event for a killed process.")
        await restarted.shutdown()
        print("PASS: real subprocess SIGKILL preserves a native checkpoint and a new process session exports it after restart")
    }
}
