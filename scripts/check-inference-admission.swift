import Dispatch
import Foundation
import Synchronization

private actor AdmissionBarrier {
    private var entered = false
    private var entry: CheckedContinuation<Void, Never>?
    private var continuation: CheckedContinuation<Void, Never>?
    func block() async {
        entered = true
        entry?.resume(); entry = nil
        await withCheckedContinuation { continuation = $0 }
    }
    func waitForEntry() async {
        if !entered { await withCheckedContinuation { entry = $0 } }
    }
    func release() { continuation?.resume(); continuation = nil }
}

/// A stand-in only for the synchronous, non-preemptible tokenizer call.
private final class PreparationBarrier: Sendable {
    private let entered = Mutex(false)
    private let releaseSignal = DispatchSemaphore(value: 0)
    var hasEntered: Bool { entered.withLock { $0 } }
    func block() { entered.withLock { $0 = true }; releaseSignal.wait() }
    func release() { releaseSignal.signal() }
}

private actor PreparationOwner {
    private var busy = false
    private var computed = 0
    func status() -> (Bool, Int) { (busy, computed) }
    func run(_ admission: AssistAgentAdmission, barrier: PreparationBarrier) async throws {
        try admission.check()
        precondition(!busy)
        busy = true
        defer { busy = false }
        _ = try await AssistInferencePreparation.perform(check: { try admission.check() }) {
            barrier.block()
            return 42
        }
        computed += 1
    }
}

private final class Counter: Sendable {
    private let count = Mutex(0)
    var value: Int { count.withLock { $0 } }
    func increment() { count.withLock { $0 += 1 } }
}

/// A suspended SDK boundary that deliberately ignores Task cancellation until
/// its explicit stop is called. No model, tokenizer or device is involved.
private actor DeadlineEngineProbe {
    enum Failure: Error { case engine }
    private var entered = false
    private var entryWaiter: CheckedContinuation<Void, Never>?
    private var work: CheckedContinuation<Void, Never>?
    private var cancellations = 0
    private var drained = false
    func generate(value: String = "cancelled-partial", failAfterStop: Bool = false) async throws -> String {
        entered = true
        entryWaiter?.resume(); entryWaiter = nil
        await withCheckedContinuation { work = $0 }
        drained = true
        if failAfterStop { throw Failure.engine }
        return value
    }
    func waitForEntry() async {
        if !entered { await withCheckedContinuation { entryWaiter = $0 } }
    }
    func cancel() {
        cancellations += 1
        work?.resume(); work = nil
    }
    func state() -> (Int, Bool) { (cancellations, drained) }
}

@main
struct InferenceAdmissionChecks {
    static func main() async throws {
        var checks = 0
        func expect(_ condition: Bool, _ description: String) throws {
            guard condition else { throw AssistInferenceError.invalid("FAIL: \(description)") }
            checks += 1
        }
        func cancelled(_ result: Result<Void, any Error>) throws {
            guard case .failure(let error) = result, error is CancellationError else {
                throw AssistInferenceError.invalid("FAIL: expected cancellation")
            }
            checks += 1
        }

        // The bridge creates this identity before launching its asynchronous
        // admission. Force cancellation to win that exact scheduling race.
        let admission = AssistAgentAdmission()
        let barrier = AdmissionBarrier()
        let preparation = Counter()
        let compute = Counter()
        let acknowledgement = Counter()
        let operation = Task {
            defer { admission.finish() }
            await barrier.block()
            _ = try await AssistInferencePreparation.perform(check: { try admission.check() }) {
                preparation.increment()
                return 42
            }
            compute.increment()
        }
        await barrier.waitForEntry()
        admission.cancel()
        let cancel = Task { await admission.waitForFinish(); acknowledgement.increment() }
        try expect(!admission.isFinished && acknowledgement.value == 0,
                   "revocation is not a drain acknowledgement")
        await barrier.release()
        try cancelled(await operation.result)
        await cancel.value
        try expect(preparation.value == 0 && compute.value == 0,
                   "cancel before admission prevents preparation and engine submission")
        try expect(acknowledgement.value == 1 && admission.isFinished,
                   "cancel acknowledges only after the exact operation has drained")

        // Tokenization may not be preemptible. The owner must nevertheless
        // answer status/cancel, hold ownership, and discard its result on cancel.
        let active = AssistAgentAdmission()
        let blockedPreparation = PreparationBarrier()
        let owner = PreparationOwner()
        let activeOperation = Task {
            defer { active.finish() }
            try await owner.run(active, barrier: blockedPreparation)
        }
        while !blockedPreparation.hasEntered { await Task.yield() }
        let statusDuringPreparation = await owner.status()
        try expect(statusDuringPreparation == (true, 0),
                   "owner remains responsive and exclusively busy during preparation")
        active.cancel()
        activeOperation.cancel()
        try expect(!active.isFinished, "cancel does not release ownership during synchronous preparation")
        blockedPreparation.release()
        try cancelled(await activeOperation.result)
        await active.waitForFinish()
        try expect(await owner.status() == (false, 0),
                   "late tokenization result never reaches the engine and ownership drains")

        let normal = AssistAgentAdmission()
        let output = try await AssistInferencePreparation.perform(check: { try normal.check() }) { [32_256, 32_768] }
        try expect(output == [32_256, 32_768], "uncancelled preparation preserves complete output")

        let startedCount = Counter(), stoppedCount = Counter()
        do {
            let _: Int = try await AssistInferenceDeadline.run(until: ContinuousClock.now.advanced(by: .seconds(-1)),
                operation: { startedCount.increment(); return 1 }, cancelOperation: { stoppedCount.increment() })
            throw DeadlineEngineProbe.Failure.engine
        } catch is AssistInferenceError { checks += 1 }
        try expect(startedCount.value == 0 && stoppedCount.value == 0,
                   "an expired budget cannot submit or stop a model operation")
        let complete = try await AssistInferenceDeadline.run(until: ContinuousClock.now.advanced(by: .seconds(30)),
            operation: { 42 }, cancelOperation: { stoppedCount.increment() })
        try expect(complete == 42 && stoppedCount.value == 0,
                   "normal completion drains its timer without a late SDK cancellation")

        let timed = DeadlineEngineProbe()
        do {
            _ = try await AssistInferenceDeadline.run(until: ContinuousClock.now.advanced(by: .seconds(2)),
                operation: { try await timed.generate() }, cancelOperation: { await timed.cancel() },
                acceptCancelledValue: { _ in true })
            throw DeadlineEngineProbe.Failure.engine
        } catch is AssistInferenceError { checks += 1 }
        try expect(await timed.state() == (1, true),
                   "deadline stops a prefill with no output and waits for drain; it never accepts a timed-out result")

        for retainPartial in [false, true] {
            let engine = DeadlineEngineProbe()
            let request = Task {
                try await AssistInferenceDeadline.run(until: ContinuousClock.now.advanced(by: .seconds(30)),
                    operation: { try await engine.generate() }, cancelOperation: { await engine.cancel() },
                    acceptCancelledValue: { retainPartial && $0 == "cancelled-partial" })
            }
            await engine.waitForEntry()
            request.cancel()
            let result = await request.result
            if retainPartial {
                guard case .success(let text) = result else { throw DeadlineEngineProbe.Failure.engine }
                try expect(text == "cancelled-partial", "only an explicit public cancelled partial can be retained")
            } else {
                guard case .failure(let error) = result, error is CancellationError else {
                    throw DeadlineEngineProbe.Failure.engine
                }
                checks += 1
            }
            try expect(await engine.state() == (1, true), "cancellation acknowledgement follows SDK stop and drain")
            let next = try await AssistInferenceDeadline.run(until: ContinuousClock.now.advanced(by: .seconds(30)),
                operation: { "new-owner" }, cancelOperation: { await engine.cancel() })
            let finalState = await engine.state()
            try expect(next == "new-owner" && finalState == (1, true),
                       "no cancellation callback escapes into the next owner")
        }

        let misleading = DeadlineEngineProbe()
        let misleadingRequest = Task {
            try await AssistInferenceDeadline.run(until: ContinuousClock.now.advanced(by: .seconds(30)),
                operation: { try await misleading.generate(value: "eos-success") },
                cancelOperation: { await misleading.cancel() }, acceptCancelledValue: { $0 == "cancelled-partial" })
        }
        await misleading.waitForEntry(); misleadingRequest.cancel()
        if case .failure(let error) = await misleadingRequest.result, error is CancellationError { checks += 1 }
        else { throw DeadlineEngineProbe.Failure.engine }

        let failed = DeadlineEngineProbe()
        let failingRequest = Task {
            try await AssistInferenceDeadline.run(until: ContinuousClock.now.advanced(by: .seconds(30)),
                operation: { try await failed.generate(failAfterStop: true) },
                cancelOperation: { await failed.cancel() }, acceptCancelledValue: { _ in true })
        }
        await failed.waitForEntry(); failingRequest.cancel()
        if case .failure(let error) = await failingRequest.result, error is DeadlineEngineProbe.Failure { checks += 1 }
        else { throw DeadlineEngineProbe.Failure.engine }
        try expect(await failed.state() == (1, true), "engine failure while draining cannot become an accepted partial")

        let failedAtDeadline = DeadlineEngineProbe()
        do {
            _ = try await AssistInferenceDeadline.run(until: ContinuousClock.now.advanced(by: .seconds(2)),
                operation: { try await failedAtDeadline.generate(failAfterStop: true) },
                cancelOperation: { await failedAtDeadline.cancel() }, acceptCancelledValue: { _ in true })
            throw AssistInferenceError.invalid("FAIL: expected engine failure after deadline")
        } catch is DeadlineEngineProbe.Failure { checks += 1 }
        try expect(await failedAtDeadline.state() == (1, true),
                   "engine failure during deadline drain is preserved instead of a recoverable policy rejection")
        print("\(checks) inference admission/preparation/deadline checks passed (no Core AI SDK or iPhone claim).")
    }
}
