# Gemma calendar tool adapter: bounded, read-only slice

This document describes the preserved calendar-only adapter. The later generic
13-tool adapter and OCR path are documented in [Device tool agent](device-tool-agent.md);
the unsupported-feature list below is scoped to the legacy calendar entry point.

This adapter is used only by the explicit calendar entry point. Ordinary generation
does not gain a tool, a new provider, or calendar permissions. Gemma, its existing
Core AI engine, its weights and the export's real context capacity remain unchanged.

## Pinned APIs and compatibility

- Apple [`coreai-models@9db7476`](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/Package.swift)
  exposes product `CoreAILM`, module `CoreAILanguageModels`, for macOS/iOS 27+.
  Its [Gemma documentation](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/models/gemma4/README.md)
  requires iOS 27.2+ for this model family. The SDK26 VM cannot compile the full app.
- [`CoreAILanguageModel`](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/swift/Sources/CoreAILanguageModels/LanguageModel/CoreAILanguageModel.swift)
  is an adapter for `FoundationModels.LanguageModel`; it can use the same local
  exported model, not necessarily Apple's system model. However, its tool capability
  depends on [`detectToolCallFormat`](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/swift/Sources/CoreAILanguageModels/ToolCallParser.swift).
  None of its recognized dialect pairs is present in this Gemma fixture's vocabulary.
  Gemma instead has `<|tool_call>` / `<tool_call|>` and its own `call:name{...}` grammar.
  We do not silently replace engine ownership with this FoundationModels adapter.
- The app-pinned [`Tokenizers@eed7264`](https://github.com/huggingface/swift-transformers/blob/eed7264ac5e4ec5dfa6165c6e5c5577364344fe4/Sources/Tokenizers/Tokenizer.swift)
  has `applyChatTemplate(messages:tools:additionalContext:)`. That overload sets
  `addGenerationPrompt: true`; the full overload also accepts `chatTemplate`,
  `truncation` and `maxLength`. There is **no `continueFinalMessage` parameter** at
  this pin. The canonical template itself continues the same model turn after an
  object-valued tool response. `decode(tokens:skipSpecialTokens:false)` is required:
  stripping specials before parsing would destroy the boundary evidence.
- The app's direct `InferenceEngine.generate(with:samplingConfiguration:inferenceOptions:)`
  returns token IDs. It is not an automatic tool executor. Apple's
  `ConstrainedGenerationCapable` is package-scoped, not an external public API.

## Closed protocol and trust boundaries

Only `calendar_list` is accepted, with three required fields in any order:
`start_iso` and `end_iso` must equal the native scope exactly; `limit` must be `5`.
The native scope defines today's local-day interval. Model output cannot widen it.
The parser accepts at most 4096 UTF-8 bytes and one entire closed call, with no
visible-text prefix/suffix, nested values, duplicate/extra keys or recovery regex.
Malformed calls fail closed; they do not trigger a calendar read.

The fixture maps `48` to `<|tool_call>`, `49` to `<tool_call|>`, `50` to
`<|tool_response>`, and `106` to `<turn|>`. The existing EOS union is `[1,106,50]`.
A call is executable only when the consumer observed stop token `50` and omitted
that token from the decoded prefix. The closed call retains token `49`. This lets
the host supply the real native result instead of allowing the model to invent it.
The stop policy applies to generated tokens, not the later prompt containing the
real tool result. A plain answer is accepted only without reserved markers and
without that observed tool-response boundary.

Planning includes the native system scope plus the existing request messages.
Continuation is an assistant message with object-valued `tool_calls.function.arguments`
and object-valued `tool_responses.response`, not a fabricated user message. Thinking
is disabled through `additionalContext["enable_thinking"] = false`. Before Jinja,
result strings and keys are recursively bounded and reject reserved markers and
partial delimiter sequences; ordinary accents, braces, commas and quotation marks
remain data. The same marker restriction applies to this dedicated request and to
public answer text. Tool results remain untrusted data, never additional authority.

## Qualification and evidence limits

### Agent-only template compatibility

The first real Swift tokenizer comparison failed: Swift-Jinja 2.5.1's
[`Lexer.swift`](https://github.com/huggingface/swift-jinja/blob/4588064a20f3fc093c95f2f7d3359999bf30cae5/Sources/Jinja/Lexer.swift)
deliberately protects a literal `{` followed by a whitespace-controlled Jinja tag
by inserting a space. This differs from Python Jinja2's canonical rendering.
Separately, the pinned tokenizer's default decode cleans spaces before punctuation.
Therefore `encode(decode(prompt)) == prompt` is not a valid general parity test.

Only the dedicated calendar path uses a compatibility copy of the canonical
template in memory. Its original SHA-256 must be
`0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5`.
At eight fixed template sites, literal braces preceding controlled tags become
Jinja expressions emitting the same brace. The asset, tokenizer config, weights,
ordinary chat template and decode settings are not modified. Unknown templates
remain usable by ordinary chat but are refused by this calendar executor.

The independent Python check requires original and compatible renders to be
byte-identical. The native test compares `applyChatTemplate` token IDs using the
compatible copy to `encode` of the **original** Python golden, with specials intact.
It does not normalize away an observed mismatch or compare cleanup-modified text.
Production checks exact special IDs plus real declaration and same-turn response
rendering using a synthetic empty observation before any private read.

`scripts/check-gemma-tools.sh` compiles the pure Foundation grammar/privacy harness
against the actual native scope and policy. With `ASSIST_GEMMA_TOKENIZER_DIR`, it
also generates an independent Python Jinja2 golden from production-adapter messages.
The fixture is identified by SHA-256 for all three tokenizer files; it is a local
validation fixture, **not an attestation of the iPhone's imported pack**.

The Swift harness has an explicit `ASSIST_GEMMA_TOKENIZER_RUNTIME` compilation path
which requires the real pinned `Tokenizers` module. Run that binary with
`--native-tokenizer <fixture-dir> <golden.json>` to compare real Swift-Jinja output
to the independent golden's exact token IDs and check special-token encode/decode.
Without that path, no native-tokenizer qualification is claimed.
Python Jinja2 output alone does not prove Swift-Jinja compatibility. No check here
proves model tool-selection accuracy, the Core AI engine on SDK27, calendar access,
real permission handling, or physical-device behavior. No EAS build is part of this
adapter qualification.

The archived build27 Xcode log records the transitive versions actually resolved:
Jinja 2.5.1, swift-collections 1.7.3, swift-crypto 4.5.2, swift-huggingface 0.13.0,
yyjson 0.12.0, and Tokenizers' repository at `eed7264`. The primary GitHub tag
[`swift-jinja/2.5.1`](https://github.com/huggingface/swift-jinja/tree/4588064a20f3fc093c95f2f7d3359999bf30cae5)
resolves to `4588064a20f3fc093c95f2f7d3359999bf30cae5`. No `Package.resolved` is
present in the app source archive. A test using a different compatible offline
resolution must identify that combination explicitly, not claim exact IPA parity.

Unsupported: generic tool dispatch, arbitrary JSON/XML/ATEM recovery, multiple
calls, recurring agent loops, generated IDs granting authority, calendar writes,
unknown scopes, and execution of commands embedded in visible assistant prose.
