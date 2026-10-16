"""Small, dependency-free contracts shared by Gemma export and quality checks."""
import hashlib
import json


CANONICAL_SUITE_SHA256 = '1d0183e52e673d105deb2b12b7d75a4ac6fb152d0474d5f1046256804e9b68a1'


def finalized_palette_paths(directory):
    # Pinned E2B decoder: 35 blocks, with KV projections only in the first 15.
    # Names follow Apple's 9db7476 iOS decoder and the reviewed compression recipe.
    modules = ('self_attn.q_proj', 'self_attn.o_proj', 'mlp.gate_proj',
               'mlp.up_proj', 'mlp.down_proj', 'per_layer_input_gate', 'per_layer_projection')
    expected = {f'extend.model.layers.{layer}.{module}.weight.safetensors'
                for layer in range(35) for module in modules}
    expected |= {f'extend.model.layers.{layer}.self_attn.{projection}_proj.weight.safetensors'
                 for layer in range(15) for projection in ('k', 'v')}
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError('Expected a regular finalized palette directory')
    paths = {path.name: path for path in directory.iterdir()}
    if set(paths) != expected:
        raise ValueError('Expected the exact 275 finalized parameters of the pinned E2B recipe '
                         f'(missing {len(expected - paths.keys())}, unexpected {len(paths.keys() - expected)})')
    if any(not path.is_file() or path.is_symlink() or path.stat().st_size == 0
           for path in paths.values()):
        raise ValueError('Expected nonempty regular finalized palette files')
    return [paths[name] for name in sorted(expected)]


def diagnostic_suite(path):
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != CANONICAL_SUITE_SHA256:
        raise ValueError('Diagnostic suite differs from the reviewed canonical prompts and answers')
    return json.loads(data), CANONICAL_SUITE_SHA256


def checkpoint_manifest(directory):
    """Inventory every checkpoint file, except HF's non-inference download cache.

    The expected digest must be captured from a trusted snapshot before running
    candidate inference. Printing an inventory does not authenticate its source.
    """
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError('Expected a regular checkpoint directory')
    files = []
    for path in sorted(directory.rglob('*')):
        relative = path.relative_to(directory)
        if relative.parts[0] == '.cache':
            continue
        if path.is_symlink():
            raise ValueError(f'Checkpoint symlinks are not supported: {relative.as_posix()}')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError(f'Expected a regular checkpoint file: {relative.as_posix()}')
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        files.append({'file': relative.as_posix(), 'bytes': path.stat().st_size, 'sha256': digest})
    names = {row['file'] for row in files}
    required = {'model.safetensors', 'config.json', 'tokenizer.json', 'tokenizer_config.json'}
    if not required <= names:
        raise ValueError('Checkpoint is missing model, config, or tokenizer files')
    manifest = {'schema_version': 1, 'files': files}
    digest = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return manifest, digest
