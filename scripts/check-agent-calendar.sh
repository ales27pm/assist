#!/usr/bin/env bash
# Pure Foundation contracts; no model load, EventKit access or permission prompt.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v swiftc >/dev/null 2>&1; then
  echo "ERROR: agent calendar contracts require a Swift 6 compiler." >&2
  exit 69
fi
AGENT_CALENDAR_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-agent-calendar.XXXXXX")"
trap 'rm -rf "$AGENT_CALENDAR_DIR"' EXIT
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -module-cache-path "$AGENT_CALENDAR_DIR/module-cache" \
  mobile/ios/Assist/Inference/AssistAgentCalendar.swift scripts/check-agent-calendar.swift \
  -o "$AGENT_CALENDAR_DIR/check-agent-calendar"
"$AGENT_CALENDAR_DIR/check-agent-calendar"
