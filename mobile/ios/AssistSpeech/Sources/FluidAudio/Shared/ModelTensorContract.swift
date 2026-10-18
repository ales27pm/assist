@preconcurrency import CoreML
import Foundation

/// The raw Float readers below must not infer storage layout from element count.
/// A manifest or a successful Core ML load is not a tensor compatibility check.
enum ModelTensorContract {
    static func failure(_ role: String) -> NSError {
        NSError(domain: "FluidAudio.ModelTensorContract", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Incompatible local model tensor: \(role)"])
    }

    static func validateShape(_ shape: [Int], count: Int, role: String) throws {
        guard count > 0, !shape.isEmpty else { throw failure(role) }
        var elements = 1
        for dimension in shape {
            guard dimension > 0, elements <= count / dimension else { throw failure(role) }
            elements *= dimension
        }
        guard elements == count else { throw failure(role) }
    }

    static func validateFloat32(_ array: MLMultiArray, count: Int, role: String) throws {
        let shape = array.shape.map(\.intValue)
        guard array.dataType == .float32, array.count == count,
              shape.count == array.strides.count else { throw failure(role) }
        try validateShape(shape, count: count, role: role)
        var stride = 1
        for axis in shape.indices.reversed() {
            // A singleton axis never changes the address. Core ML may pad its
            // stride without changing the contiguous logical values we read.
            if shape[axis] > 1, array.strides[axis].intValue != stride { throw failure(role) }
            stride *= shape[axis] // validateShape already bounded this product.
        }
    }

    static func float32Values(_ array: MLMultiArray, count: Int, role: String) throws -> [Float] {
        try validateFloat32(array, count: count, role: role)
        let pointer = array.dataPointer.assumingMemoryBound(to: Float.self)
        return Array(UnsafeBufferPointer(start: pointer, count: count))
    }

    static func validateFloat32Description(_ feature: MLFeatureDescription?, count: Int,
                                           shape: [Int]? = nil, role: String) throws {
        guard let feature, feature.type == .multiArray,
              let constraint = feature.multiArrayConstraint, constraint.dataType == .float32 else {
            throw failure(role)
        }
        let actual = constraint.shape.map(\.intValue)
        try validateShape(actual, count: count, role: role)
        if let shape, actual != shape { throw failure(role) }
    }

    static func uniqueName(in names: Set<String>, containing token: String, role: String) throws -> String {
        let matches = names.filter { $0.lowercased().contains(token.lowercased()) }
        guard matches.count == 1, let name = matches.first else { throw failure(role) }
        return name
    }

    static func flowOutputName(in names: Set<String>) throws -> String {
        if names.contains("latent_final") { return "latent_final" }
        guard names.count == 1, let name = names.first else { throw failure("PocketTTS flow output") }
        return name
    }
}
