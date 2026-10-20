#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v swiftc >/dev/null 2>&1; then
  echo "ERROR: Swift 6 compiler required for private-service contracts." >&2
  exit 69
fi
ASSIST_PRIVATE_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-private-contract.XXXXXX")"
trap 'rm -rf "$ASSIST_PRIVATE_CHECK_DIR"' EXIT
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -module-cache-path "$ASSIST_PRIVATE_CHECK_DIR/module-cache" \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistExtendedTools.swift \
  mobile/ios/Assist/Services/AssistPrivateServicePolicy.swift \
  scripts/check-private-service.swift -o "$ASSIST_PRIVATE_CHECK_DIR/check"
"$ASSIST_PRIVATE_CHECK_DIR/check"
