@preconcurrency import CoreML
import Foundation
import OSLog

/// Bounded metadata around explicitly named Core ML predictions. The observer
/// is copied while locked, then awaited outside the lock before submission so
/// the host can persist a breadcrumb even if Core ML raises a fatal exception.
public enum CoreMLPredictionDiagnostics {
    public struct TensorMetadata: Sendable {
        public let name: String
        public let shape: [Int]
        public let dataType: String
        public let count: Int

        public init(name: String, shape: [Int], dataType: String, count: Int) {
            self.name = name; self.shape = shape; self.dataType = dataType; self.count = count
        }
    }

    public struct Event: Sendable {
        public let id: String
        public let component: String
        public let state: String
        public let computeUnits: String
        public let inputs: [TensorMetadata]
        public let inputFeatureCount: Int
        public let metadataTruncated: Bool

        public init(id: String, component: String, state: String, computeUnits: String,
                    inputs: [TensorMetadata], inputFeatureCount: Int, metadataTruncated: Bool) {
            self.id = id; self.component = component; self.state = state; self.computeUnits = computeUnits
            self.inputs = inputs; self.inputFeatureCount = inputFeatureCount
            self.metadataTruncated = metadataTruncated
        }
    }

    private static let observerStorage = OSAllocatedUnfairLock<(@Sendable (Event) async -> Void)?>(initialState: nil)

    public static var observer: (@Sendable (Event) async -> Void)? {
        get { observerStorage.withLock { $0 } }
        set { observerStorage.withLock { $0 = newValue } }
    }

    /// Internal prediction seam: tests inject a model-free boundary while the
    /// production compat wrapper supplies the actual asynchronous Core ML call.
    static func withPrediction<T>(
        component: String?, computeUnits: MLComputeUnits, input: MLFeatureProvider,
        isolation: isolated (any Actor)? = #isolation,
        operation: nonisolated(nonsending) () async throws -> T
    ) async throws -> T {
        try Task.checkCancellation()
        guard let component, let capturedObserver = observer, inputNames(for: component) != nil else {
            return try await operation()
        }
        let metadata = inputMetadata(from: input, component: component)
        let id = UUID().uuidString
        let units = computeLabel(computeUnits)
        let event: (String) -> Event = { state in
            Event(id: id, component: component, state: state, computeUnits: units,
                  inputs: metadata.inputs, inputFeatureCount: metadata.count, metadataTruncated: metadata.truncated)
        }
        await capturedObserver(event("began"))
        do {
            // The persisted breadcrumb may itself suspend. Cancellation during
            // that wait must not submit work that was already cancelled.
            try Task.checkCancellation()
            let result = try await operation()
            await capturedObserver(event("completed"))
            return result
        } catch {
            await capturedObserver(event("failed"))
            throw error
        }
    }

    static func inputMetadata(
        from input: MLFeatureProvider, component: String
    ) -> (inputs: [TensorMetadata], count: Int, truncated: Bool) {
        guard let candidates = inputNames(for: component) else { return ([], 0, false) }
        let names = input.featureNames
        var tensors: [TensorMetadata] = []
        var truncated = names.count > 128
        for name in candidates where names.contains(name) {
            guard tensors.count < 8 else { truncated = true; break }
            guard let array = input.featureValue(for: name)?.multiArrayValue else {
                truncated = true
                continue
            }
            let shape = array.shape
            let metadata = boundedTensor(name: name, shape: shape.prefix(8).map(\.intValue),
                                         dataType: array.dataType, count: array.count)
            tensors.append(metadata.tensor)
            truncated = truncated || shape.count > 8 || metadata.truncated
        }
        return (tensors, min(names.count, 128), truncated || names.count > tensors.count)
    }

    static func boundedTensor(
        name: String, shape: [Int], dataType: MLMultiArrayDataType, count: Int
    ) -> (tensor: TensorMetadata, truncated: Bool) {
        let maximum = Int(Int32.max)
        let dimensions = shape.prefix(8).map { min(maximum, max(0, $0)) }
        let boundedCount = min(maximum, max(0, count))
        let label: String
        switch dataType {
        case .float16: label = "float16"
        case .float32: label = "float32"
        case .double: label = "float64"
        case .int32: label = "int32"
        default: label = "other"
        }
        return (TensorMetadata(name: name, shape: dimensions, dataType: label, count: boundedCount),
                shape.count > 8 || dimensions != shape || boundedCount != count)
    }

    private static let knownInputNames: [String: [String]] = {
        let caches = (0..<24).flatMap { ["cache\($0)", "k_cache\($0)", "v_cache\($0)", "position\($0)"] }
        return [
            "pocket.conditioner": ["conditioning", "valid_len"] + caches,
            "pocket.flowlm": ["sequence", "bos_emb"] + caches,
            "pocket.flow": ["transformer_out", "latent_init"],
            // Exact PocketTtsMimiKeys canonicalStateOrder, plus latent. Never
            // serialize arbitrary model-discovered state or output names.
            "pocket.mimi": [
                "latent", "upsample_partial", "attn0_cache", "attn0_offset", "attn1_cache", "attn1_offset",
                "conv0_prev", "conv0_first", "convtr0_partial",
                "res0_conv0_prev", "res0_conv0_first", "res0_conv1_prev", "res0_conv1_first", "convtr1_partial",
                "res1_conv0_prev", "res1_conv0_first", "res1_conv1_prev", "res1_conv1_first", "convtr2_partial",
                "res2_conv0_prev", "res2_conv0_first", "res2_conv1_prev", "res2_conv1_first",
                "conv_final_prev", "conv_final_first",
            ],
            "parakeet.preprocessor": ["audio_signal", "audio_length"],
            "parakeet.encoder": ["mel", "mel_length", "audio_signal", "audio_length"],
        ]
    }()

    private static func inputNames(for component: String) -> [String]? {
        knownInputNames[component]
    }

    private static func computeLabel(_ units: MLComputeUnits) -> String {
        switch units {
        case .all: return "all"
        case .cpuOnly: return "cpuOnly"
        case .cpuAndGPU: return "cpuAndGPU"
        case .cpuAndNeuralEngine: return "cpuAndNeuralEngine"
        @unknown default: return "other"
        }
    }
}
