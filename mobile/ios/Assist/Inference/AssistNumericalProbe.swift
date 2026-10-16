import CoreAI
import CryptoKit
import Foundation

/// Runs only the bundled RMSNorm fixtures. Compute preference is not placement proof.
/// The caller owns the busy/unloaded guard; no Gemma engine or state enters this probe.
enum AssistNumericalProbe {
    private static let shapes = [
        [1, 8, 8, 256], [1, 8, 1, 256], [1, 8, 8, 512],
        [1, 8, 1, 512], [1, 8, 1, 1536], [1, 8, 35, 256],
    ]
    private static let maximumAssetBytes = 32 * 1024 * 1024
    private static let maximumBufferBytes = 16 * 1024 * 1024

    private struct Manifest: Decodable, Sendable {
        let schemaVersion: Int
        let kind: String
        let asset: String
        let assetSHA256: String
        let fixtures: [Fixture]
    }

    private struct Fixture: Decodable, Sendable {
        let id: String
        let function: String
        let inputFile: String
        let inputSHA256: String
        let expectedFile: String
        let expectedSHA256: String
        let shape: [Int]
        let reference: String
        let maxULP: Int
    }

    private struct PreparedFixture: Sendable {
        let fixture: Fixture
        let input: [UInt16]
        let expected: [UInt16]
    }

    private enum Mode: String, Sendable {
        case neuralEnginePreferred = "neural_engine_preferred"
        case cpuOnly = "cpu_only"

        var options: SpecializationOptions {
            switch self {
            case .neuralEnginePreferred:
                return SpecializationOptions(preferredComputeUnitKind: .neuralEngine)
            case .cpuOnly:
                return .cpuOnly
            }
        }
    }

    private struct CaseResult: Encodable, Sendable {
        let id: String
        let function: String
        let mode: String
        let shape: [Int]
        let elements: Int
        let passed: Bool
        let failedElements: Int
        let nonfinite: Int
        let maxULP: Int?
        let actualSHA256: String?
        let inputSHA256: String
        let expectedSHA256: String
        let elapsedMs: Double
        let error: String?
    }

    private struct Summary: Encodable, Sendable {
        let cases: Int
        let failed: Int
        let nonfinite: Int
        let maxULP: Int?

        private enum CodingKeys: String, CodingKey { case cases, failed, nonfinite, maxULP }

        func encode(to encoder: any Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(cases, forKey: .cases)
            try values.encode(failed, forKey: .failed)
            try values.encode(nonfinite, forKey: .nonfinite)
            if let maxULP {
                try values.encode(maxULP, forKey: .maxULP)
            } else {
                try values.encodeNil(forKey: .maxULP)
            }
        }
    }

    private struct Report: Encodable, Sendable {
        let schemaVersion = 1
        let kind = "assistPrimitiveQualification"
        let scope = "primitive_only_gemma_unqualified"
        let aneExecution = "unverified"
        let nativeBuild: String
        let osVersion: String
        let fixtureAssetSHA256: String
        let manifestSHA256: String
        let results: [CaseResult]
        let summary: Summary
    }

    private enum ProbeError: Error, LocalizedError {
        case invalid(String)

        var errorDescription: String? {
            switch self { case .invalid(let message): return message }
        }
    }

    @concurrent
    static func run() async throws -> String {
        guard #available(iOS 27.2, *) else {
            throw ProbeError.invalid("Le contrôle numérique nécessite iOS 27.2.")
        }
        try Task.checkCancellation()
        guard let resources = Bundle.main.resourceURL else {
            throw ProbeError.invalid("Ressources du contrôle numérique absentes.")
        }
        // Resolve system bundle-path aliases before rejecting symlinks inside our resource folder.
        let root = resources.resolvingSymlinksInPath().standardizedFileURL
            .appendingPathComponent("NumericalProbe", isDirectory: true)
        let manifestURL = try resource("manifest.json", under: root, directory: false)
        let manifestData = try boundedData(manifestURL, maximumBytes: 64 * 1024)
        let manifest = try JSONDecoder().decode(Manifest.self, from: manifestData)
        let prepared = try prepare(manifest, root: root)
        let assetURL = try resource(manifest.asset, under: root, directory: true)
        let bytecodeURL = try resource(manifest.asset + "/main.mlirb", under: root, directory: false)
        let bytecodeHash = try fileHash(bytecodeURL, maximumBytes: maximumAssetBytes)
        guard bytecodeHash == manifest.assetSHA256 else {
            throw ProbeError.invalid("Empreinte de l’asset numérique invalide.")
        }
        let storedHashURL = try resource(manifest.asset + "/main.hash", under: root, directory: false)
        let storedHash = try boundedData(storedHashURL, maximumBytes: 32)
        guard storedHash.count == 32, hex(storedHash) == bytecodeHash else {
            throw ProbeError.invalid("main.hash du contrôle numérique invalide.")
        }

        var results: [CaseResult] = []
        for mode in [Mode.neuralEnginePreferred, .cpuOnly] {
            try Task.checkCancellation()
            // Each mode owns its AIModel/functions locally and releases them before the next mode.
            results += try await runMode(mode, assetURL: assetURL, fixtures: prepared)
        }
        let report = Report(
            nativeBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            fixtureAssetSHA256: bytecodeHash, manifestSHA256: digest(manifestData), results: results,
            summary: Summary(
                cases: results.count, failed: results.filter { !$0.passed }.count,
                nonfinite: results.reduce(0) { $0 + $1.nonfinite },
                maxULP: results.compactMap(\.maxULP).max()
            )
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(report), as: UTF8.self)
    }

    private static func prepare(_ manifest: Manifest, root: URL) throws -> [PreparedFixture] {
        guard manifest.schemaVersion == 1, manifest.kind == "assistRMSNormFixtures",
              manifest.asset == "RMSNormProbe.aimodel", validHash(manifest.assetSHA256),
              manifest.fixtures.count == 12 else {
            throw ProbeError.invalid("Manifeste du contrôle numérique inattendu.")
        }
        let expectedFunctions = Set(shapes.flatMap { shape in
            ["weighted", "ones"].map { "rms_q8_\(shape[3])_\(shape[2])_\($0)" }
        })
        guard Set(manifest.fixtures.map(\.function)) == expectedFunctions,
              Set(manifest.fixtures.map(\.id)).count == 12 else {
            throw ProbeError.invalid("Les douze fonctions numériques attendues sont requises.")
        }
        return try manifest.fixtures.map { fixture in
            guard fixture.id == fixture.function, shapes.contains(fixture.shape),
                  fixture.function.hasPrefix("rms_q8_\(fixture.shape[3])_\(fixture.shape[2])_"),
                  fixture.reference == "float64_rmsnorm_then_float16", fixture.maxULP == 1,
                  validHash(fixture.inputSHA256), validHash(fixture.expectedSHA256),
                  fixture.inputFile != fixture.expectedFile else {
                throw ProbeError.invalid("Contrat de fixture numérique invalide.")
            }
            let count = fixture.shape.reduce(1, *) // Shape is one of the six fixed, bounded shapes.
            let inputURL = try resource(fixture.inputFile, under: root, directory: false)
            let expectedURL = try resource(fixture.expectedFile, under: root, directory: false)
            let inputData = try boundedData(inputURL, maximumBytes: count * 2)
            let expectedData = try boundedData(expectedURL, maximumBytes: count * 2)
            guard inputData.count == count * 2, expectedData.count == count * 2,
                  digest(inputData) == fixture.inputSHA256, digest(expectedData) == fixture.expectedSHA256 else {
                throw ProbeError.invalid("Taille ou empreinte de fixture numérique invalide.")
            }
            let input = halfBits(inputData)
            let expected = halfBits(expectedData)
            guard input.allSatisfy(finite), expected.allSatisfy(finite) else {
                throw ProbeError.invalid("Les fixtures doivent contenir uniquement des valeurs finies.")
            }
            return PreparedFixture(fixture: fixture, input: input, expected: expected)
        }
    }

    private static func runMode(
        _ mode: Mode, assetURL: URL, fixtures: [PreparedFixture]
    ) async throws -> [CaseResult] {
        let loadStarted = ContinuousClock.now
        let model: AIModel
        do {
            model = try await AIModel(contentsOf: assetURL, options: mode.options)
            let names = model.functionNames
            guard names.count == 12, Set(names) == Set(fixtures.map { $0.fixture.function }) else {
                throw ProbeError.invalid("Fonctions publiques de l’asset numérique inattendues.")
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return fixtures.map { failure($0.fixture, mode: mode, error: error, elapsedMs: elapsed(loadStarted)) }
        }
        var results: [CaseResult] = []
        for prepared in fixtures {
            try Task.checkCancellation()
            let started = ContinuousClock.now
            do {
                results.append(try await runFixture(prepared, mode: mode, model: model, started: started))
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                results.append(failure(prepared.fixture, mode: mode, error: error, elapsedMs: elapsed(started)))
            }
        }
        return results
    }

    private static func runFixture(
        _ prepared: PreparedFixture, mode: Mode, model: AIModel, started: ContinuousClock.Instant
    ) async throws -> CaseResult {
        let fixture = prepared.fixture
        guard let function = try model.loadFunction(named: fixture.function) else {
            throw ProbeError.invalid("Fonction numérique absente.")
        }
        let descriptor = function.descriptor
        guard descriptor.inputNames == ["input"], descriptor.outputNames == ["output"], descriptor.stateNames.isEmpty,
              case .ndArray(let inputDescriptor) = descriptor.inputDescriptor(of: "input"),
              case .ndArray(let outputDescriptor) = descriptor.outputDescriptor(of: "output"),
              inputDescriptor.shape == fixture.shape, outputDescriptor.shape == fixture.shape,
              inputDescriptor.scalarType == .float16, outputDescriptor.scalarType == .float16,
              inputDescriptor.minimumByteCount >= prepared.input.count * 2,
              outputDescriptor.minimumByteCount >= prepared.expected.count * 2,
              inputDescriptor.minimumByteCount <= maximumBufferBytes,
              outputDescriptor.minimumByteCount <= maximumBufferBytes else {
            throw ProbeError.invalid("Signature F16 sans état de la fixture numérique invalide.")
        }
        var input = NDArray(descriptor: inputDescriptor)
        try fill(&input, bits: prepared.input, shape: fixture.shape)
        // This documented NDArray dictionary overload also constructs the InferenceValue input views.
        var outputs = try await function.run(inputs: ["input": input], outputViews: InferenceFunction.MutableViews())
        try Task.checkCancellation()
        guard outputs.count == 1, let output = outputs.remove("output")?.ndArray,
              output.shape == fixture.shape, output.scalarType == .float16 else {
            throw ProbeError.invalid("Sortie F16 de la fixture numérique invalide.")
        }
        let actual = try read(output, shape: fixture.shape)
        var failures = 0
        var nonfinite = 0
        var maximum: Int?
        for (observed, expected) in zip(actual, prepared.expected) {
            guard finite(observed) else {
                nonfinite += 1
                failures += 1
                continue
            }
            let distance = ulpDistance(observed, expected)
            maximum = max(maximum ?? 0, distance)
            if distance > fixture.maxULP { failures += 1 }
        }
        return CaseResult(
            id: fixture.id, function: fixture.function, mode: mode.rawValue, shape: fixture.shape,
            elements: actual.count, passed: failures == 0, failedElements: failures, nonfinite: nonfinite,
            maxULP: maximum, actualSHA256: digest(halfData(actual)), inputSHA256: fixture.inputSHA256,
            expectedSHA256: fixture.expectedSHA256, elapsedMs: elapsed(started), error: nil
        )
    }

    private static func fill(_ array: inout NDArray, bits: [UInt16], shape: [Int]) throws {
        let view = array.mutableView(as: Float16.self)
        guard view.interleaveLayout == nil else {
            throw ProbeError.invalid("Entrelacement inattendu de l’entrée numérique.")
        }
        try view.withUnsafeMutablePointer { pointer, dimensions, strides in
            guard dimensions.count == 4, strides.count == 4 else {
                throw ProbeError.invalid("Rang de l’entrée numérique invalide.")
            }
            let offsets = try logicalOffsets(
                shape: [dimensions[0], dimensions[1], dimensions[2], dimensions[3]],
                strides: [strides[0], strides[1], strides[2], strides[3]], expected: shape
            )
            guard offsets.count == bits.count else { throw ProbeError.invalid("Compte F16 d’entrée invalide.") }
            for (index, offset) in offsets.enumerated() { pointer[offset] = Float16(bitPattern: bits[index]) }
        }
    }

    private static func read(_ array: NDArray, shape: [Int]) throws -> [UInt16] {
        let view = array.view(as: Float16.self)
        guard view.interleaveLayout == nil else {
            throw ProbeError.invalid("Entrelacement inattendu de la sortie numérique.")
        }
        return try view.withUnsafePointer { pointer, dimensions, strides in
            guard dimensions.count == 4, strides.count == 4 else {
                throw ProbeError.invalid("Rang de la sortie numérique invalide.")
            }
            let offsets = try logicalOffsets(
                shape: [dimensions[0], dimensions[1], dimensions[2], dimensions[3]],
                strides: [strides[0], strides[1], strides[2], strides[3]], expected: shape
            )
            return offsets.map { pointer[$0].bitPattern }
        }
    }

    private static func logicalOffsets(shape: [Int], strides: [Int], expected: [Int]) throws -> [Int] {
        guard shape == expected, strides.count == 4, strides.allSatisfy({ $0 >= 0 }) else {
            throw ProbeError.invalid("Forme ou pas mémoire numérique invalide.")
        }
        var offsets: [Int] = []
        offsets.reserveCapacity(shape.reduce(1, *))
        for query in 0..<shape[1] {
            for head in 0..<shape[2] {
                for column in 0..<shape[3] {
                    var offset = 0
                    for (index, stride) in zip([0, query, head, column], strides) {
                        let (part, productOverflow) = index.multipliedReportingOverflow(by: stride)
                        let (sum, sumOverflow) = offset.addingReportingOverflow(part)
                        guard !productOverflow, !sumOverflow, sum < maximumBufferBytes / 2 else {
                            throw ProbeError.invalid("Débordement de pas mémoire numérique.")
                        }
                        offset = sum
                    }
                    offsets.append(offset)
                }
            }
        }
        return offsets
    }

    /// Collapse both zeros to the same point; signed finite neighbors remain one ULP apart.
    private static func ulpDistance(_ lhs: UInt16, _ rhs: UInt16) -> Int {
        func ordered(_ bits: UInt16) -> Int {
            let magnitude = Int(bits & 0x7fff)
            return bits & 0x8000 == 0 ? 0x8000 + magnitude : 0x8000 - magnitude
        }
        return abs(ordered(lhs) - ordered(rhs))
    }

    private static func finite(_ bits: UInt16) -> Bool { bits & 0x7c00 != 0x7c00 }

    private static func halfBits(_ data: Data) -> [UInt16] {
        stride(from: 0, to: data.count, by: 2).map { UInt16(data[$0]) | UInt16(data[$0 + 1]) << 8 }
    }

    private static func halfData(_ bits: [UInt16]) -> Data {
        Data(bits.flatMap { [UInt8(truncatingIfNeeded: $0), UInt8(truncatingIfNeeded: $0 >> 8)] })
    }

    private static func failure(_ fixture: Fixture, mode: Mode, error: any Error, elapsedMs: Double) -> CaseResult {
        CaseResult(
            id: fixture.id, function: fixture.function, mode: mode.rawValue, shape: fixture.shape,
            elements: fixture.shape.reduce(1, *), passed: false, failedElements: 0, nonfinite: 0,
            maxULP: nil, actualSHA256: nil, inputSHA256: fixture.inputSHA256,
            expectedSHA256: fixture.expectedSHA256, elapsedMs: elapsedMs,
            error: String((error as NSError).localizedDescription.prefix(320))
        )
    }

    private static func resource(_ relative: String, under root: URL, directory: Bool) throws -> URL {
        let parts = relative.split(separator: "/", omittingEmptySubsequences: false)
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.")
        guard !parts.isEmpty, parts.count <= 4, relative.utf8.count <= 512,
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.unicodeScalars.allSatisfy(allowed.contains) }) else {
            throw ProbeError.invalid("Chemin de ressource numérique invalide.")
        }
        let manager = FileManager.default
        let base = root.standardizedFileURL
        guard base.resolvingSymlinksInPath() == base,
              try manager.attributesOfItem(atPath: base.path)[.type] as? FileAttributeType == .typeDirectory else {
            throw ProbeError.invalid("Dossier de ressources numériques invalide.")
        }
        var url = base
        for (index, part) in parts.enumerated() {
            url.appendPathComponent(String(part))
            let type = try manager.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType
            let wantsDirectory = index < parts.count - 1 || directory
            guard type == (wantsDirectory ? .typeDirectory : .typeRegular) else {
                throw ProbeError.invalid("Ressource numérique absente ou symbolique.")
            }
        }
        return url
    }

    private static func boundedData(_ url: URL, maximumBytes: Int) throws -> Data {
        let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber
        guard let size, size.int64Value >= 0, size.int64Value <= Int64(maximumBytes) else {
            throw ProbeError.invalid("Ressource numérique trop volumineuse.")
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var data = Data()
        data.reserveCapacity(size.intValue)
        while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
            guard data.count + chunk.count <= maximumBytes else {
                throw ProbeError.invalid("Ressource numérique modifiée ou trop volumineuse.")
            }
            data.append(chunk)
        }
        guard data.count == size.intValue else { throw ProbeError.invalid("Taille de ressource numérique modifiée.") }
        return data
    }

    private static func fileHash(_ url: URL, maximumBytes: Int) throws -> String {
        let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber
        guard let size, size.int64Value > 0, size.int64Value <= Int64(maximumBytes) else {
            throw ProbeError.invalid("Asset numérique trop volumineux ou vide.")
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        var bytes = 0
        while let data = try handle.read(upToCount: 64 * 1024), !data.isEmpty {
            bytes += data.count
            guard bytes <= maximumBytes else { throw ProbeError.invalid("Asset numérique modifié.") }
            hash.update(data: data)
        }
        guard bytes == size.intValue else { throw ProbeError.invalid("Taille de l’asset numérique modifiée.") }
        return hex(hash.finalize())
    }

    private static func elapsed(_ start: ContinuousClock.Instant) -> Double {
        let parts = start.duration(to: ContinuousClock.now).components
        return Double(parts.seconds) * 1000 + Double(parts.attoseconds) / 1e15
    }

    private static func validHash(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private static func digest(_ data: Data) -> String { hex(SHA256.hash(data: data)) }
    private static func hex(_ bytes: some Sequence<UInt8>) -> String { bytes.map { String(format: "%02x", $0) }.joined() }
}
