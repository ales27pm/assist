#!/usr/bin/env bash
# Synthetic duplex lifetime/PCM checks. Never starts an audio engine or ASR.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != "Darwin" ]] || ! command -v xcrun >/dev/null 2>&1; then
  echo "ERROR: duplex checks require macOS and Xcode's AVFoundation/Speech SDKs." >&2
  exit 69
fi
VOICE_DUPLEX_SDK="$(xcrun --sdk macosx --show-sdk-path)"
VOICE_DUPLEX_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-voice-duplex.XXXXXX")"
trap 'rm -rf "$VOICE_DUPLEX_DIR"' EXIT
xcrun --sdk macosx swiftc \
  -swift-version 6 -strict-concurrency=complete -warnings-as-errors \
  -enable-actor-data-race-checks -parse-as-library -sdk "$VOICE_DUPLEX_SDK" \
  -target "$(uname -m)-apple-macosx15.0" \
  -module-cache-path "$VOICE_DUPLEX_DIR/module-cache" \
  mobile/ios/Assist/Voice/AssistVoiceCallbacks.swift \
  mobile/ios/Assist/Voice/AssistVoiceSpeechQueue.swift \
  mobile/ios/Assist/Voice/AssistVoicePCMTransfer.swift \
  mobile/ios/Assist/Voice/AssistVoiceDuplexState.swift \
  scripts/check-voice-duplex.swift \
  -framework AVFoundation -framework Speech \
  -o "$VOICE_DUPLEX_DIR/check-voice-duplex"
"$VOICE_DUPLEX_DIR/check-voice-duplex"
