import AVFoundation
import Accelerate
@preconcurrency import CoreML
import Foundation
import OSLog

/// VAD Manager using the trained Silero VAD model
///
/// **Beta Status**: This VAD implementation is currently in beta.
/// While it performs well in testing environments,
/// it has not been extensively tested in production environments.
/// Use with caution in production applications.
///
public actor VadManager {

    private let logger = AppLogger(category: "VadManager")
    public let config: VadConfig
    private let audioConverter: AudioConverter = AudioConverter()
    private let memoryOptimizer: ANEMemoryOptimizer = ANEMemoryOptimizer()

    /// Model expects 4096 new samples (256ms at 16kHz) plus 64-sample context (total 4160)
    public static let chunkSize = 4096
    private static let contextSize = VadState.contextLength
    private static let stateSize = 128
    private static let modelInputSize = chunkSize + contextSize
    public static let sampleRate = 16000

    private var vadModel: MLModel?
    private var modelContractValidated = false

    public var isAvailable: Bool {
        return vadModel != nil
    }

    // MARK: - Main processing API

    /// Process an entire audio source from a file URL.
    /// Automatically converts the audio to 16kHz mono Float32 and processes in 4096-sample chunks (256ms).
    /// ```swift
    /// let manager = try await VadManager()
    /// let results = try await manager.process(audioURL)
    /// ```
    /// - Parameter url: Audio file URL
    /// - Returns: Array of per-chunk VAD results
    public func process(_ url: URL) async throws -> [VadResult] {
        let samples = try audioConverter.resampleAudioFile(url)
        return try await processAudioSamples(samples)
    }

    /// Process an entire in-memory audio buffer.
    /// Automatically converts the buffer to 16kHz mono Float32 and processes in 4096-sample chunks (256ms).
    /// ```swift
    /// let buffer: AVAudioPCMBuffer = ...
    /// let manager = try await VadManager()
    /// let results = try await manager.process(buffer)
    /// ```
    /// - Parameter audioBuffer: Source buffer in any format
    /// - Returns: Array of per-chunk VAD results
    public func process(_ audioBuffer: AVAudioPCMBuffer) async throws -> [VadResult] {
        let samples = try audioConverter.resampleBuffer(audioBuffer)
        return try await processAudioSamples(samples)
    }

    /// Process raw 16kHz mono samples.
    /// Processes audio in 4096-sample chunks (256ms at 16kHz).
    /// ```swift
    /// let samples = try AudioConverter().resampleAudioFile(audioURL)
    /// let manager = try await VadManager()
    /// let results = try await manager.process(samples)
    /// let rtfx = (Double(samples.count) / Double(VadManager.sampleRate)) /
    ///     results.reduce(0) { $0 + $1.processingTime }
    /// ```
    /// - Parameter samples: Audio samples (must be 16kHz, mono)
    /// - Returns: Array of per-chunk VAD results
    public func process(_ samples: [Float]) async throws -> [VadResult] {
        return try await processAudioSamples(samples)
    }

    /// Initialize with configuration
    public init(
        config: VadConfig = .default,
        progressHandler: ProgressHandler? = nil
    ) async throws {
        self.config = config

        let startTime = Date()

        // Load the unified model
        try await loadUnifiedModel(progressHandler: progressHandler)

        let totalInitTime = Date().timeIntervalSince(startTime)
        logger.info("VAD system initialized in \(String(format: "%.2f", totalInitTime))s")
    }

    /// Internal initializer for logic-only use (e.g., unit tests) that avoids model loading.
    /// This allows calling segmentation helpers without performing any model I/O.
    internal init(skipModelLoading: Bool, config: VadConfig = .default) {
        self.config = config
        self.vadModel = nil
        logger.info("VAD initialized in logic-only mode (no model loaded)")
    }

    /// Initialize with pre-loaded model
    public init(config: VadConfig = .default, vadModel: MLModel) {
        self.config = config
        self.vadModel = vadModel
        logger.info("VAD initialized with provided model")
    }

    /// Initialize from directory
    public init(
        config: VadConfig = .default,
        modelDirectory: URL,
        progressHandler: ProgressHandler? = nil
    ) async throws {
        self.config = config

        let startTime = Date()
        try await loadUnifiedModel(from: modelDirectory, progressHandler: progressHandler)

        let totalInitTime = Date().timeIntervalSince(startTime)
        logger.info("VAD system initialized in \(String(format: "%.2f", totalInitTime))s")
    }

    private func loadUnifiedModel(
        from directory: URL? = nil,
        progressHandler: ProgressHandler? = nil
    ) async throws {
        let baseDirectory = directory ?? getDefaultBaseDirectory()

        // Use ModelHub to load the model (handles downloading if needed)
        let models = try await ModelHub.loadModels(
            .vad,
            modelNames: Array(ModelNames.VAD.requiredModels),
            directory: baseDirectory.appendingPathComponent("Models"),
            computeUnits: config.computeUnits,
            progressHandler: progressHandler
        )

        // Get the VAD model
        guard let vadModel = models[ModelNames.VAD.sileroVadFile] else {
            logger.error("Failed to load VAD model from downloaded models")
            throw VadError.modelLoadingFailed
        }

        try Self.validateModelDescription(vadModel.modelDescription)
        self.vadModel = vadModel
        modelContractValidated = true
        logger.info("VAD model loaded successfully")
    }

    private func getDefaultBaseDirectory() -> URL {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        ).first!
        return appSupport.appendingPathComponent("FluidAudio", isDirectory: true)
    }

    /// Check if audio chunk is completely silent (all zeros or below threshold)
    private func isSilentAudio(_ audioChunk: [Float]) -> Bool {
        let silenceThreshold: Float = 1e-10
        return audioChunk.allSatisfy { abs($0) <= silenceThreshold }
    }

    internal func processChunk(_ audioChunk: [Float], inputState: VadState? = nil) async throws -> VadResult {
        guard let loadedModel = vadModel else {
            throw VadError.notInitialized
        }
        // Keep the existing nonthrowing preloaded-model initializer compatible,
        // but reject its actual descriptor before the first prediction/read.
        if !modelContractValidated {
            try Self.validateModelDescription(loadedModel.modelDescription)
            modelContractValidated = true
        }

        let processingStartTime = Date()

        // Use input state or create initial state
        let currentState = inputState ?? VadState.initial()
        // Ensure chunk is correct size (4096 samples of new audio)
        var processedChunk = audioChunk
        if processedChunk.count != Self.chunkSize {
            if processedChunk.count < Self.chunkSize {
                let paddingSize = Self.chunkSize - processedChunk.count
                // Use repeat-last padding instead of zeros to avoid energy distortion
                let lastSample = processedChunk.last ?? 0.0
                processedChunk.append(contentsOf: Array(repeating: lastSample, count: paddingSize))
            } else {
                processedChunk = Array(processedChunk.prefix(Self.chunkSize))
            }
        }

        let nextContext = Array(processedChunk.suffix(Self.contextSize))
        // No normalization - preserve original amplitude information for VAD

        // Process through unified model
        let (rawProbability, newHiddenState, newCellState) = try await processUnifiedModel(
            processedChunk,
            inputState: currentState,
            model: loadedModel
        )
        let outputState = VadState(
            hiddenState: newHiddenState,
            cellState: newCellState,
            context: nextContext
        )
        let processingTime = Date().timeIntervalSince(processingStartTime)

        return VadResult(
            probability: rawProbability,
            isVoiceActive: rawProbability >= config.defaultThreshold,
            processingTime: processingTime,
            outputState: outputState
        )
    }

    private func processUnifiedModel(
        _ audioChunk: [Float],
        inputState: VadState,
        model: MLModel
    ) async throws -> (Float, [Float], [Float]) {
        do {
            let result: (Float, [Float], [Float]) = try autoreleasepool {
                // Reuse ANE-aligned buffers to avoid surface churn between invocations
                let audioArray = try memoryOptimizer.getPooledBuffer(
                    key: "vad_audio_input",
                    shape: [1, NSNumber(value: Self.modelInputSize)],
                    dataType: .float32
                )
                let hiddenStateArray = try memoryOptimizer.getPooledBuffer(
                    key: "vad_hidden_state",
                    shape: [1, NSNumber(value: Self.stateSize)],
                    dataType: .float32
                )
                let cellStateArray = try memoryOptimizer.getPooledBuffer(
                    key: "vad_cell_state",
                    shape: [1, NSNumber(value: Self.stateSize)],
                    dataType: .float32
                )
                try ModelTensorContract.validateFloat32(audioArray, count: Self.modelInputSize, role: "Silero audio input")
                try ModelTensorContract.validateFloat32(hiddenStateArray, count: Self.stateSize, role: "Silero hidden input")
                try ModelTensorContract.validateFloat32(cellStateArray, count: Self.stateSize, role: "Silero cell input")

                // Clear and populate audio input (context followed by current chunk)
                let audioPointer = audioArray.dataPointer.assumingMemoryBound(to: Float.self)
                vDSP_vclr(audioPointer, 1, vDSP_Length(Self.modelInputSize))
                memoryOptimizer.optimizedCopy(
                    from: inputState.context.prefix(Self.contextSize),
                    to: audioArray
                )
                memoryOptimizer.optimizedCopy(
                    from: audioChunk.prefix(Self.chunkSize),
                    to: audioArray,
                    offset: Self.contextSize
                )

                // Clear and populate recurrent state inputs
                let hiddenPointer = hiddenStateArray.dataPointer.assumingMemoryBound(to: Float.self)
                vDSP_vclr(hiddenPointer, 1, vDSP_Length(Self.stateSize))
                memoryOptimizer.optimizedCopy(
                    from: inputState.hiddenState.prefix(Self.stateSize),
                    to: hiddenStateArray
                )

                let cellPointer = cellStateArray.dataPointer.assumingMemoryBound(to: Float.self)
                vDSP_vclr(cellPointer, 1, vDSP_Length(Self.stateSize))
                memoryOptimizer.optimizedCopy(
                    from: inputState.cellState.prefix(Self.stateSize),
                    to: cellStateArray
                )

                // Create input provider with all required inputs
                let input = try MLDictionaryFeatureProvider(dictionary: [
                    "audio_input": audioArray,
                    "hidden_state": hiddenStateArray,
                    "cell_state": cellStateArray,
                ])

                // Run prediction
                let output = try model.prediction(from: input)
                return try Self.checkedOutputValues(output)
            }

            return result

        } catch {
            logger.error("Model processing failed: \(error)")
            throw VadError.modelProcessingFailed(error.localizedDescription)
        }
    }

    static func validateModelDescription(_ description: MLModelDescription) throws {
        let inputs = description.inputDescriptionsByName
        guard Set(inputs.keys) == ["audio_input", "hidden_state", "cell_state"] else {
            throw ModelTensorContract.failure("Silero inputs")
        }
        for (name, count) in [("audio_input", modelInputSize), ("hidden_state", stateSize), ("cell_state", stateSize)] {
            try ModelTensorContract.validateFloat32Description(
                inputs[name], count: count, shape: [1, count], role: "Silero \(name)")
        }
        let outputs = description.outputDescriptionsByName
        for (token, count) in [("vad_output", 1), ("new_hidden_state", stateSize), ("new_cell_state", stateSize)] {
            let name = try ModelTensorContract.uniqueName(in: Set(outputs.keys), containing: token, role: "Silero \(token)")
            try ModelTensorContract.validateFloat32Description(outputs[name], count: count, role: "Silero \(token)")
        }
    }

    static func checkedOutputValues(_ provider: MLFeatureProvider) throws -> (Float, [Float], [Float]) {
        func values(_ token: String, count: Int) throws -> [Float] {
            let name = try ModelTensorContract.uniqueName(in: provider.featureNames, containing: token, role: "Silero \(token)")
            guard let array = provider.featureValue(for: name)?.multiArrayValue else {
                throw ModelTensorContract.failure("Silero \(token)")
            }
            return try ModelTensorContract.float32Values(array, count: count, role: "Silero \(token)")
        }
        return (try values("vad_output", count: 1)[0],
                try values("new_hidden_state", count: stateSize),
                try values("new_cell_state", count: stateSize))
    }

    /// Process audio samples using adaptive batch processing for optimal performance
    internal func processAudioSamples(_ audioData: [Float]) async throws -> [VadResult] {

        // Split audio into chunks of chunkSize (4096 samples) as model is optimized for this size
        var audioChunks: [[Float]] = []
        for i in stride(from: 0, to: audioData.count, by: Self.chunkSize) {
            let endIndex = min(i + Self.chunkSize, audioData.count)
            let chunk = Array(audioData[i..<endIndex])
            audioChunks.append(chunk)
        }

        guard !audioChunks.isEmpty else {
            return []
        }

        var results: [VadResult] = []
        var currentState = VadState.initial()

        for (chunk) in audioChunks {
            let result = try await processChunk(chunk, inputState: currentState)
            results.append(result)
            currentState = result.outputState
        }

        return results
    }

    /// Get current configuration
    public var currentConfig: VadConfig {
        return config
    }
}
