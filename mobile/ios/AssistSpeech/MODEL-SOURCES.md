# Model sources and attribution

The app's separate asset manifest pins these repositories. No weights are stored
in this SDK package. Model file integrity and runtime qualification are separate.

- PocketTTS: Kyutai; Core ML conversion by FluidInference. CC-BY-4.0.
  [Pinned conversion card](https://huggingface.co/FluidInference/pocket-tts-coreml/blob/91748676fe3c8b2eb3007b3125253bcd898202c3/README.md).
  [Original model and usage conditions](https://huggingface.co/kyutai/pocket-tts).
- Parakeet Ultra: moondream, derived from NVIDIA Parakeet; Core ML conversion by
  FluidInference. CC-BY-4.0.
  [Pinned card](https://huggingface.co/FluidInference/parakeet-ultra-coreml/blob/95eaa59a39d4394f047a4dc5cce480388a60d1b6/README.md).
- Parakeet Redux: moondream, derived from NVIDIA Parakeet; Core ML conversion by
  FluidInference. CC-BY-4.0.
  [Pinned card](https://huggingface.co/FluidInference/parakeet-redux-coreml/blob/8c5ef97a29cd120dc76b354b3f22b7fec3b486f9/README.md).
- Silero VAD: Silero Team; Core ML conversion by FluidInference. MIT.
  [Pinned card](https://huggingface.co/FluidInference/silero-vad-coreml/blob/b419383c55c110e2c9271fa6ee0ea83d03c70d96/README.md).

The supplied `estelle` snapshot is the upstream French preset. Voice recordings
have their own provenance/licenses in [Kyutai's voice catalog](https://huggingface.co/kyutai/tts-voices).
An installed voice or a French language tag is not evidence of a Québec accent.
Assist uses the public French Estelle preset; custom voice imports are removed.
No recording or embedding is uploaded by the local loading APIs.
