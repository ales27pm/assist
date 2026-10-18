#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v xcrun >/dev/null 2>&1; then
  ASSIST_GEMMA_SWIFTC=(xcrun swiftc)
elif command -v swiftc >/dev/null 2>&1; then
  ASSIST_GEMMA_SWIFTC=(swiftc)
else
  echo "ERROR: Swift compiler required; no native adapter qualification was performed." >&2
  exit 69
fi
ASSIST_GEMMA_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-gemma-tools.XXXXXX")"
trap 'rm -rf "$ASSIST_GEMMA_CHECK_DIR"' EXIT
"${ASSIST_GEMMA_SWIFTC[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistAgentCalendar.swift \
  mobile/ios/Assist/Inference/AssistGemmaToolAdapter.swift \
  scripts/check-gemma-tools.swift -o "$ASSIST_GEMMA_CHECK_DIR/check-gemma-tools"
"$ASSIST_GEMMA_CHECK_DIR/check-gemma-tools"
if [[ -n "${ASSIST_GEMMA_TOKENIZER_DIR:-}" ]]; then
  "$ASSIST_GEMMA_CHECK_DIR/check-gemma-tools" --fixture-json > "$ASSIST_GEMMA_CHECK_DIR/fixture.json"
  python3 scripts/check-gemma-tools-template.py --tokenizer "$ASSIST_GEMMA_TOKENIZER_DIR" \
    --fixture "$ASSIST_GEMMA_CHECK_DIR/fixture.json" --golden "$ASSIST_GEMMA_CHECK_DIR/golden.json"
fi
echo "NOTE: pure Foundation checks do not qualify Swift Tokenizers, CoreAI inference, EventKit permissions or iPhone behavior."
