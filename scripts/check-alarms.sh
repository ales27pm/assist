#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v swiftc >/dev/null 2>&1; then
  echo "ERROR: Swift 6 compiler required for AlarmKit policy checks." >&2
  exit 69
fi
ASSIST_ALARM_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-alarm-policy.XXXXXX")"
trap 'rm -rf "$ASSIST_ALARM_CHECK_DIR"' EXIT
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -module-cache-path "$ASSIST_ALARM_CHECK_DIR/module-cache" \
  mobile/ios/Assist/Services/AssistAlarmPolicy.swift scripts/check-alarms.swift -o "$ASSIST_ALARM_CHECK_DIR/check"
"$ASSIST_ALARM_CHECK_DIR/check"
