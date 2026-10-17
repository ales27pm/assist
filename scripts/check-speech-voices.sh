#!/usr/bin/env bash
# Production value-contract checks only: Foundation, no audio, microphone or permissions.
# This complements the iOS SDK pipeline; it does not build the app or qualify a device.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != "Darwin" ]] || ! command -v xcrun >/dev/null 2>&1; then
  echo "ERROR: speech voice checks require macOS and Xcode's Foundation SDK." >&2
  exit 69
fi
SPEECH_VOICES_SDK="$(xcrun --sdk macosx --show-sdk-path)"
SPEECH_VOICES_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-speech-voices.XXXXXX")"
trap 'rm -rf "$SPEECH_VOICES_DIR"' EXIT
# Extract the real production helpers; fail closed on missing, duplicated or reversed markers.
if ! awk '
  BEGIN { print "import Foundation" }
  /^\/\/ BEGIN PREVIEW VALUE CONTRACTS([[:space:]]|$)/ {
    starts++; if (active || ends) invalid=1; active=1; next
  }
  /^\/\/ END PREVIEW VALUE CONTRACTS([[:space:]]|$)/ {
    ends++; if (!active) invalid=1; active=0; next
  }
  active { print }
  END { if (starts != 1 || ends != 1 || active || invalid) exit 65 }
' mobile/ios/Assist/Voice/AssistVoice.swift > "$SPEECH_VOICES_DIR/contracts.swift"; then
  echo "ERROR: expected exactly one ordered PREVIEW VALUE CONTRACTS marker pair." >&2
  exit 65
fi
xcrun --sdk macosx swiftc \
  -swift-version 6 -strict-concurrency=complete -warnings-as-errors \
  -enable-actor-data-race-checks -parse-as-library -sdk "$SPEECH_VOICES_SDK" \
  -target "$(uname -m)-apple-macosx15.0" \
  -module-cache-path "$SPEECH_VOICES_DIR/module-cache" \
  "$SPEECH_VOICES_DIR/contracts.swift" scripts/check-speech-voices.swift \
  -o "$SPEECH_VOICES_DIR/check-speech-voices"
"$SPEECH_VOICES_DIR/check-speech-voices"
