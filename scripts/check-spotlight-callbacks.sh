#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v swiftc >/dev/null || { echo 'ERROR: Swift 6 compiler required.' >&2; exit 69; }
ASSIST_SPOTLIGHT_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-spotlight-callbacks.XXXXXX")"
trap 'rm -rf "$ASSIST_SPOTLIGHT_CHECK_DIR"' EXIT
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -enable-actor-data-race-checks -D ASSIST_SPOTLIGHT_CALLBACK_TESTS -O \
  -module-cache-path "$ASSIST_SPOTLIGHT_CHECK_DIR/cache" \
  mobile/ios/Assist/Services/AssistDocumentSpotlight.swift \
  scripts/check-spotlight-callbacks.swift -o "$ASSIST_SPOTLIGHT_CHECK_DIR/check"
"$ASSIST_SPOTLIGHT_CHECK_DIR/check"
