#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v swiftc >/dev/null 2>&1; then
  echo "ERROR: Shared inbox contracts require Swift 6." >&2
  exit 69
fi
ASSIST_INBOX_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-shared-inbox.XXXXXX")"
trap 'rm -rf "$ASSIST_INBOX_CHECK_DIR"' EXIT
ASSIST_INBOX_TARGET=()
if [[ "$(uname -s)" == "Darwin" ]]; then ASSIST_INBOX_TARGET=(-target "$(uname -m)-apple-macosx15.0"); fi
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  "${ASSIST_INBOX_TARGET[@]}" -module-cache-path "$ASSIST_INBOX_CHECK_DIR/module-cache" \
  mobile/ios/Assist/Shared/AssistSharedInbox.swift scripts/check-shared-inbox.swift \
  -o "$ASSIST_INBOX_CHECK_DIR/check-shared-inbox"
"$ASSIST_INBOX_CHECK_DIR/check-shared-inbox"
