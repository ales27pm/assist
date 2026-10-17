import Foundation
import Testing
@testable import FluidAudio

@Suite("Pocket playback backpressure")
struct PlaybackBackpressureTests {
    private func awaitBlocked(_ gate: PocketTtsPlaybackBackpressure) async -> Bool {
        for _ in 0..<1_000 {
            if await gate.isWaiting { return true }
            await Task.yield()
        }
        return false
    }

    @Test func ackReleasesExactlyOneBlockedFrame() async throws {
        let gate = PocketTtsPlaybackBackpressure()
        try await gate.configure(maximumFrames: 2)
        try await gate.acquire(); try await gate.acquire()
        let blocked = Task { try await gate.acquire() }
        try #require(await awaitBlocked(gate))
        #expect(await gate.outstandingFrames == 2)
        await gate.acknowledge()
        try await blocked.value
        #expect(await gate.outstandingFrames == 2)
        await gate.cancel()
    }

    @Test func cancellationWakesABlockedProducerWithoutAnAck() async throws {
        let gate = PocketTtsPlaybackBackpressure()
        try await gate.configure(maximumFrames: 1)
        try await gate.acquire()
        let blocked = Task { try await gate.acquire() }
        try #require(await awaitBlocked(gate))
        blocked.cancel()
        do { try await blocked.value; Issue.record("Cancelled producer resumed successfully") }
        catch is CancellationError { }
        #expect(await gate.isWaiting == false)
        #expect(await gate.outstandingFrames == 0)
    }

    @Test func explicitSessionCancelFencesLaterAcksAndAcquires() async throws {
        let gate = PocketTtsPlaybackBackpressure()
        try await gate.configure(maximumFrames: 1)
        try await gate.acquire()
        let blocked = Task { try await gate.acquire() }
        try #require(await awaitBlocked(gate))
        await gate.cancel()
        do { try await blocked.value; Issue.record("Session cancellation failed to release waiter") }
        catch is CancellationError { }
        await gate.acknowledge(); await gate.acknowledge()
        #expect(await gate.outstandingFrames == 0)
        do { try await gate.acquire(); Issue.record("Cancelled gate accepted a new frame") }
        catch is CancellationError { }
    }

    @Test func longFastProductionStaysWithinThePlayedFrameBudget() async throws {
        let gate = PocketTtsPlaybackBackpressure()
        try await gate.configure(maximumFrames: 3)
        let (frames, continuation) = AsyncThrowingStream<Int, Error>.makeStream(bufferingPolicy: .bufferingOldest(192))
        let producer = Task {
            do {
                for index in 0..<1_000 {
                    try await gate.acquire()
                    continuation.yield(index)
                }
                continuation.finish()
            } catch { continuation.finish(throwing: error) }
        }
        var count = 0
        for try await frame in frames {
            #expect(frame == count)
            #expect(await gate.outstandingFrames <= 3)
            count += 1
            await gate.acknowledge()
        }
        await producer.value
        #expect(count == 1_000)
        #expect(await gate.outstandingFrames == 0)
    }

    @Test func invalidAndLateBudgetsFailLocally() async throws {
        let gate = PocketTtsPlaybackBackpressure()
        do { try await gate.configure(maximumFrames: 0); Issue.record("Zero budget accepted") }
        catch is PocketTTSError { }
        do { try await gate.configure(maximumFrames: 193); Issue.record("Oversized budget accepted") }
        catch is PocketTTSError { }
        try await gate.acquire() // Default non-backpressured API remains available.
        do { try await gate.configure(maximumFrames: 1); Issue.record("Late budget accepted") }
        catch is PocketTTSError { }
    }
}
