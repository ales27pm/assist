import Foundation
import Testing
@testable import FluidAudio

@Suite("Assist offline Pocket contracts")
struct OfflinePocketTests {
    private func temporaryDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("assist-pocket-tests-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    @Test func rejectsNonlocalAndMissingRoots() throws {
        #expect(throws: PocketTTSError.self) {
            try PocketTtsOfflineAssets.validate(
                directory: URL(string: "https://example.invalid/pocket")!, precision: .int8, placement: .gpu)
        }
        #expect(throws: PocketTTSError.self) {
            try PocketTtsOfflineAssets.validate(
                directory: URL(fileURLWithPath: "/nonexistent/assist-\(UUID())"), precision: .int8, placement: .gpu)
        }
    }

    @Test func requiresTheExactLocalModelSetAndConstants() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let names = ModelNames.PocketTTS.requiredModels(precision: .int8, placement: .gpu)
        for name in names { try FileManager.default.createDirectory(at: root.appendingPathComponent(name), withIntermediateDirectories: true) }
        for name in ["bos_emb.bin", "bos_before_voice.bin", "text_embed_table.bin", "tokenizer.model"] {
            try Data([0]).write(to: root.appendingPathComponent("constants_bin").appendingPathComponent(name))
        }
        // Presence validation is separate from the app's SHA-256 manifest check
        // and Core ML's eventual program validation; these are fixture files.
        #expect(try PocketTtsOfflineAssets.validate(directory: root, precision: .int8, placement: .gpu) == root)
        try FileManager.default.removeItem(at: root.appendingPathComponent("constants_bin/bos_before_voice.bin"))
        #expect(throws: PocketTTSError.self) {
            try PocketTtsOfflineAssets.validate(directory: root, precision: .int8, placement: .gpu)
        }
    }

    @Test func packEncoderNeverFallsBackToTheEnglishEncoder() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("mimi_encoderv2.mlmodelc"), withIntermediateDirectories: true)
        #expect(throws: PocketTTSError.self) { try PocketTtsOfflineAssets.encoder(in: root) }
        let packEncoder = root.appendingPathComponent("mimi_encoderv3.mlmodelc")
        try FileManager.default.createDirectory(at: packEncoder, withIntermediateDirectories: true)
        #expect(try PocketTtsOfflineAssets.encoder(in: root).path == packEncoder.path)
    }

    @Test func missingAssetsFailThroughThePublicOfflineInitializer() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let manager = PocketTtsManager(offlineDirectory: root)
        do {
            try await manager.initialize()
            Issue.record("Missing local models unexpectedly initialized")
        } catch let error as PocketTTSError {
            guard case .modelNotFound = error else {
                Issue.record("Missing local model took a recovery/download error path")
                return
            }
        }
        #expect(await manager.isAvailable == false)
        do {
            _ = try await manager.cloneVoice(from: [Float](repeating: 0, count: 24_000))
            Issue.record("Missing local encoder unexpectedly cloned a voice")
        } catch let error as PocketTTSError {
            guard case .modelNotFound = error else {
                Issue.record("Missing local encoder took a recovery/download error path")
                return
            }
        }
    }

    @Test func aFullFrameQueueReportsAnErrorAndPreservesTheOldestFrame() async throws {
        let (stream, continuation) = AsyncThrowingStream<PocketTtsSynthesizer.AudioFrame, Error>.makeStream(bufferingPolicy: .bufferingOldest(1))
        let first = PocketTtsSynthesizer.AudioFrame(samples: [0.1], frameIndex: 1, chunkIndex: 0, chunkCount: 1, utteranceIndex: 0)
        let second = PocketTtsSynthesizer.AudioFrame(samples: [0.2], frameIndex: 2, chunkIndex: 0, chunkCount: 1, utteranceIndex: 0)
        try PocketTtsBoundedFrames.yield(first, to: continuation)
        #expect(throws: PocketTTSError.self) { try PocketTtsBoundedFrames.yield(second, to: continuation) }
        continuation.finish()
        var iterator = stream.makeAsyncIterator()
        #expect(try await iterator.next()?.frameIndex == 1)
        #expect(try await iterator.next() == nil)
    }

    @Test func aTerminatedFrameConsumerCancelsProduction() {
        let (_, continuation) = AsyncThrowingStream<PocketTtsSynthesizer.AudioFrame, Error>.makeStream(bufferingPolicy: .bufferingOldest(1))
        continuation.finish()
        let frame = PocketTtsSynthesizer.AudioFrame(samples: [], frameIndex: 0, chunkIndex: 0, chunkCount: 1, utteranceIndex: 0)
        #expect(throws: CancellationError.self) { try PocketTtsBoundedFrames.yield(frame, to: continuation) }
    }
}
