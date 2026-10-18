@preconcurrency import CoreML
import Foundation
import Testing
@testable import FluidAudio

@Suite("Pocket session voice conditioning ownership")
@MainActor
struct SessionVoiceConditioningTests {
    private func snapshot(layers: Int = 2, length: Int = 3) -> PocketTtsVoiceCacheSnapshot {
        let count = 2 * length * 16 * 64
        return PocketTtsVoiceCacheSnapshot(layers: (0..<layers).map { layer in
            .init(cache: (0..<count).map { Float(($0 + layer * 17) % 113 - 56) / 16 }, offset: length)
        }, cacheSeqLen: length)
    }

    private func bytes(_ array: MLMultiArray) -> Data {
        let stride = array.dataType == .float16 ? MemoryLayout<UInt16>.size : MemoryLayout<Float>.size
        return Data(bytes: array.dataPointer, count: array.count * stride)
    }

    private func equalState(_ actual: PocketTtsSynthesizer.KVCacheState,
                            _ expected: PocketTtsSynthesizer.KVCacheState) {
        #expect(actual.caches.count == expected.caches.count)
        #expect(actual.vCaches?.count == expected.vCaches?.count)
        let actualArrays = actual.caches + (actual.vCaches ?? []) + actual.positions
        let expectedArrays = expected.caches + (expected.vCaches ?? []) + expected.positions
        #expect(actualArrays.count == expectedArrays.count)
        for (left, right) in zip(actualArrays, expectedArrays) {
            #expect(left.shape == right.shape)
            #expect(left.dataType == right.dataType)
            #expect(bytes(left) == bytes(right))
            #expect(left !== right)
        }
    }

    @Test func presetDoesNotRetainAnExpandedCoreMLCache() throws {
        let source = snapshot()
        let conditioning = try PocketTtsSynthesizer.SessionVoiceConditioning.presetSnapshot(
            source, layers: 2, splitKV: false)
        guard case .preset(let retained, let layers, let split) = conditioning else {
            Issue.record("A preset must retain its compact baked prefix, not an extra expanded full-capacity KV cache")
            return
        }
        #expect(retained.layers.count == 2 && layers == 2 && !split)
        #expect(retained.cacheSeqLen == 3)
        #expect(conditioning.position == 3)
    }

    @Test func presetWorkingStateIsBitExactToTheFormerExpandedThenClonedPath() throws {
        for split in [false, true] {
            let source = snapshot()
            let formerPrefix = try PocketTtsSynthesizer.kvCacheStateFromSnapshot(source, layers: 2, splitKV: split)
            let formerWorking = try PocketTtsSynthesizer.cloneKVCacheState(formerPrefix)
            let conditioning = try PocketTtsSynthesizer.SessionVoiceConditioning.presetSnapshot(source, layers: 2, splitKV: split)
            let working = try conditioning.makeWorkingState()
            equalState(working, formerWorking)
            #expect(try PocketTtsSynthesizer.kvCachePosition(in: working) == 3)
            // Independent calculation checks K/V placement and zero padding,
            // including the far end of the unchanged 512-position capacity.
            let block = PocketTtsConstants.kvCacheMaxLen * 16 * 64
            let prefix = 3 * 16 * 64
            for layer in 0..<2 {
                let k = working.caches[layer]
                #expect(k.dataType == .float32)
                #expect(k[0].floatValue == source.layers[layer].cache[0])
                #expect(k[prefix].floatValue == 0)
                #expect(k[block - 1].floatValue == 0)
                let v = split ? working.vCaches![layer] : k
                let base = split ? 0 : block
                #expect(v[base].floatValue == source.layers[layer].cache[prefix])
                #expect(v[base + prefix].floatValue == 0)
                #expect(v[base + block - 1].floatValue == 0)
            }
        }
    }

    @Test func chunksAreIndependentAndTheirWorkingArraysAreNotRetainedByThePrefix() throws {
        let source = snapshot(layers: 1)
        let conditioning = try PocketTtsSynthesizer.SessionVoiceConditioning.presetSnapshot(source, layers: 1, splitKV: false)
        weak var released: MLMultiArray?
        try autoreleasepool {
            let first = try conditioning.makeWorkingState()
            released = first.caches[0]
            first.caches[0][0] = 999
            first.positions[0][0] = 100
        }
        #expect(released == nil)
        let second = try conditioning.makeWorkingState()
        #expect(second.caches[0][0].floatValue == source.layers[0].cache[0])
        #expect(second.positions[0][0].intValue == 3)
    }

    @Test func invalidPresetsStillFailBeforeConstructingTheSession() throws {
        let source = snapshot(layers: 1)
        #expect(throws: PocketTTSError.self) {
            try PocketTtsSynthesizer.SessionVoiceConditioning.presetSnapshot(source, layers: 2, splitKV: false)
        }
        let oversized = PocketTtsVoiceCacheSnapshot(layers: source.layers, cacheSeqLen: 513)
        #expect(throws: PocketTTSError.self) {
            try PocketTtsSynthesizer.SessionVoiceConditioning.presetSnapshot(oversized, layers: 1, splitKV: false)
        }
        let truncated = PocketTtsVoiceCacheSnapshot(layers: [.init(cache: [0], offset: 3)], cacheSeqLen: 3)
        #expect(throws: PocketTTSError.self) {
            try PocketTtsSynthesizer.SessionVoiceConditioning.presetSnapshot(truncated, layers: 1, splitKV: false)
        }
    }

    @Test func prefilledClonePathStillCopiesTheOriginalDtypeAndStorage() throws {
        for dtype in [MLMultiArrayDataType.float16, .float32] {
            let array = try MLMultiArray(shape: [2, 1, 4, 16, 64], dataType: dtype)
            for index in 0..<array.count { array[index] = NSNumber(value: Float(index % 23) / 8) }
            let position = try MLMultiArray(shape: [1], dataType: .float32)
            position[0] = 3
            let original = PocketTtsSynthesizer.KVCacheState(caches: [array], vCaches: nil, positions: [position])
            let conditioning = PocketTtsSynthesizer.SessionVoiceConditioning.prefilled(original)
            let working = try conditioning.makeWorkingState()
            equalState(working, original)
            working.caches[0][0] = 99
            #expect(array[0].floatValue == 0)
            #expect(conditioning.position == 3)
        }
    }
}
