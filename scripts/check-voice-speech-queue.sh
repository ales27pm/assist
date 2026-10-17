#!/usr/bin/env bash
# Exercises queue state and utterance metadata without synthesis or permissions.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: native voice speech queue checks require macOS and the Apple AVFoundation SDK." >&2
  exit 69
fi
if ! command -v xcrun >/dev/null 2>&1; then
  echo "ERROR: xcrun/Xcode is missing; native voice speech queue checks cannot run." >&2
  exit 69
fi
if ! VOICE_QUEUE_CHECK_SDK="$(xcrun --sdk macosx --show-sdk-path)"; then
  echo "ERROR: the macOS SDK is unavailable; select an installed Xcode before running this check." >&2
  exit 69
fi

VOICE_QUEUE_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-voice-speech-queue.XXXXXX")"
trap 'rm -rf "$VOICE_QUEUE_CHECK_DIR"' EXIT

xcrun --sdk macosx swiftc \
  -swift-version 6 -strict-concurrency=complete -warnings-as-errors \
  -enable-actor-data-race-checks -parse-as-library -sdk "$VOICE_QUEUE_CHECK_SDK" \
  -target "$(uname -m)-apple-macosx15.0" \
  -module-cache-path "$VOICE_QUEUE_CHECK_DIR/module-cache" \
  mobile/ios/Assist/Voice/AssistVoiceSpeechQueue.swift \
  scripts/check-voice-speech-queue.swift \
  -framework AVFoundation \
  -o "$VOICE_QUEUE_CHECK_DIR/check-voice-speech-queue"

"$VOICE_QUEUE_CHECK_DIR/check-voice-speech-queue"
