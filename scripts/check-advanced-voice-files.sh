#!/usr/bin/env bash
# Exercises actual production disk/hash helpers; no model, network or microphone.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]] || ! command -v xcrun >/dev/null 2>&1; then
  echo "ERROR: advanced voice file checks require macOS and Xcode." >&2
  exit 69
fi
ADVANCED_FILES_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-advanced-files.XXXXXX")"
trap 'rm -rf "$ADVANCED_FILES_DIR"' EXIT
awk '
  BEGIN { print "import CryptoKit\nimport Darwin\nimport FileProvider\nimport Foundation" }
  /^\/\/ BEGIN ADVANCED VOICE FILE CONTRACTS$/ { starts++; if (active || ends) invalid=1; active=1; next }
  /^\/\/ END ADVANCED VOICE FILE CONTRACTS$/ { ends++; if (!active) invalid=1; active=0; next }
  active { print }
  END { if (starts != 1 || ends != 1 || active || invalid) exit 65 }
' mobile/ios/Assist/Voice/AssistAdvancedVoiceResources.swift > "$ADVANCED_FILES_DIR/contracts.swift"
xcrun --sdk macosx swiftc -swift-version 6 -strict-concurrency=complete \
  -warnings-as-errors -parse-as-library -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -module-cache-path "$ADVANCED_FILES_DIR/module-cache" \
  "$ADVANCED_FILES_DIR/contracts.swift" scripts/check-advanced-voice-files.swift \
  -o "$ADVANCED_FILES_DIR/check-advanced-voice-files"
"$ADVANCED_FILES_DIR/check-advanced-voice-files"
