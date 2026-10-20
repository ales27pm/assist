#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v xcrun >/dev/null 2>&1; then
  ASSIST_DEVICE_TOOLS_SWIFTC=(xcrun swiftc)
elif command -v swiftc >/dev/null 2>&1; then
  ASSIST_DEVICE_TOOLS_SWIFTC=(swiftc)
else
  echo "ERROR: Swift compiler required; no device-tools runtime checks were performed." >&2
  exit 69
fi
ASSIST_DEVICE_TOOLS_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-device-tools.XXXXXX")"
trap 'rm -rf "$ASSIST_DEVICE_TOOLS_CHECK_DIR"' EXIT
"${ASSIST_DEVICE_TOOLS_SWIFTC[@]}" -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistAgentCalendar.swift \
  mobile/ios/Assist/Inference/AssistGemmaToolAdapter.swift \
  mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistExtendedTools.swift \
  mobile/ios/Assist/Inference/AssistToolHost.swift \
  mobile/ios/Assist/Inference/AssistDeviceToolAdapter.swift \
  scripts/check-device-tools.swift -o "$ASSIST_DEVICE_TOOLS_CHECK_DIR/check-device-tools"
"$ASSIST_DEVICE_TOOLS_CHECK_DIR/check-device-tools"
if [[ -n "${ASSIST_GEMMA_TOKENIZER_DIR:-}" ]]; then
  "$ASSIST_DEVICE_TOOLS_CHECK_DIR/check-device-tools" --fixture-json > "$ASSIST_DEVICE_TOOLS_CHECK_DIR/fixture.json"
  python3 - "$ASSIST_GEMMA_TOKENIZER_DIR" "$ASSIST_DEVICE_TOOLS_CHECK_DIR/fixture.json" "$ASSIST_DEVICE_TOOLS_CHECK_DIR/golden.json" <<'PY'
import hashlib
import json
import re
import sys
from pathlib import Path
from jinja2 import TemplateError
from jinja2.sandbox import ImmutableSandboxedEnvironment

directory, fixture_path, golden_path = map(Path, sys.argv[1:])
template_text = (directory / "chat_template.jinja").read_text()
assert hashlib.sha256(template_text.encode()).hexdigest() == "0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5"
fixture = json.loads(fixture_path.read_text())
environment = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True)
def reject(message):
    raise TemplateError(message)
environment.globals["raise_exception"] = reject
template = environment.from_string(template_text)
compatible = environment.from_string(re.sub(r"\{\s+(?=\{[%{]-)", "{{ '{' }}", template_text))
def render(messages, selected=template, tools=None):
    return selected.render(messages=messages, tools=fixture["tools"] if tools is None else tools, add_generation_prompt=True,
                           bos_token=fixture["bosToken"], eos_token=fixture["eosToken"], **fixture["additionalContext"])
golden = {"planning": render(fixture["planningMessages"]), "continuation": render(fixture["continuationMessages"]),
          "multi": render(fixture["multiMessages"]),
          "subsetPlanning": render(fixture["planningMessages"], tools=fixture["subsetTools"]),
          "subsetContinuation": render(fixture["continuationMessages"], tools=fixture["subsetTools"])}
for name, field in [("planning", "planningMessages"), ("continuation", "continuationMessages"), ("multi", "multiMessages")]:
    assert render(fixture[field], compatible) == golden[name]
    for tool in fixture["tools"]:
        assert golden[name].count("declaration:" + tool["function"]["name"] + "{") == 1
assert golden["planning"].endswith("<|turn>model\n")
assert golden["continuation"].endswith("<tool_response|>")
assert "Réunion {équipe}, \"édition\"" in golden["continuation"]
multi = golden["multi"]
assert multi.count("<|turn>model\n") == 1
assert multi.endswith("<tool_response|>")
offset = 0
for name in fixture["multiNames"]:
    opening = multi.index("<|tool_call>call:" + name + "{", offset)
    response = multi.index("}<tool_call|><|tool_response>response:" + name + "{", opening)
    assert "<|tool_call>" not in multi[opening + 13:response]
    offset = multi.index("<tool_response|>", response) + len("<tool_response|>")
assert offset == len(multi)
assert "limit:5.0" not in multi
for name, field in [("subsetPlanning", "planningMessages"), ("subsetContinuation", "continuationMessages")]:
    assert render(fixture[field], compatible, tools=fixture["subsetTools"]) == golden[name]
    assert golden[name].count("<|tool>declaration:") == 1
    assert golden[name].count("declaration:calendar_list{") == 1
    assert "declaration:device_capabilities{" not in golden[name]
golden_path.write_text(json.dumps(golden, ensure_ascii=False, sort_keys=True))
print("PASS: independent pinned canonical Jinja rendering; complete and calendar-only declarations; chronological four-call same-turn continuation; no floating limits")
PY
  "$ASSIST_DEVICE_TOOLS_CHECK_DIR/check-device-tools" --golden-json "$ASSIST_DEVICE_TOOLS_CHECK_DIR/golden.json"
fi
echo "LIMIT: pure Foundation/Python checks do not qualify Swift-Jinja token IDs, CoreAI execution, native permission prompts or iPhone behavior."
