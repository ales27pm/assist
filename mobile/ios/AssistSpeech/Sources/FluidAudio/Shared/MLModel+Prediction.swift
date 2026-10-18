@preconcurrency import CoreML
import Foundation

extension MLModel {
    /// Compatibly call Core ML prediction using async API.
    public func compatPrediction(
        from input: MLFeatureProvider,
        options: MLPredictionOptions,
        component: String? = nil
    ) async throws -> MLFeatureProvider {
        try await CoreMLPredictionDiagnostics.withPrediction(
            component: component, computeUnits: configuration.computeUnits, input: input
        ) {
            try await prediction(from: input, options: options)
        }
    }
}
