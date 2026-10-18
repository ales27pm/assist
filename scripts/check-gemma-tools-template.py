#!/usr/bin/env python3
"""Independent real-template golden. This is NOT Swift tokenizer qualification."""
import argparse
import hashlib
import json
import re
from pathlib import Path

from jinja2 import TemplateError
from jinja2.sandbox import ImmutableSandboxedEnvironment


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--golden", type=Path, required=True)
    args = parser.parse_args()
    expected_hashes = {
        "chat_template.jinja": "0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5",
        "tokenizer_config.json": "ae79d5349f543e549ca2721755b030dbba92614e25585f4c7e9aaa3734dfa6ae",
        "tokenizer.json": "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f",
    }
    for name, digest in expected_hashes.items():
        assert hashlib.sha256((args.tokenizer / name).read_bytes()).hexdigest() == digest, f"wrong fixture identity: {name}"
    tokenizer = json.loads((args.tokenizer / "tokenizer.json").read_text())
    tokens = {entry["content"]: entry["id"] for entry in tokenizer["added_tokens"]}
    assert {name: tokens[name] for name in ["<eos>", "<|tool_call>", "<tool_call|>", "<|tool_response>", "<tool_response|>", "<turn|>"]} == {
        "<eos>": 1, "<|tool_call>": 48, "<tool_call|>": 49, "<|tool_response>": 50, "<tool_response|>": 51, "<turn|>": 106,
    }
    fixture = json.loads(args.fixture.read_text())
    environment = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True)

    def reject(message):
        raise TemplateError(message)

    environment.globals["raise_exception"] = reject
    template = environment.from_string((args.tokenizer / "chat_template.jinja").read_text())

    def render(messages, tools=None, template_override=None):
        selected = template if template_override is None else template_override
        return selected.render(messages=messages, tools=fixture["tools"] if tools is None else tools,
                               add_generation_prompt=True, bos_token=fixture["bosToken"], eos_token=fixture["eosToken"],
                               **fixture["additionalContext"])

    planning = render(fixture["planningMessages"])
    continuation = render(fixture["continuationMessages"])
    original_template = (args.tokenizer / "chat_template.jinja").read_text()
    brace_pattern = r"\{\s+(?=\{[%{]-)"
    assert len(re.findall(brace_pattern, original_template)) == 8
    compatible_template = environment.from_string(re.sub(brace_pattern, "{{ '{' }}", original_template))
    assert render(fixture["planningMessages"], template_override=compatible_template) == planning
    assert render(fixture["continuationMessages"], template_override=compatible_template) == continuation
    assert "declaration:calendar_list" in planning
    assert "declaration:calendar_list" not in render(fixture["planningMessages"], [])
    assert planning.endswith("<|turn>model\n")
    assert "<|tool_call>call:calendar_list{" in continuation
    assert "}<tool_call|><|tool_response>response:calendar_list{" in continuation
    assert continuation.endswith("<tool_response|>")
    assert continuation.count("<|turn>model\n") == 1
    assert "Réunion {équipe}, \"édition\"" in continuation
    bad = json.loads(json.dumps(fixture["continuationMessages"]))
    bad[-1]["tool_calls"][0]["function"]["arguments"] = "{}"
    try:
        render(bad)
    except TemplateError as error:
        assert "JSON object (mapping), not a string" in str(error)
    else:
        raise AssertionError("string arguments accepted")
    args.golden.write_text(json.dumps({"planning": planning, "continuation": continuation,
                                      "fixtureSHA256": expected_hashes}, ensure_ascii=False, sort_keys=True))
    print("PASS: independent Jinja2 golden, exact real fixture identity, declaration, native object continuation, punctuation and special IDs")
    print("LIMIT: not Swift-Jinja/AutoTokenizer, not model inference, not EventKit and not device qualification")


if __name__ == "__main__":
    main()
