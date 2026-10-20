import Foundation
import Dispatch

@MainActor
private final class CallbackProbe {
    private var pending: Result<[String], any Error>?
    private var waiter: CheckedContinuation<Result<[String], any Error>, Never>?
    private(set) var deliveries = 0
    func receive(_ value: Result<[String], any Error>) {
        MainActor.preconditionIsolated()
        deliveries += 1
        if let waiter { self.waiter = nil; waiter.resume(returning: value) }
        else { pending = value }
    }
    func next() async -> Result<[String], any Error> {
        if let pending { self.pending = nil; return pending }
        return await withCheckedContinuation { waiter = $0 }
    }
}

@main
struct SpotlightCallbackChecks {
    typealias Boundary = AssistSpotlightCallbackBoundary
    struct Item: Sendable { let id: String; let domain: String? }
    private nonisolated static let domain = "org.27pm.assist.selected-documents.v1"

    /// Execute the production callback itself on a real foreign dispatch queue,
    /// not an actor-bound callback double. Swift actor checks stay enabled.
    nonisolated static func onFrameworkQueue(_ operation: @escaping @Sendable () -> Void) async {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                dispatchPrecondition(condition: .notOnQueue(.main))
                operation(); continuation.resume()
            }
        }
    }

    @MainActor
    static func main() async throws {
        var checks = 0
        func expect(_ value: @autoclosure () -> Bool, _ message: String) throws {
            guard value() else { throw NSError(domain: "SpotlightCallbackChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
            checks += 1
        }
        let allowed: Set<String> = ["own-a", "own-b", "own-c"]

        // Empty-index completion was sufficient to trigger the shipped crash.
        let empty = Boundary.Query(allowed: [], domain: domain, limit: 10)
        let emptyProbe = CallbackProbe()
        let emptyCompletion = Boundary.completion(query: empty) { @MainActor value in emptyProbe.receive(value) }
        await onFrameworkQueue { emptyCompletion(nil); emptyCompletion(nil) }
        let emptyRows = try await emptyProbe.next().get()
        try expect(emptyRows.isEmpty && emptyProbe.deliveries == 1, "empty-index completion crosses from the framework queue exactly once")

        let query = Boundary.Query(allowed: allowed, domain: domain, limit: 2)
        let probe = CallbackProbe()
        let found = Boundary.foundItems(query: query, identify: { @Sendable (item: Item) in
            .init(id: item.id, domain: item.domain)
        })
        let completion = Boundary.completion(query: query) { @MainActor value in probe.receive(value) }
        await onFrameworkQueue {
            found([Item(id: "foreign", domain: domain), Item(id: "own-a", domain: "other.app"),
                   Item(id: "own-a", domain: domain), Item(id: "own-a", domain: domain),
                   Item(id: "own-b", domain: domain), Item(id: "own-c", domain: domain)])
            completion(nil)
            found([Item(id: "own-a", domain: domain)])
            completion(NSError(domain: "LateFrameworkError", code: 9))
        }
        let rows = try await probe.next().get()
        try expect(rows == ["own-a", "own-b", "own-c"], "only owned-domain allowlisted unique IDs survive; one extra match proves truncation")
        try expect(probe.deliveries == 1, "late result/error cannot resume the query again")

        // Deliberately contend the same production mutex accumulator and finish
        // gate from several foreign queues. No MainActor assumptions are used.
        let manyIDs = Set((0..<30).map { "owned-\($0)" })
        for pass in 0..<20 {
            let session = Boundary.Query(allowed: manyIDs, domain: domain, limit: 3)
            let recipient = CallbackProbe()
            let batches = Boundary.foundItems(query: session, identify: { @Sendable (item: Item) in .init(id: item.id, domain: item.domain) })
            let finish = Boundary.completion(query: session) { @MainActor value in recipient.receive(value) }
            await withTaskGroup(of: Void.self) { group in
                for worker in 0..<8 {
                    group.addTask {
                        await onFrameworkQueue {
                            batches((0..<30).map { Item(id: "owned-\(($0 + worker + pass) % 30)", domain: domain) })
                        }
                    }
                }
            }
            await withTaskGroup(of: Void.self) { group in
                for _ in 0..<8 { group.addTask { await onFrameworkQueue { finish(nil) } } }
            }
            let values = try await recipient.next().get()
            try expect(values.count == 4 && Set(values).count == 4 && Set(values).isSubset(of: manyIDs), "concurrent batches remain bounded and owned")
            try expect(recipient.deliveries == 1, "concurrent completion callbacks deliver exactly once")
        }

        let cancelled = Boundary.Query(allowed: allowed, domain: domain, limit: 2)
        let cancelledProbe = CallbackProbe()
        let cancelledFound = Boundary.foundItems(query: cancelled, identify: { @Sendable (item: Item) in .init(id: item.id, domain: item.domain) })
        let cancelledCompletion = Boundary.completion(query: cancelled) { @MainActor value in cancelledProbe.receive(value) }
        cancelled.cancel()
        await onFrameworkQueue {
            cancelledFound([Item(id: "own-a", domain: domain)])
            cancelledCompletion(nil); cancelledCompletion(NSError(domain: "Late", code: 1))
        }
        try expect(cancelledProbe.deliveries == 0, "cancel revokes accumulation and completion before a late callback entrance")
        try expect(cancelled.finish(error: nil) == nil, "cancelled query cannot publish a later result")

        let failed = Boundary.Query(allowed: allowed, domain: domain, limit: 1)
        let failedProbe = CallbackProbe()
        let failedCompletion = Boundary.completion(query: failed) { @MainActor value in failedProbe.receive(value) }
        await onFrameworkQueue { failedCompletion(NSError(domain: "FrameworkFailure", code: 17)); failedCompletion(nil) }
        switch await failedProbe.next() {
        case .success: throw NSError(domain: "SpotlightCallbackChecks", code: 2)
        case .failure(let error): try expect((error as NSError).code == 17 && failedProbe.deliveries == 1, "framework failure survives the actor hop and cannot become a late success")
        }

        // Index/delete continuations use this same nonisolated production
        // acknowledgement factory; test real foreign-queue resume and duplicates.
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            let acknowledge = Boundary.acknowledgement(continuation)
            DispatchQueue.global().async { acknowledge(nil); acknowledge(nil) }
        }
        checks += 1
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                let acknowledge = Boundary.acknowledgement(continuation)
                DispatchQueue.global().async { acknowledge(NSError(domain: "IndexFailure", code: 19)); acknowledge(nil) }
            }
            throw NSError(domain: "SpotlightCallbackChecks", code: 3)
        } catch { try expect((error as NSError).code == 19, "index/delete acknowledgement preserves one framework error without double resume") }

        print("PASS: \(checks) production Spotlight callback concurrency checks on foreign DispatchQueues with Swift actor checks; no CoreSpotlight/device qualification.")
    }
}
