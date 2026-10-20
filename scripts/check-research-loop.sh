#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v swiftc >/dev/null 2>&1; then
  echo "ERROR: Swift 6 compiler required for research-loop contracts." >&2
  exit 69
fi
ASSIST_RESEARCH_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-research-loop.XXXXXX")"
trap 'rm -rf "$ASSIST_RESEARCH_CHECK_DIR"' EXIT
ASSIST_RESEARCH_TARGET=()
if [[ "$(uname -s)" == "Darwin" ]]; then ASSIST_RESEARCH_TARGET=(-target "$(uname -m)-apple-macosx15.0"); fi
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  "${ASSIST_RESEARCH_TARGET[@]}" \
  -module-cache-path "$ASSIST_RESEARCH_CHECK_DIR/module-cache" \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistAgentCalendar.swift \
  mobile/ios/Assist/Inference/AssistGemmaToolAdapter.swift \
  mobile/ios/Assist/Inference/AssistAgentRun.swift \
  mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistExtendedTools.swift \
  mobile/ios/Assist/Services/AssistPrivateServicePolicy.swift \
  mobile/ios/Assist/Inference/AssistResearchAdapter.swift \
  mobile/ios/Assist/Inference/AssistResearchRun.swift \
  scripts/check-research-loop.swift -o "$ASSIST_RESEARCH_CHECK_DIR/check-research-loop"
"$ASSIST_RESEARCH_CHECK_DIR/check-research-loop"
if [[ -n "${ASSIST_GEMMA_TOKENIZER_DIR:-}" ]]; then
  "$ASSIST_RESEARCH_CHECK_DIR/check-research-loop" --fixture-json > "$ASSIST_RESEARCH_CHECK_DIR/fixture.json"
  python3 - "$ASSIST_GEMMA_TOKENIZER_DIR" "$ASSIST_RESEARCH_CHECK_DIR/fixture.json" "$ASSIST_RESEARCH_CHECK_DIR/golden.json" <<'PY'
import hashlib
import json
import re
import sys
from pathlib import Path
from jinja2 import TemplateError
from jinja2.sandbox import ImmutableSandboxedEnvironment

directory, fixture_path, golden_path = map(Path, sys.argv[1:])
text = (directory / "chat_template.jinja").read_text()
assert hashlib.sha256(text.encode()).hexdigest() == "0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5"
fixture = json.loads(fixture_path.read_text())
environment = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True)
def reject(message):
    raise TemplateError(message)
environment.globals["raise_exception"] = reject
canonical = environment.from_string(text)
pattern = r"\{\s+(?=\{[%{]-)"
assert len(re.findall(pattern, text)) == 8
compatible = environment.from_string(re.sub(pattern, "{{ '{' }}", text))
def render(messages, template):
    return template.render(messages=messages, tools=fixture["tools"], add_generation_prompt=True,
                           bos_token=fixture["bosToken"], eos_token=fixture["eosToken"], **fixture["additionalContext"])
golden = {}
for name, field in [("planning", "planningMessages"), ("continuation", "continuationMessages"), ("multi", "multiMessages")]:
    rendered = render(fixture[field], canonical)
    assert render(fixture[field], compatible) == rendered
    assert rendered.count("<|tool>declaration:") == 2
    assert rendered.count("declaration:web_search{") == 1
    assert rendered.count("declaration:web_read{") == 1
    assert "declaration:calendar_list{" not in rendered
    golden[name] = rendered
assert golden["planning"].endswith("<|turn>model\n")
assert golden["continuation"].endswith("<tool_response|>")
multi = golden["multi"]
assert multi.count("<|turn>model\n") == 1
assert multi.endswith("<tool_response|>")
assert 'Texte public {équipe}, "édition".' in multi
offset = 0
for name in fixture["multiNames"]:
    opening = multi.index("<|tool_call>call:" + name + "{", offset)
    response = multi.index("}<tool_call|><|tool_response>response:" + name + "{", opening)
    assert "<|tool_call>" not in multi[opening + 13:response]
    offset = multi.index("<tool_response|>", response) + len("<tool_response|>")
assert offset == len(multi)
golden_path.write_text(json.dumps(golden, ensure_ascii=False, sort_keys=True))
print("PASS: independent pinned canonical Jinja research rendering; two closed declarations and chronological five-call continuation")
PY
  "$ASSIST_RESEARCH_CHECK_DIR/check-research-loop" --golden-json "$ASSIST_RESEARCH_CHECK_DIR/golden.json"
fi
echo "LIMIT: Foundation/Jinja checks do not qualify native Swift-Jinja token IDs, CoreAI generation, network transport or iPhone behavior."
