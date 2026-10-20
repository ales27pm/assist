#!/usr/bin/env bash
# Pure production admission/preparation policies, not Core AI or iPhone execution.
set -euo pipefail
cd "$(dirname "$0")/.."
SWIFTC="${SWIFTC:-swiftc}"
CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-inference-admission.XXXXXX")"
trap 'rm -rf "$CHECK_DIR"' EXIT
ASSIST_INFERENCE_TARGET=()
if [[ "$(uname -s)" == "Darwin" ]]; then ASSIST_INFERENCE_TARGET=(-target "$(uname -m)-apple-macosx15.0"); fi
"$SWIFTC" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -D ASSIST_POLICY_CHECKS "${ASSIST_INFERENCE_TARGET[@]}" -module-cache-path "$CHECK_DIR/module-cache" \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/InferencePolicyChecks.swift -o "$CHECK_DIR/check-inference-policy"
"$CHECK_DIR/check-inference-policy"
"$SWIFTC" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  "${ASSIST_INFERENCE_TARGET[@]}" -module-cache-path "$CHECK_DIR/module-cache" \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistAgentCalendar.swift \
  mobile/ios/Assist/Inference/AssistGemmaToolAdapter.swift \
  mobile/ios/Assist/Inference/AssistAgentRun.swift \
  scripts/check-inference-admission.swift -o "$CHECK_DIR/check-inference-admission"
"$CHECK_DIR/check-inference-admission"
