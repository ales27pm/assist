#!/usr/bin/env python3
"""Offline HF control for a local Gemma checkpoint and finalized iOS palettes.

Requires the pinned export Python environment. This checks compression fidelity,
not the compiled Core AI graph, Swift runtime, performance, or iPhone execution.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

from gemma_contracts import checkpoint_manifest, diagnostic_suite, finalized_palette_paths


def compact(text):
    return ''.join(text.split())


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def reconstruct(indices, lut):
    import torch

    if indices.dtype != torch.uint8 or lut.dtype != torch.float16:
        raise ValueError('Expected U8 indices and F16 LUT')
    if lut.ndim != indices.ndim + 2 or lut.shape[-1] != 1:
        raise ValueError('Only scalar palettes are supported')
    if any(size != 1 for size in lut.shape[1:-2]):
        raise ValueError('Only output-channel grouped palettes are supported')
    groups = lut.shape[0]
    if indices.shape[0] % groups or lut.shape[-2] not in (16, 64, 256):
        raise ValueError('Unexpected group shape or palette size')
    # Avoid the generic eager LUT op's weight_count * palette_size temporary.
    return torch.gather(lut.reshape(groups, -1), 1,
                        indices.reshape(groups, -1).long()).reshape(indices.shape)


def replace_palettes(model, directory):
    import torch
    from safetensors import safe_open

    paths = finalized_palette_paths(directory)
    for path in paths:
        prefix = 'extend.model.'
        name = path.name.removesuffix('.safetensors')
        if not name.startswith(prefix):
            raise ValueError('Unexpected cached parameter name')
        name = 'model.language_model.' + name.removeprefix(prefix)
        parent_name, attribute = name.rsplit('.', 1)
        parent = model.get_submodule(parent_name)
        previous = getattr(parent, attribute)
        with safe_open(path, framework='pt', device='cpu') as stream:
            if set(stream.keys()) != {'lut', 'indices'}:
                raise ValueError('Unexpected cached parameter tensors')
            weight = reconstruct(stream.get_tensor('indices'), stream.get_tensor('lut'))
        if weight.numel() != previous.numel() or weight.dtype != previous.dtype:
            raise ValueError('Cached weight does not match checkpoint shape/dtype')
        setattr(parent, attribute,
                torch.nn.Parameter(weight.reshape(previous.shape), requires_grad=False))


def replace_embeddings(model, ple_path):
    import torch
    from safetensors import safe_open

    embedding = model.model.language_model.embed_tokens
    weight = embedding.weight.detach()
    max_abs = weight.new_zeros(())
    for start in range(0, weight.shape[0], 8192):
        max_abs = torch.maximum(max_abs, weight[start:start+8192].abs().max())
    scale = torch.clamp(max_abs, min=1e-6) / 127
    dense = torch.empty_like(weight)
    for start in range(0, weight.shape[0], 8192):
        quantized = torch.clamp(torch.round(weight[start:start+8192] / scale), -128, 127).to(torch.int8)
        dense[start:start+8192] = (quantized.float() * scale).to(weight.dtype)
    embedding.weight = torch.nn.Parameter(dense, requires_grad=False)
    model.lm_head.weight = embedding.weight
    with safe_open(ple_path, framework='pt', device='cpu') as stream:
        metadata = stream.metadata()
        if (set(stream.keys()) != {'embed_tokens_per_layer'}
                or metadata.get('ple_zero_point') != '0'
                or float(metadata['embed_scale']) != 16):
            raise ValueError('Unexpected PLE sidecar contract')
        table = stream.get_tensor('embed_tokens_per_layer')
    if table.dtype != torch.int8 or tuple(table.shape) != (262144, 8960):
        raise ValueError('Unexpected PLE table shape/dtype')

    class ScaledPLE(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.register_buffer('table', table)
            self.register_buffer('scale', torch.tensor(float(metadata['ple_scale']), dtype=torch.float16))

        def forward(self, input_ids):
            # Sidecar includes sqrt(256); do not apply HF's embedding scale twice.
            return (self.table[input_ids].float() * self.scale).to(torch.float16)

    model.model.language_model.embed_tokens_per_layer = ScaledPLE()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--checkpoint-sha256', help='Trusted SHA-256 of model.safetensors')
    parser.add_argument('--checkpoint-manifest-sha256', help='Trusted complete checkpoint inventory SHA-256')
    parser.add_argument('--print-checkpoint-manifest', action='store_true',
                        help='Print the inventory and its digest without loading a model; does not authenticate the source')
    parser.add_argument('--palettes', type=Path)
    parser.add_argument('--ple', type=Path, help='Also simulate the recipe INT8 main embedding and this PLE sidecar')
    parser.add_argument('--cases', type=Path,
                        default=Path(__file__).resolve().parent / 'fixtures/gemma-quality.json')
    parser.add_argument('--output', type=Path, help='New result file; required for inference, existing files are refused')
    args = parser.parse_args()
    if not args.print_checkpoint_manifest:
        if not args.output or not args.checkpoint_sha256 or not args.checkpoint_manifest_sha256:
            parser.error('Inference requires --output, --checkpoint-sha256 and --checkpoint-manifest-sha256')
        if args.output.exists():
            parser.error('Refusing to overwrite an earlier result')
    try:
        manifest, manifest_digest = checkpoint_manifest(args.checkpoint)
    except ValueError as exc:
        parser.error(str(exc))
    if args.print_checkpoint_manifest:
        print(json.dumps({'checkpoint_manifest': manifest,
                          'checkpoint_manifest_sha256': manifest_digest}, indent=2))
        return
    if manifest_digest != args.checkpoint_manifest_sha256:
        parser.error('Complete checkpoint manifest SHA-256 mismatch')
    digest = next(row['sha256'] for row in manifest['files'] if row['file'] == 'model.safetensors')
    if digest != args.checkpoint_sha256:
        parser.error('Checkpoint SHA-256 mismatch')
    try:
        suite, suite_digest = diagnostic_suite(args.cases)
    except ValueError as exc:
        parser.error(str(exc))
    cases = suite['cases']
    for key in ('HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HUGGINGFACE_HUB_TOKEN'):
        os.environ.pop(key, None)
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                      HF_HUB_DISABLE_IMPLICIT_TOKEN='1', TOKENIZERS_PARALLELISM='false')
    import torch
    import transformers
    from transformers import AutoTokenizer, Gemma4ForConditionalGeneration

    torch.set_num_threads(2)
    torch.set_num_interop_threads(2)
    palette_inventory = ([{'file': path.name, 'sha256': sha256(path)}
                          for path in finalized_palette_paths(args.palettes)]
                         if args.palettes else [])
    ple_sha256 = sha256(args.ple) if args.ple else None
    model = Gemma4ForConditionalGeneration.from_pretrained(
        args.checkpoint, local_files_only=True, dtype=torch.float16, attn_implementation='eager').eval()
    tokenizer = AutoTokenizer.from_pretrained(args.checkpoint, local_files_only=True)
    if args.palettes:
        replace_palettes(model, args.palettes)
    if args.ple:
        replace_embeddings(model, args.ple)
    results = []
    for case in cases:
        ids = tokenizer.apply_chat_template(case['messages'], add_generation_prompt=True,
                                            tokenize=True, return_dict=False)
        inputs = torch.tensor([ids], dtype=torch.int64)
        started = time.monotonic()
        with torch.inference_mode():
            output = model.generate(input_ids=inputs, attention_mask=torch.ones_like(inputs),
                                    do_sample=False, max_new_tokens=64, use_cache=True,
                                    pad_token_id=0, eos_token_id=[1, 106, 50])
        generated = output[0, len(ids):].tolist()
        text = tokenizer.decode(generated, skip_special_tokens=True, clean_up_tokenization_spaces=False)
        row = {'id': case['id'], 'prompt_token_ids': ids, 'generated_token_ids': generated,
               'text': text, 'expected': case['expected'], 'passed': compact(text) == compact(case['expected']),
               'seconds': time.monotonic()-started}
        results.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    result = {'scope': 'CPU HF forward; compiled Core AI and iPhone remain unverified',
              'checkpoint_sha256': digest, 'checkpoint_manifest': manifest,
              'checkpoint_manifest_sha256': manifest_digest, 'suite_sha256': suite_digest,
              'palettes': args.palettes is not None, 'int8_embeddings': args.ple is not None,
              'palette_inventory': palette_inventory, 'ple_sha256': ple_sha256,
              'torch_version': torch.__version__, 'transformers_version': transformers.__version__,
              'passed': all(row['passed'] for row in results),
              'results': results}
    with args.output.open('x') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    raise SystemExit(0 if result['passed'] else 1)


if __name__ == '__main__':
    main()
