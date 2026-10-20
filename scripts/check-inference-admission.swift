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
        print("\(checks) inference admission/preparation checks passed (no Core AI SDK or iPhone claim).")
    }
}
