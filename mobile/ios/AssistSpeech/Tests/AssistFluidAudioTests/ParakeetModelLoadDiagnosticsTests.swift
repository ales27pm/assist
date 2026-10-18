@preconcurrency import CoreML
import Foundation
import Testing
@testable import FluidAudio

@Suite("Parakeet local model failure diagnostics")
struct ParakeetModelLoadDiagnosticsTests {
    @Test func appDomainAllowlistMatchesActualSDKErrorBridging() {
        let errors: [(any Error, String)] = [
            (PocketTTSError.processingFailed("private transcript"), "FluidAudio.PocketTTSError"),
            (ASRError.processingFailed("private transcript"), "FluidAudio.ASRError"),
            (AsrModelsError.loadingFailed("private transcript"), "FluidAudio.AsrModelsError"),
            (VadError.modelProcessingFailed("private transcript"), "FluidAudio.VadError"),
        ]
        for (error, expected) in errors { #expect((error as NSError).domain == expected) }
    }

    @Test func coreMLFailurePreservesExactComponentRouteAndUnderlyingWithoutRetry() {
        for units in [MLComputeUnits.all, .cpuOnly, .cpuAndGPU, .cpuAndNeuralEngine] {
            let native = NSError(domain: "com.apple.CoreML", code: 19,
                                 userInfo: [NSLocalizedDescriptionKey: "/private/speaker/model secret transcript"])
            var calls = 0
            do {
                _ = try AsrModels.loadLocalComponent(named: "Encoder.mlmodelc", units: units) {
                    calls += 1
                    throw native
                }
                Issue.record("Failed local component unexpectedly loaded")
            } catch {
                let wrapped = error as NSError
                #expect(wrapped.domain == "FluidAudio.ParakeetModelLoad")
                #expect(wrapped.code == 19)
                #expect(wrapped.userInfo["ParakeetComponent"] as? String == "Encoder.mlmodelc")
                let expectedUnits: String
                switch units {
                case .all: expectedUnits = "all"
                case .cpuOnly: expectedUnits = "cpuOnly"
                case .cpuAndGPU: expectedUnits = "cpuAndGPU"
                case .cpuAndNeuralEngine: expectedUnits = "cpuAndNeuralEngine"
                @unknown default: expectedUnits = "other"
                }
                #expect(wrapped.userInfo["ParakeetComputeUnits"] as? String == expectedUnits)
                #expect((wrapped.userInfo[NSUnderlyingErrorKey] as? NSError) === native)
                #expect(wrapped.userInfo[NSLocalizedDescriptionKey] == nil)
                #expect(Set(wrapped.userInfo.keys) == Set([NSUnderlyingErrorKey, "ParakeetComponent", "ParakeetComputeUnits"]))
            }
            #expect(calls == 1)
        }
    }

    @Test func arbitraryComponentMetadataIsNeverCaptured() {
        for name in ["/private/speaker/Encoder.mlmodelc", "Speaker.Name.mlmodelc", "Encoder.mlmodelc\nsecret"] {
            let native = NSError(domain: NSCocoaErrorDomain, code: 260)
            do {
                _ = try AsrModels.loadLocalComponent(named: name, units: .cpuOnly) { throw native }
                Issue.record("Failed local component unexpectedly loaded")
            } catch {
                let wrapped = error as NSError
                #expect(wrapped.domain == "FluidAudio.ParakeetModelLoad")
                #expect(wrapped.userInfo["ParakeetComponent"] as? String == "other")
                #expect((wrapped.userInfo[NSUnderlyingErrorKey] as? NSError) === native)
            }
        }
    }

    @Test func everyFixedLocalComponentNameSurvivesWithoutAPath() {
        let components = [
            "Preprocessor.mlmodelc", "Encoder.mlmodelc", "Encoder_v2.mlmodelc", "EncoderInt4.mlmodelc",
            "Decoder.mlmodelc", "JointDecision.mlmodelc", "JointDecisionv3.mlmodelc", "CtcHead.mlmodelc",
            "Decoderv2.mlmodelc", "Jointerv2.mlmodelc",
        ]
        for component in components {
            do {
                _ = try AsrModels.loadLocalComponent(named: component, units: .cpuOnly) {
                    throw NSError(domain: "com.apple.CoreML", code: 1)
                }
                Issue.record("Failed local component unexpectedly loaded")
            } catch {
                #expect((error as NSError).userInfo["ParakeetComponent"] as? String == component)
            }
        }
    }

    @Test func cancellationIsNotReclassifiedAsAModelLoadFailure() {
        var calls = 0
        #expect(throws: CancellationError.self) {
            _ = try AsrModels.loadLocalComponent(named: "Decoder.mlmodelc", units: .cpuAndNeuralEngine) {
                calls += 1
                throw CancellationError()
            }
        }
        #expect(calls == 1)
    }
}
