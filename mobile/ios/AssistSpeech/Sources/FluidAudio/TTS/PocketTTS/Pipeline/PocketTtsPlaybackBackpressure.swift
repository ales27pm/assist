#if TTS
import Foundation

/// One producer, explicit playback credits. Waiting suspends a Swift task; it
/// never blocks a render thread or polls a clock. A session owns one gate.
actor PocketTtsPlaybackBackpressure {
    private var maximumFrames: Int?
    private var begun = false
    private var cancelled = false
    private var waiter: CheckedContinuation<Void, Error>?
    private(set) var outstandingFrames = 0
    var isWaiting: Bool { waiter != nil }

    func configure(maximumFrames: Int) throws {
        guard !begun, !cancelled, (1...192).contains(maximumFrames) else {
            throw PocketTTSError.processingFailed("Invalid or late PocketTTS playback budget")
        }
        self.maximumFrames = maximumFrames
    }

    func acquire() async throws {
        try Task.checkCancellation()
        guard !cancelled else { throw CancellationError() }
        begun = true
        guard let maximumFrames else { return }
        if outstandingFrames < maximumFrames {
            outstandingFrames += 1
            return
        }
        guard waiter == nil else {
            throw PocketTTSError.processingFailed("PocketTTS playback budget has multiple producers")
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if cancelled || Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    waiter = continuation
                }
            }
        } onCancel: {
            Task { await self.cancel() }
        }
        try Task.checkCancellation()
    }

    func acknowledge() {
        guard !cancelled, let maximumFrames else { return }
        if outstandingFrames > 0 { outstandingFrames -= 1 }
        if let waiting = waiter, outstandingFrames < maximumFrames {
            waiter = nil
            outstandingFrames += 1
            waiting.resume()
        }
    }

    func cancel() {
        cancelled = true
        outstandingFrames = 0
        let waiting = waiter
        waiter = nil
        waiting?.resume(throwing: CancellationError())
    }
}
#endif
