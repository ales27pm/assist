#!/usr/bin/env bash
# The production coordinator with scripted test collaborators, never a model or calendar.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v swiftc >/dev/null 2>&1; then
  echo "ERROR: native agent-loop contracts require Swift 6." >&2
  exit 69
fi
ASSIST_AGENT_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-agent-loop.XXXXXX")"
trap 'rm -rf "$ASSIST_AGENT_CHECK_DIR"' EXIT
ASSIST_AGENT_TARGET=()
if [[ "$(uname -s)" == "Darwin" ]]; then ASSIST_AGENT_TARGET=(-target "$(uname -m)-apple-macosx15.0"); fi
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  "${ASSIST_AGENT_TARGET[@]}" \
  -module-cache-path "$ASSIST_AGENT_CHECK_DIR/module-cache" \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistAgentCalendar.swift \
  mobile/ios/Assist/Inference/AssistGemmaToolAdapter.swift \
  mobile/ios/Assist/Inference/AssistAgentRun.swift \
  scripts/check-agent-loop.swift -o "$ASSIST_AGENT_CHECK_DIR/check-agent-loop"
"$ASSIST_AGENT_CHECK_DIR/check-agent-loop"
