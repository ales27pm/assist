# Assist local speech SDK

This is source-vendored [FluidAudio](https://github.com/FluidInference/FluidAudio) at
`2d6c42ca5f3accc0faf9fee9e0fff5b9b2cf6042` (2026-10-16). The package/product/module
are `FluidAudio`. `UPSTREAM.json` records the SHA-256 of every copied upstream
file before local changes. `LOCAL-PATCH.diff` records the source patch. The SDK
is Apache-2.0; retain `LICENSE` and the applicable `ThirdPartyLicenses` notices.

The Swift 6.2 manifest enables `TTS`, omits `Diarizer` and `NemoTextProcessing`,
and declares no remote packages, binary targets, executables, or model weights.
NeMo normalization is unavailable; frontends pass text through accordingly.

## Runtime entry points

```swift
let tts = PocketTtsManager(
    defaultVoice: "estelle", language: .french24L,
    offlineDirectory: pack.appendingPathComponent("pocket"),
    precision: .int8, placement: .gpu)
try await tts.initialize()
let session = try await tts.makeSession(voice: "estelle")
try await session.configurePlaybackBackpressure(maximumFrames: 150)
session.enqueue("Bonjour.")
session.finish()
for try await frame in session.frames {
    // 24 kHz mono Float32; route through the app's bounded player/VPIO graph.
    // After dataPlayedBack, credit this exact session:
    // Task { await session.acknowledgePlaybackFrame() }
}
await session.cancel() // Waits until its Core ML generation task exits.
```

`offlineDirectory` is the **direct language root**, not an SDK cache directory.
It validates the required model directories and constants before Core ML loads.
Missing models, constants, voices, or the pack-local `mimi_encoderv3.mlmodelc`
fail locally. These initialization, voice and clone branches never call an SDK
downloader or recover with English voice conditioning. Cloning uses local
24 kHz mono samples, or a local AVFoundation-readable file; the app must bound
its file size/duration before decoding. Current encoder code keeps 1–10 seconds
and at most 125 conditioning frames. These cloning APIs remain unused SDK functionality: Assist uses only the public
Estelle preset and exposes no reference import. No Québec accent is guaranteed.

Use `AsrModels.loadLocal(from:version:)` with `.redux` or `.ultra`; avoid the
similarly named `load`, `loadModels()` and `downloadAndLoad` convenience paths,
which retain upstream downloading behavior. Inject a locally loaded Silero
`MLModel` with `VadManager(config:vadModel:)`; its default/directory initializers
also retain upstream model acquisition. The app verifies its pinned manifest
and uses only these explicit local entry points. The presence of unused SDK
downloader code does not authorize network activity.

Pocket session queues retain at most 64 text inputs and 192 output frames
(about 15.36 seconds at 80 ms/frame). Overflow reports a generation error through
`frames`; it never silently drops speech. The optional playback gate is configured before any text is enqueued, with
1–192 outstanding frames allowed (the app uses 150 = 12 seconds). Generation
suspends on a continuation until a played-frame credit arrives; it never polls
or sleeps. Cancellation wakes a blocked producer. One exact-session credit must
be returned after every frame's converted samples are played or cancelled,
including samples carried through converter tail buffers. The app also bounds
text, player buffers and capture work and invalidates identities before stopping
playback. Callers that omit the gate must pace long answers themselves.

The local patch checks task cancellation after encoder loading and immediately
before the clone and shared async Core ML prediction boundaries. A prediction
already running cannot be preempted; the app cuts its player before awaiting
cancellation. The patch also removes response text from the session info log. At app startup,
set `AppLogger.minimumLevel = .warning` and `AppLogger.mirrorsToConsole = false`
to suppress upstream debug/info transcripts and console mirroring.

## Checks and limits

On a macOS host with Xcode / Swift 6.2 or later:

```sh
swift test --package-path mobile/ios/AssistSpeech
```

The model-free tests exercise the actual offline path validators, the public
missing-assets initializer, no English-encoder fallback, and bounded frame
queue overflow/termination, playback-credit cancellation and a 1,000-frame fast
producer remaining within its actual configured outstanding-frame budget. They request no microphone/speech permission and
perform no speech playback or model download. They do not prove model loading,
fr-CA quality, device throughput, VPIO echo cancellation, or iOS archive support.
Those require separate tests with the pinned assets on physical supported phones.

Model weights are separate assets. PocketTTS and Parakeet Ultra/Redux model cards
declare CC-BY-4.0; Silero declares MIT. See `MODEL-SOURCES.md` for pinned cards and
attribution. Assist uses Estelle from the pinned public pack.
