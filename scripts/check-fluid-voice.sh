#!/usr/bin/env bash
# Actual adapter ring/resampler plus production value policies; no microphone,
# model weights, network or inference. Does not qualify latency/AEC on iPhone.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != "Darwin" ]] || ! command -v xcrun >/dev/null 2>&1; then
  echo "ERROR: Fluid voice adapter checks require macOS/Xcode AVFoundation." >&2
  exit 69
fi
FLUID_VOICE_SDK="$(xcrun --sdk macosx --show-sdk-path)"
FLUID_VOICE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-fluid-voice.XXXXXX")"
trap 'rm -rf "$FLUID_VOICE_DIR"' EXIT
python3 - "$FLUID_VOICE_DIR/Policy.swift" <<'PY'
from pathlib import Path
import sys
source = Path('mobile/ios/Assist/Voice/AssistFluidVoiceRuntime.swift').read_text()
start = source.index('// BEGIN PURE FLUID CAPTURE POLICY')
end = source.index('// END PURE FLUID CAPTURE POLICY', start)
Path(sys.argv[1]).write_text('import Foundation\n' + source[start:end])
PY
xcrun --sdk macosx swiftc \
  -swift-version 6 -strict-concurrency=complete -warnings-as-errors \
  -enable-actor-data-race-checks -parse-as-library -sdk "$FLUID_VOICE_SDK" \
  -target "$(uname -m)-apple-macosx15.0" \
  -module-cache-path "$FLUID_VOICE_DIR/module-cache" \
  mobile/ios/Assist/Voice/AssistVoiceInputMeter.swift \
  mobile/ios/Assist/Voice/AssistFluidAudioInput.swift \
  "$FLUID_VOICE_DIR/Policy.swift" scripts/check-fluid-voice.swift \
  -framework AVFoundation -o "$FLUID_VOICE_DIR/check-fluid-voice"
"$FLUID_VOICE_DIR/check-fluid-voice"
