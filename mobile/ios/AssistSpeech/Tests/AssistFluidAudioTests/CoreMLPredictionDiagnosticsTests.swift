@preconcurrency import CoreML
import Foundation
import Testing
@testable import FluidAudio

@Suite("Bounded Core ML prediction breadcrumbs", .serialized)
struct CoreMLPredictionDiagnosticsTests {
    private actor Recorder {
        private var events: [CoreMLPredictionDiagnostics.Event] = []
        private var order: [String] = []
        func append(_ event: CoreMLPredictionDiagnostics.Event) { events.append(event); order.append(event.state) }
        func boundary() { order.append("prediction") }
        func snapshot() -> ([CoreMLPredictionDiagnostics.Event], [String]) { (events, order) }
    }

    private actor BeganGate {
        private var arrived = false
        private var arrival: CheckedContinuation<Void, Never>?
        private var release: CheckedContinuation<Void, Never>?
        func block() async {
            await withCheckedContinuation { continuation in
                release = continuation
                arrived = true
                arrival?.resume(); arrival = nil
            }
        }
        func waitForArrival() async {
            if !arrived { await withCheckedContinuation { arrival = $0 } }
        }
        func finish() { release?.resume(); release = nil }
    }

    private func input() throws -> MLDictionaryFeatureProvider {
        let array = try MLMultiArray(shape: [1, 2], dataType: .float32)
        array[0] = 123_456
        array[1] = -654_321
        return try MLDictionaryFeatureProvider(dictionary: ["latent_init": array])
    }

    @Test func emitsMatchedEventsAroundThePredictionBoundary() async throws {
        let recorder = Recorder()
        let previous = CoreMLPredictionDiagnostics.observer
        defer { CoreMLPredictionDiagnostics.observer = previous }
        CoreMLPredictionDiagnostics.observer = { await recorder.append($0) }
        let value = try await CoreMLPredictionDiagnostics.withPrediction(
            component: "pocket.flow", computeUnits: .cpuAndGPU, input: input()
        ) { await recorder.boundary(); return 42 }
        let (events, order) = await recorder.snapshot()
        #expect(value == 42)
        #expect(order == ["began", "prediction", "completed"])
        #expect(events.count == 2)
        #expect(events.first?.id == events.last?.id)
        #expect(UUID(uuidString: events.first?.id ?? "") != nil)
        #expect(events.allSatisfy { $0.component == "pocket.flow" && $0.computeUnits == "cpuAndGPU" })
    }

    @Test func observerIsAwaitedBeforeSubmissionAndCapturedOnceOutsideItsLock() async throws {
        let recorder = Recorder(), replacement = Recorder(), gate = BeganGate()
        let previous = CoreMLPredictionDiagnostics.observer
        defer { CoreMLPredictionDiagnostics.observer = previous }
        CoreMLPredictionDiagnostics.observer = { event in
            await recorder.append(event)
            if event.state == "began" {
                // Reentering the setter proves the callback is outside its lock.
                CoreMLPredictionDiagnostics.observer = { await replacement.append($0) }
                await gate.block()
            }
        }
        let provider = try input()
        let operation = Task {
            try await CoreMLPredictionDiagnostics.withPrediction(
                component: "pocket.flow", computeUnits: .all, input: provider
            ) { await recorder.boundary(); return 7 }
        }
        await gate.waitForArrival()
        let before = await recorder.snapshot()
        #expect(before.1 == ["began"])
        await gate.finish()
        #expect(try await operation.value == 7)
        let after = await recorder.snapshot(), others = await replacement.snapshot()
        #expect(after.1 == ["began", "prediction", "completed"])
        #expect(others.0.isEmpty)
    }

    @Test func terminalFailurePreservesTheOriginalErrorIdentityWithoutItsContents() async throws {
        let recorder = Recorder()
        let previous = CoreMLPredictionDiagnostics.observer
        defer { CoreMLPredictionDiagnostics.observer = previous }
        CoreMLPredictionDiagnostics.observer = { await recorder.append($0) }
        let native = NSError(domain: "private.speaker.name", code: 61,
                             userInfo: [NSLocalizedDescriptionKey: "secret transcript /private/model.mlmodelc"])
        do {
            let _: Int = try await CoreMLPredictionDiagnostics.withPrediction(
                component: "pocket.mimi", computeUnits: .cpuOnly, input: input()
            ) { await recorder.boundary(); throw native }
            Issue.record("Failed prediction unexpectedly succeeded")
        } catch { #expect((error as NSError) === native) }
        let (events, order) = await recorder.snapshot()
        #expect(order == ["began", "prediction", "failed"])
        #expect(events.count == 2 && events.first?.id == events.last?.id)
        #expect(events.allSatisfy { $0.computeUnits == "cpuOnly" && $0.component == "pocket.mimi" })
        #expect(!String(reflecting: events).contains("secret transcript"))
        #expect(!String(reflecting: events).contains("private.speaker"))
    }

    @Test func cancellationBeforeTheBoundaryDoesNotSubmitOrReplaceCancellationError() async throws {
        let recorder = Recorder()
        let previous = CoreMLPredictionDiagnostics.observer
        defer { CoreMLPredictionDiagnostics.observer = previous }
        CoreMLPredictionDiagnostics.observer = { await recorder.append($0) }
        let provider = try input()
        let cancelled = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await CoreMLPredictionDiagnostics.withPrediction(
                component: "pocket.flow", computeUnits: .cpuAndGPU, input: provider
            ) { await recorder.boundary(); return 0 }
        }
        do { _ = try await cancelled.value; Issue.record("Pre-cancelled prediction ran") }
        catch is CancellationError { }
        let before = await recorder.snapshot()
        #expect(before.0.isEmpty && before.1.isEmpty)

        CoreMLPredictionDiagnostics.observer = { event in
            await recorder.append(event)
            if event.state == "began" { withUnsafeCurrentTask { $0?.cancel() } }
        }
        let duringBegan = Task {
            try await CoreMLPredictionDiagnostics.withPrediction(
                component: "pocket.flow", computeUnits: .cpuAndGPU, input: provider
            ) { await recorder.boundary(); return 0 }
        }
        do { _ = try await duringBegan.value; Issue.record("Prediction submitted after observer cancellation") }
        catch is CancellationError { }
        let after = await recorder.snapshot()
        #expect(after.1 == ["began", "failed"])
    }

    @Test func noObserverUnnamedAndUnknownComponentsKeepTheUninstrumentedResult() async throws {
        let recorder = Recorder()
        let previous = CoreMLPredictionDiagnostics.observer
        defer { CoreMLPredictionDiagnostics.observer = previous }
        CoreMLPredictionDiagnostics.observer = nil
        #expect(try await CoreMLPredictionDiagnostics.withPrediction(
            component: "pocket.flow", computeUnits: .all, input: input()
        ) { 19 } == 19)
        CoreMLPredictionDiagnostics.observer = { await recorder.append($0) }
        for component in [nil, "private /model/path secret transcript"] as [String?] {
            #expect(try await CoreMLPredictionDiagnostics.withPrediction(
                component: component, computeUnits: .all, input: input()
            ) { 23 } == 23)
        }
        let result = await recorder.snapshot()
        #expect(result.0.isEmpty)
    }

    @Test func realTensorMetadataContainsNoValuesAndOnlyTheComponentSpecificNames() throws {
        for (type, expected) in [(MLMultiArrayDataType.float16, "float16"), (.float32, "float32"),
                                 (.double, "float64"), (.int32, "int32")] {
            let tensor = try MLMultiArray(shape: [2, 3], dataType: type)
            for index in 0..<tensor.count { tensor[index] = 123_456 }
            let provider = try MLDictionaryFeatureProvider(dictionary: ["latent_init": tensor,
                                                                        "private Speaker /reference.wav": tensor])
            let metadata = CoreMLPredictionDiagnostics.inputMetadata(from: provider, component: "pocket.flow")
            #expect(metadata.count == 2 && metadata.inputs.count == 1 && metadata.truncated)
            #expect(metadata.inputs.first?.name == "latent_init")
            #expect(metadata.inputs.first?.shape == [2, 3])
            #expect(metadata.inputs.first?.count == 6 && metadata.inputs.first?.dataType == expected)
            #expect(!String(reflecting: metadata.inputs).contains("123456"))
            #expect(!String(reflecting: metadata.inputs).contains("Speaker"))
        }
    }

    @Test func cachesMimiAndFeatureCountsUseFixedBounds() throws {
        let tensor = try MLMultiArray(shape: [1], dataType: .float32)
        let provider = try MLDictionaryFeatureProvider(dictionary: ["cache23": tensor, "cache24": tensor, "position23": tensor])
        let edges = CoreMLPredictionDiagnostics.inputMetadata(from: provider, component: "pocket.conditioner")
        #expect(edges.inputs.map(\.name) == ["cache23", "position23"])
        #expect(edges.count == 3 && edges.truncated)
        var many: [String: Any] = [:]
        for index in 0..<24 { many["cache\(index)"] = tensor }
        for index in 0..<200 { many["private transcript \(index)"] = tensor }
        let bounded = CoreMLPredictionDiagnostics.inputMetadata(
            from: try MLDictionaryFeatureProvider(dictionary: many), component: "pocket.flowlm")
        #expect(bounded.inputs.count == 8 && bounded.count == 128 && bounded.truncated)
        #expect(bounded.inputs.map(\.name) == (0..<8).map { "cache\($0)" })
        let mimi = CoreMLPredictionDiagnostics.inputMetadata(
            from: try MLDictionaryFeatureProvider(dictionary: ["latent": tensor, "attn0_cache": tensor,
                                                               "conv_final_first": tensor, "var_123": tensor]),
            component: "pocket.mimi")
        #expect(mimi.inputs.map(\.name) == ["latent", "attn0_cache", "conv_final_first"])
        #expect(mimi.truncated)
    }

    @Test func descriptorRankDimensionsAndCountCannotExceedThePersistenceContract() {
        let result = CoreMLPredictionDiagnostics.boundedTensor(
            name: "mel", shape: [Int.max, -1] + [Int](repeating: 1, count: 10), dataType: .float32, count: Int.max)
        #expect(result.tensor.shape == [Int(Int32.max), 0, 1, 1, 1, 1, 1, 1])
        #expect(result.tensor.count == Int(Int32.max) && result.truncated)
        let negative = CoreMLPredictionDiagnostics.boundedTensor(name: "mel", shape: [1], dataType: .int32, count: -1)
        #expect(negative.tensor.count == 0 && negative.truncated)
    }

    @Test func productionAsyncBoundariesUseOnlyTheSixApprovedComponents() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let expected: [(String, [String])] = [
            ("TTS/PocketTTS/Pipeline/PocketTtsSynthesizer+KVCache.swift", ["pocket.conditioner", "pocket.conditioner", "pocket.flowlm"]),
            ("TTS/PocketTTS/Pipeline/PocketTtsSynthesizer+Flow.swift", ["pocket.flow"]),
            ("TTS/PocketTTS/Pipeline/PocketTtsSynthesizer+Mimi.swift", ["pocket.mimi"]),
            ("ASR/Parakeet/SlidingWindow/TDT/AsrManager+Pipeline.swift", ["parakeet.preprocessor", "parakeet.encoder"]),
        ]
        for (file, components) in expected {
            let source = try String(contentsOf: root.appendingPathComponent("Sources/FluidAudio/\(file)"), encoding: .utf8)
            #expect(source.components(separatedBy: ".compatPrediction(").count - 1 == components.count)
            for component in Set(components) {
                #expect(source.components(separatedBy: "component: \"\(component)\"").count - 1
                        == components.filter { $0 == component }.count)
            }
        }
    }
}
