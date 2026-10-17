#!/usr/bin/env bash
# Exercises aggregate PCM diagnostics without microphone access or permissions.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: native voice input checks require macOS and the Apple AVFoundation SDK." >&2
  exit 69
fi
if ! command -v xcrun >/dev/null 2>&1; then
  echo "ERROR: xcrun/Xcode is missing; native voice input checks cannot run." >&2
  exit 69
fi
if ! VOICE_INPUT_CHECK_SDK="$(xcrun --sdk macosx --show-sdk-path)"; then
  echo "ERROR: the macOS SDK is unavailable; select an installed Xcode before running this check." >&2
  exit 69
fi

VOICE_INPUT_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-voice-input.XXXXXX")"
trap 'rm -rf "$VOICE_INPUT_CHECK_DIR"' EXIT

xcrun --sdk macosx swiftc \
  -swift-version 6 -strict-concurrency=complete -warnings-as-errors \
  -enable-actor-data-race-checks -parse-as-library -sdk "$VOICE_INPUT_CHECK_SDK" \
  -target "$(uname -m)-apple-macosx15.0" \
  -module-cache-path "$VOICE_INPUT_CHECK_DIR/module-cache" \
  mobile/ios/Assist/Voice/AssistVoiceInputMeter.swift \
  scripts/check-voice-input.swift \
  -framework AVFoundation \
  -o "$VOICE_INPUT_CHECK_DIR/check-voice-input"

"$VOICE_INPUT_CHECK_DIR/check-voice-input"
