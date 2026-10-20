#!/usr/bin/env bash
# Real bounded persistence/state-machine checks; no model, network or iOS tool.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v swiftc >/dev/null 2>&1; then
  echo "ERROR: task checkpoint contracts require Swift 6." >&2
  exit 69
fi
ASSIST_CHECKPOINT_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-checkpoints.XXXXXX")"
trap 'rm -rf "$ASSIST_CHECKPOINT_CHECK_DIR"' EXIT
ASSIST_CHECKPOINT_TARGET=()
if [[ "$(uname -s)" == "Darwin" ]]; then ASSIST_CHECKPOINT_TARGET=(-target "$(uname -m)-apple-macosx15.0"); fi
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  "${ASSIST_CHECKPOINT_TARGET[@]}" \
  -module-cache-path "$ASSIST_CHECKPOINT_CHECK_DIR/module-cache" \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistExtendedTools.swift \
  mobile/ios/Assist/Services/AssistTaskCheckpoint.swift \
  scripts/check-task-checkpoints.swift -o "$ASSIST_CHECKPOINT_CHECK_DIR/check-task-checkpoints"
"$ASSIST_CHECKPOINT_CHECK_DIR/check-task-checkpoints"
