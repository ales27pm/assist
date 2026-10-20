#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v swiftc >/dev/null || { echo 'ERROR: Swift 6 compiler required.' >&2; exit 69; }
ASSIST_DOCUMENT_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-document-policy.XXXXXX")"
trap 'rm -rf "$ASSIST_DOCUMENT_CHECK_DIR"' EXIT
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -module-cache-path "$ASSIST_DOCUMENT_CHECK_DIR/cache" \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistAgentCalendar.swift \
  mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistExtendedTools.swift \
  mobile/ios/Assist/Services/AssistDocumentActionsPolicy.swift \
  scripts/check-document-actions.swift -o "$ASSIST_DOCUMENT_CHECK_DIR/check"
"$ASSIST_DOCUMENT_CHECK_DIR/check"
