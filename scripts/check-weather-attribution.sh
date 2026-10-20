#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ASSIST_MARK_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-mark-contract.XXXXXX")"
trap 'rm -rf "$ASSIST_MARK_CHECK_DIR"' EXIT
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -module-cache-path "$ASSIST_MARK_CHECK_DIR/module-cache" \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistExtendedTools.swift \
  mobile/ios/Assist/Services/AssistWeatherAttributionPolicy.swift \
  scripts/check-weather-attribution.swift -o "$ASSIST_MARK_CHECK_DIR/check"
"$ASSIST_MARK_CHECK_DIR/check"
if [[ "$(uname -s)" == "Darwin" ]]; then
  swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
    -module-cache-path "$ASSIST_MARK_CHECK_DIR/module-cache" \
    mobile/ios/Assist/Inference/InferencePolicy.swift \
    mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistExtendedTools.swift \
    mobile/ios/Assist/Services/AssistWeatherAttributionPolicy.swift \
    mobile/ios/Assist/Services/AssistWeatherAttribution.swift \
    scripts/check-weather-attribution-image.swift -o "$ASSIST_MARK_CHECK_DIR/image-check"
  "$ASSIST_MARK_CHECK_DIR/image-check"
fi
