@preconcurrency import CoreML
import Foundation
import Testing
@testable import FluidAudio

@Suite("Pocket model loading")
struct PocketModelLoaderTests {
    private final class LocalModel {
        let value = 43
    }

    private actor Attempts {
        private var values: [PocketTtsModelLoadAttempt] = []

        func append(_ attempt: PocketTtsModelLoadAttempt) { values.append(attempt) }
        func snapshot() -> [PocketTtsModelLoadAttempt] { values }
    }

    @Test func successfulAutomaticLoadRunsOnce() async throws {
        let progress = Attempts()
        var calls: [MLComputeUnits] = []
        let result = try await PocketTtsModelLoader.load(
            component: "cond_prefill.mlmodelc", units: .all,
            progress: { await progress.append($0) }
        ) { units in
            calls.append(units)
            return 41
        }

        #expect(result == 41)
        #expect(calls == [.all])
        let attempts = await progress.snapshot()
        #expect(attempts.count == 1)
        #expect(attempts.first?.component == "cond_prefill.mlmodelc")
        #expect(attempts.first?.computeUnits == "all")
        #expect(attempts.first?.retry == false)
    }

    @Test @MainActor func nonSendableResultStaysOnTheCallerActor() async throws {
        let model = LocalModel()
        let loaded = try await PocketTtsModelLoader.load(component: "local-model", units: .cpuOnly) { _ in model }
        #expect(loaded === model)
        #expect(loaded.value == 43)
    }

    @Test func automaticCoreMLFailureRetriesTheSameComponentOnce() async throws {
        let progress = Attempts()
        var calls: [MLComputeUnits] = []
        let result = try await PocketTtsModelLoader.load(
            component: "flowlm_stepv2.mlmodelc", units: .all,
            progress: { await progress.append($0) }
        ) { units in
            calls.append(units)
            if units == .all { throw NSError(domain: "com.apple.CoreML", code: 0) }
            return 42
        }

        #expect(result == 42)
        #expect(calls == [.all, .cpuAndGPU])
        let attempts = await progress.snapshot()
        #expect(attempts.map(\.component) == ["flowlm_stepv2.mlmodelc", "flowlm_stepv2.mlmodelc"])
        #expect(attempts.map(\.computeUnits) == ["all", "cpuAndGPU"])
        #expect(attempts.map(\.retry) == [false, true])
    }

    @Test func failedRetryPreservesTerminalErrorAndAttemptContext() async throws {
        let terminal = NSError(domain: "com.apple.CoreML", code: 7,
                               userInfo: [NSLocalizedDescriptionKey: "/private/model/path"])
        var calls: [MLComputeUnits] = []
        do {
            let _: Int = try await PocketTtsModelLoader.load(
                component: "flow_decoder_fused.mlmodelc", units: .all
            ) { units in
                calls.append(units)
                if units == .all { throw NSError(domain: "com.apple.CoreML", code: 0) }
                throw terminal
            }
            Issue.record("A failed retry unexpectedly succeeded")
        } catch {
            let wrapped = error as NSError
            #expect(wrapped.domain == "FluidAudio.PocketModelLoad")
            #expect(wrapped.code == 7)
            #expect(wrapped.userInfo["PocketTtsComponent"] as? String == "flow_decoder_fused.mlmodelc")
            #expect(wrapped.userInfo["PocketTtsComputeUnits"] as? String == "cpuAndGPU")
            #expect(wrapped.userInfo["PocketTtsInitialComputeUnits"] as? String == "all")
            #expect(wrapped.userInfo["PocketTtsRetried"] as? Bool == true)
            #expect((wrapped.userInfo[NSUnderlyingErrorKey] as? NSError) === terminal)
            #expect(wrapped.userInfo[NSLocalizedDescriptionKey] == nil)
        }
        #expect(calls == [.all, .cpuAndGPU])
    }

    @Test func nonCoreMLErrorDoesNotRetry() async throws {
        var calls = 0
        let underlying = NSError(domain: NSCocoaErrorDomain, code: 260)
        do {
            let _: Int = try await PocketTtsModelLoader.load(component: "cond_prefill.mlmodelc", units: .all) { _ in
                calls += 1
                throw underlying
            }
            Issue.record("A missing file unexpectedly loaded")
        } catch {
            let wrapped = error as NSError
            #expect(wrapped.domain == "FluidAudio.PocketModelLoad")
            #expect(wrapped.code == 260)
            #expect(wrapped.userInfo["PocketTtsComputeUnits"] as? String == "all")
            #expect(wrapped.userInfo["PocketTtsRetried"] as? Bool == false)
            #expect(wrapped.userInfo["PocketTtsInitialComputeUnits"] == nil)
            #expect((wrapped.userInfo[NSUnderlyingErrorKey] as? NSError) === underlying)
        }
        #expect(calls == 1)
    }

    @Test func explicitComputeUnitsNeverRetry() async throws {
        for requested in [MLComputeUnits.cpuOnly, .cpuAndGPU, .cpuAndNeuralEngine] {
            var calls: [MLComputeUnits] = []
            do {
                let _: Int = try await PocketTtsModelLoader.load(component: "mimi_decoder.mlmodelc", units: requested) { units in
                    calls.append(units)
                    throw NSError(domain: "com.apple.CoreML", code: 0)
                }
                Issue.record("A rejected explicit configuration unexpectedly loaded")
            } catch {
                let wrapped = error as NSError
                #expect(wrapped.domain == "FluidAudio.PocketModelLoad")
                #expect(wrapped.userInfo["PocketTtsComputeUnits"] as? String == requested.pocketTtsLabel)
                #expect(wrapped.userInfo["PocketTtsRetried"] as? Bool == false)
            }
            #expect(calls == [requested])
        }
    }

    @Test func cancellationErrorDoesNotRetryOrWrap() async throws {
        let progress = Attempts()
        var calls = 0
        do {
            let _: Int = try await PocketTtsModelLoader.load(
                component: "cond_prefill.mlmodelc", units: .all,
                progress: { await progress.append($0) }
            ) { _ in
                calls += 1
                throw CancellationError()
            }
            Issue.record("A cancelled load unexpectedly succeeded")
        } catch is CancellationError {
        } catch {
            Issue.record("Cancellation was wrapped: \(error)")
        }
        #expect(calls == 1)
        #expect(await progress.snapshot().count == 1)
    }

    @Test func cancellationBeforeLoadingSkipsProgressAndOperation() async throws {
        let progress = Attempts()
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await PocketTtsModelLoader.load(
                component: "cond_prefill.mlmodelc", units: .all,
                progress: { await progress.append($0) }
            ) { _ in
                Issue.record("A cancelled task entered the load operation")
                return 1
            }
        }
        do {
            _ = try await task.value
            Issue.record("A cancelled task unexpectedly loaded a model")
        } catch is CancellationError {
        } catch {
            Issue.record("Cancellation was wrapped: \(error)")
        }
        #expect(await progress.snapshot().isEmpty)
    }

    @Test func cancellationDuringOperationStopsBeforeFallback() async throws {
        let progress = Attempts()
        let task = Task {
            var calls = 0
            do {
                let _: Int = try await PocketTtsModelLoader.load(
                    component: "cond_prefill.mlmodelc", units: .all,
                    progress: { await progress.append($0) }
                ) { _ in
                    calls += 1
                    withUnsafeCurrentTask { $0?.cancel() }
                    throw NSError(domain: "com.apple.CoreML", code: 0)
                }
                Issue.record("A cancelled load unexpectedly succeeded")
            } catch is CancellationError {
            } catch {
                Issue.record("Cancellation was wrapped: \(error)")
            }
            return calls
        }
        #expect(await task.value == 1)
        #expect(await progress.snapshot().count == 1)
    }

    @Test func cancellationFromRetryProgressSkipsTheRetryOperation() async throws {
        let progress = Attempts()
        let task = Task {
            var calls = 0
            do {
                let _: Int = try await PocketTtsModelLoader.load(
                    component: "cond_prefill.mlmodelc", units: .all,
                    progress: { attempt in
                        await progress.append(attempt)
                        if attempt.retry { withUnsafeCurrentTask { $0?.cancel() } }
                    }
                ) { _ in
                    calls += 1
                    throw NSError(domain: "com.apple.CoreML", code: 0)
                }
                Issue.record("A cancelled retry unexpectedly succeeded")
            } catch is CancellationError {
            } catch {
                Issue.record("Cancellation was wrapped: \(error)")
            }
            return calls
        }
        #expect(await task.value == 1)
        let attempts = await progress.snapshot()
        #expect(attempts.map(\.retry) == [false, true])
    }

    @Test func cancellationAfterSuccessfulOperationDiscardsResult() async throws {
        let task = Task {
            try await PocketTtsModelLoader.load(component: "cond_prefill.mlmodelc", units: .all) { _ in
                withUnsafeCurrentTask { $0?.cancel() }
                return 1
            }
        }
        do {
            _ = try await task.value
            Issue.record("A cancelled task published its model result")
        } catch is CancellationError {
        } catch {
            Issue.record("Cancellation was wrapped: \(error)")
        }
    }
}
