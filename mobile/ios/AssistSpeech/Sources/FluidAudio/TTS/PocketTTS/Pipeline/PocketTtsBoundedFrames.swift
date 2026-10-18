#if TTS
import Foundation

enum PocketTtsBoundedFrames {
    static func yield(
        _ frame: PocketTtsSynthesizer.AudioFrame,
        to continuation: AsyncThrowingStream<PocketTtsSynthesizer.AudioFrame, Error>.Continuation
    ) throws {
        switch continuation.yield(frame) {
        case .enqueued:
            return
        case .dropped:
            throw PocketTTSError.processingFailed("PocketTTS audio queue capacity exceeded")
        case .terminated:
            throw CancellationError()
        @unknown default:
            throw PocketTTSError.processingFailed("PocketTTS audio queue failed")
        }
    }
}
#endif
