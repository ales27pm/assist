#if TTS
@preconcurrency import CoreML
import Foundation

/// One load attempt for the same local PocketTTS model and weights.
public struct PocketTtsModelLoadAttempt: Sendable {
    public let component: String
    public let computeUnits: String
    public let retry: Bool
}

/// Retries a Core ML load rejected under automatic placement on CPU/GPU once.
/// Explicit compute-unit choices and cancellation are never retried.
enum PocketTtsModelLoader {
    /// Inherit the caller's actor so an operation can return a non-Sendable
    /// Core ML object without introducing a different isolation domain.
    static func load<T>(
        component: String,
        units: MLComputeUnits,
        progress: (@Sendable (PocketTtsModelLoadAttempt) async -> Void)? = nil,
        isolation: isolated (any Actor)? = #isolation,
        operation: nonisolated(nonsending) (MLComputeUnits) async throws -> T
    ) async throws -> T {
        var currentUnits = units
        var retried = false

        while true {
            try Task.checkCancellation()
            if let progress {
                await progress(PocketTtsModelLoadAttempt(
                    component: component,
                    computeUnits: currentUnits.pocketTtsLabel,
                    retry: retried))
                try Task.checkCancellation()
            }

            do {
                try Task.checkCancellation()
                let result = try await operation(currentUnits)
                try Task.checkCancellation()
                return result
            } catch {
                if error is CancellationError { throw error }
                try Task.checkCancellation()

                let underlying = error as NSError
                if !retried, currentUnits == .all,
                    underlying.domain == "com.apple.CoreML" {
                    retried = true
                    currentUnits = .cpuAndGPU
                    continue
                }

                // Keep paths and localized descriptions in the underlying
                // error only. The app may expose these allowlisted fields.
                var context: [String: Any] = [
                    NSUnderlyingErrorKey: underlying,
                    "PocketTtsComponent": component,
                    "PocketTtsComputeUnits": currentUnits.pocketTtsLabel,
                    "PocketTtsRetried": retried,
                ]
                if retried {
                    context["PocketTtsInitialComputeUnits"] = units.pocketTtsLabel
                }
                throw NSError(
                    domain: "FluidAudio.PocketModelLoad",
                    code: underlying.code,
                    userInfo: context)
            }
        }
    }
}
#endif
