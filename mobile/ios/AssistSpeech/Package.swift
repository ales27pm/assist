// swift-tools-version: 6.2
import PackageDescription

// Source-vendored FluidAudio; no binary targets, package dependencies or model weights.
let package = Package(
    name: "FluidAudio",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "FluidAudio", targets: ["FluidAudio"])],
    traits: [
        .trait(name: "TTS", description: "Local text-to-speech backends and bundled G2P resources."),
        .default(enabledTraits: ["TTS"]),
    ],
    targets: [
        .target(
            name: "FluidAudio",
            dependencies: [
                "FastClusterWrapper", "MachTaskSelfWrapper",
                .target(name: "LuxTtsG2pResources", condition: .when(traits: ["TTS"])),
            ],
            path: "Sources/FluidAudio",
            exclude: ["ASR/Parakeet/Unified/benchmark.md"]
        ),
        .target(
            name: "LuxTtsG2pResources",
            path: "Sources/LuxTtsG2pResources",
            resources: [.process("Resources")]
        ),
        .target(name: "FastClusterWrapper", path: "Sources/FastClusterWrapper", publicHeadersPath: "include"),
        .target(name: "MachTaskSelfWrapper", path: "Sources/MachTaskSelfWrapper", publicHeadersPath: "include"),
        .testTarget(name: "AssistFluidAudioTests", dependencies: ["FluidAudio"]),
    ],
    cxxLanguageStandard: .cxx17
)
