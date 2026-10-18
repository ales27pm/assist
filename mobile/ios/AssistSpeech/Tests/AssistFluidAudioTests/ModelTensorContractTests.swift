@preconcurrency import CoreML
import Foundation
import Testing
@testable import FluidAudio

@Suite("Local model tensor memory contracts")
@MainActor
struct ModelTensorContractTests {
    private func values(_ count: Int) -> [Float] {
        (0..<count).map { $0 == 0 ? -Float.zero : Float($0 - 64) / 8 }
    }

    private func array(_ count: Int, type: MLMultiArrayDataType = .float32) throws -> MLMultiArray {
        let array = try MLMultiArray(shape: [1, NSNumber(value: count)], dataType: type)
        for (index, value) in values(count).enumerated() { array[index] = NSNumber(value: value) }
        return array
    }

    private func stridedArray(_ count: Int, elementStride: Int, outerStride: Int = 256) throws -> MLMultiArray {
        let capacity = (count - 1) * elementStride + 1
        let pointer = UnsafeMutablePointer<Float>.allocate(capacity: capacity)
        pointer.initialize(repeating: 99, count: capacity)
        for (index, value) in values(count).enumerated() { pointer[index * elementStride] = value }
        return try MLMultiArray(dataPointer: pointer, shape: [1, NSNumber(value: count)], dataType: .float32,
                                strides: [NSNumber(value: outerStride), NSNumber(value: elementStride)],
                                deallocator: { pointer in pointer.assumingMemoryBound(to: Float.self).deallocate() })
    }

    private func vadProvider(probability: MLMultiArray? = nil, hidden: MLMultiArray? = nil,
                             cell: MLMultiArray? = nil, hiddenName: String = "new_hidden_state") throws -> MLDictionaryFeatureProvider {
        try MLDictionaryFeatureProvider(dictionary: [
            "vad_output": probability ?? array(1),
            hiddenName: hidden ?? array(128),
            "new_cell_state": cell ?? array(128),
        ])
    }

    @Test func contiguousFloat32CopiesPreserveEveryBitIncludingNegativeZero() throws {
        for count in [1, 32, 128, 1024] {
            let tensor = try array(count)
            let result = try ModelTensorContract.float32Values(tensor, count: count, role: "fixture")
            #expect(result.map(\.bitPattern) == values(count).map(\.bitPattern))
        }
    }

    @Test func dtypeAndExactLengthAreCheckedBeforePointerReads() throws {
        for type in [MLMultiArrayDataType.float16, .double, .int32] {
            let tensor = try array(32, type: type)
            #expect(throws: NSError.self) {
                try ModelTensorContract.float32Values(tensor, count: 32, role: "fixture")
            }
        }
        for count in [1, 31, 33, 127, 129, 1023, 1025] {
            let tensor = try array(count)
            let expected = count < 100 ? 32 : (count < 200 ? 128 : 1024)
            #expect(throws: NSError.self) {
                try ModelTensorContract.float32Values(tensor, count: expected, role: "fixture")
            }
        }
    }

    @Test func singletonPaddingIsAcceptedButNonContiguousLogicalStorageIsRejected() throws {
        let contiguous = try stridedArray(32, elementStride: 1, outerStride: 256)
        #expect(try ModelTensorContract.float32Values(contiguous, count: 32, role: "fixture").map(\.bitPattern)
                == values(32).map(\.bitPattern))
        let interleaved = try stridedArray(32, elementStride: 2)
        #expect(throws: NSError.self) {
            try ModelTensorContract.float32Values(interleaved, count: 32, role: "fixture")
        }
        // The old 32-Float flat read was safe within this allocation, but read
        // filler instead of the tensor's logical elements. No UB is needed to
        // demonstrate why count and dtype alone are not sufficient.
        let former = Array(UnsafeBufferPointer(start: interleaved.dataPointer.assumingMemoryBound(to: Float.self), count: 32))
        #expect(former.map(\.bitPattern) != values(32).map(\.bitPattern))
    }

    @Test func shapeProductValidationRejectsOverflowAndInvalidDimensions() {
        for shape in [[], [0, 32], [-1, -32], [Int.max, 32], [2, 15]] {
            #expect(throws: NSError.self) { try ModelTensorContract.validateShape(shape, count: 32, role: "fixture") }
        }
    }

    @Test func vadReadsExactStateAndScalarValuesWithUnambiguousSuffixNames() throws {
        let provider = try vadProvider(hiddenName: "new_hidden_state_12")
        let result = try VadManager.checkedOutputValues(provider)
        #expect(result.0.bitPattern == values(1)[0].bitPattern)
        #expect(result.1.map(\.bitPattern) == values(128).map(\.bitPattern))
        #expect(result.2.map(\.bitPattern) == values(128).map(\.bitPattern))
        let scalar = try MLMultiArray(shape: [1, 1, 1], dataType: .float32)
        scalar[0] = 0.75
        #expect(try VadManager.checkedOutputValues(vadProvider(probability: scalar)).0 == 0.75)
    }

    @Test func vadRejectsShortWrongDtypeAndStridedStates() throws {
        let invalid = [try array(127), try array(129), try array(128, type: .float16),
                       try stridedArray(128, elementStride: 2)]
        for state in invalid {
            let hidden = try vadProvider(hidden: state)
            #expect(throws: NSError.self) { try VadManager.checkedOutputValues(hidden) }
            let cell = try vadProvider(cell: state)
            #expect(throws: NSError.self) { try VadManager.checkedOutputValues(cell) }
        }
        let probability = try vadProvider(probability: array(1, type: .double))
        #expect(throws: NSError.self) { try VadManager.checkedOutputValues(probability) }
        let ambiguous = try MLDictionaryFeatureProvider(dictionary: [
            "vad_output": array(1), "new_hidden_state": array(128),
            "other_new_hidden_state": array(128), "new_cell_state": array(128),
        ])
        #expect(throws: NSError.self) { try VadManager.checkedOutputValues(ambiguous) }
    }

    @Test func pocketFlowPreservesNamedAndSoleOutputValues() throws {
        for name in ["latent_final", "generated_name_7"] {
            let provider = try MLDictionaryFeatureProvider(dictionary: [name: array(32)])
            #expect(try PocketTtsSynthesizer.checkedFlowOutput(provider).map(\.bitPattern)
                    == values(32).map(\.bitPattern))
        }
    }

    @Test func pocketFlowRejectsWrongStorageAndAmbiguousFallbacks() throws {
        for tensor in [try array(31), try array(33), try array(32, type: .float16),
                       try stridedArray(32, elementStride: 2)] {
            let provider = try MLDictionaryFeatureProvider(dictionary: ["latent_final": tensor])
            #expect(throws: NSError.self) { try PocketTtsSynthesizer.checkedFlowOutput(provider) }
        }
        let ambiguous = try MLDictionaryFeatureProvider(dictionary: ["first": array(32), "second": array(32)])
        #expect(throws: NSError.self) { try PocketTtsSynthesizer.checkedFlowOutput(ambiguous) }
    }
}
