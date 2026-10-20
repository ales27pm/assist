#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v swiftc >/dev/null 2>&1; then
  echo "ERROR: native tool-loop contracts require Swift 6." >&2
  exit 69
fi
ASSIST_TOOL_LOOP_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-tool-loop.XXXXXX")"
trap 'rm -rf "$ASSIST_TOOL_LOOP_CHECK_DIR"' EXIT
ASSIST_TOOL_LOOP_TARGET=()
if [[ "$(uname -s)" == "Darwin" ]]; then ASSIST_TOOL_LOOP_TARGET=(-target "$(uname -m)-apple-macosx15.0"); fi
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  "${ASSIST_TOOL_LOOP_TARGET[@]}" \
  -module-cache-path "$ASSIST_TOOL_LOOP_CHECK_DIR/module-cache" \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistAgentCalendar.swift \
  mobile/ios/Assist/Inference/AssistGemmaToolAdapter.swift \
  mobile/ios/Assist/Inference/AssistAgentRun.swift \
  mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistExtendedTools.swift \
  mobile/ios/Assist/Inference/AssistDeviceToolAdapter.swift \
  mobile/ios/Assist/Inference/AssistDeviceToolRun.swift \
  mobile/ios/Assist/Inference/AssistToolHost.swift \
  scripts/check-device-tool-loop.swift -o "$ASSIST_TOOL_LOOP_CHECK_DIR/check-device-tool-loop"
"$ASSIST_TOOL_LOOP_CHECK_DIR/check-device-tool-loop"
