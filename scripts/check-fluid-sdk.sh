#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]] || ! command -v xcrun >/dev/null 2>&1; then
  echo "ERROR: FluidAudio SDK checks require macOS and Xcode." >&2
  exit 69
fi
# Source-only SwiftPM package: no remote/binary dependency or model download.
xcrun swift test --package-path mobile/ios/AssistSpeech
