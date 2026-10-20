#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v swiftc >/dev/null || { echo 'ERROR: thought-tree contracts require Swift 6.' >&2; exit 69; }
ASSIST_THOUGHT_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-thought-tree.XXXXXX")"
trap 'rm -rf "$ASSIST_THOUGHT_CHECK_DIR"' EXIT
ASSIST_THOUGHT_TARGET=()
if [[ "$(uname -s)" == "Darwin" ]]; then ASSIST_THOUGHT_TARGET=(-target "$(uname -m)-apple-macosx15.0"); fi
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  "${ASSIST_THOUGHT_TARGET[@]}" -module-cache-path "$ASSIST_THOUGHT_CHECK_DIR/cache" \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistExtendedTools.swift \
  mobile/ios/Assist/Inference/AssistThoughtTree.swift \
  scripts/check-thought-tree.swift -o "$ASSIST_THOUGHT_CHECK_DIR/check-thought-tree"
"$ASSIST_THOUGHT_CHECK_DIR/check-thought-tree" "$@"
