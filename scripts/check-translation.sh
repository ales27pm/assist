#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v swiftc >/dev/null 2>&1; then
  echo "ERROR: Swift 6 compiler required for translation contracts." >&2
  exit 69
fi
ASSIST_TRANSLATION_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-translation-contract.XXXXXX")"
trap 'rm -rf "$ASSIST_TRANSLATION_CHECK_DIR"' EXIT
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -module-cache-path "$ASSIST_TRANSLATION_CHECK_DIR/module-cache" \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistExtendedTools.swift \
  mobile/ios/Assist/Services/AssistTranslationPolicy.swift \
  scripts/check-translation.swift -o "$ASSIST_TRANSLATION_CHECK_DIR/check"
"$ASSIST_TRANSLATION_CHECK_DIR/check"
