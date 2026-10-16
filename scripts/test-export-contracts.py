#!/usr/bin/env python3
"""Offline contract regressions; no Torch/Core AI installation or weights needed.

Heavy modules are stubbed only while importing the diagnostic scripts. Tests
exercise their real preflight/provenance functions, without exporting a graph.
"""
from contextlib import contextmanager
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPTS = Path(os.environ.get('ASSIST_SCRIPTS_UNDER_TEST', Path(__file__).resolve().parent))
RESOURCES = Path(__file__).resolve().parents[1] / 'mobile/ios/Assist'
sys.path.insert(0, str(SCRIPTS))
from gemma_contracts import checkpoint_manifest, diagnostic_suite, finalized_palette_paths


def load_script(name):
    spec = importlib.util.spec_from_file_location('test_' + name.replace('-', '_'), SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def probe_stubs():
    exports = {
        'numpy': {}, 'torch': {'nn': SimpleNamespace(Module=object)},
        'coreai.authoring': {'AIModelAsset': object},
        'coreai._compiler.ir': {name: object for name in ('ArrayAttr', 'DenseElementsAttr', 'DenseResourceElementsAttr', 'DictAttr', 'StringAttr')},
        'coreai._compiler._mlir_libs._coreaiIR': {'_bindings': object()},
        'coreai_torch': {name: object for name in ('ExternalizeSpec', 'TorchConverter', 'get_decomp_table')},
        'coreai_torch.composite_ops': {'RMSNormImpl': object},
    }
    modules = {}
    for name, attributes in exports.items():
        module = ModuleType(name)
        module.__dict__.update(attributes)
        modules[name] = module
    return modules


class GemmaContracts(unittest.TestCase):
    def checkpoint(self, directory):
        for name, data in {'model.safetensors': b'synthetic weights', 'config.json': b'{}',
                           'tokenizer.json': b'{}', 'tokenizer_config.json': b'{}',
                           'chat_template.jinja': b'{{ messages }}'}.items():
            (directory / name).write_bytes(data)

    def test_complete_palette_inventory_rejects_partial_empty_and_wrong_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, 'exact 275'):
                finalized_palette_paths(root)
            modules = ('self_attn.q_proj', 'self_attn.o_proj', 'mlp.gate_proj', 'mlp.up_proj',
                       'mlp.down_proj', 'per_layer_input_gate', 'per_layer_projection')
            names = [f'extend.model.layers.{i}.{module}.weight.safetensors'
                     for i in range(35) for module in modules]
            names += [f'extend.model.layers.{i}.self_attn.{p}_proj.weight.safetensors'
                      for i in range(15) for p in ('k', 'v')]
            for name in names:
                (root / name).write_bytes(b'synthetic palette')
            self.assertEqual(len(finalized_palette_paths(root)), 275)
            file = root / names[0]
            file.write_bytes(b'')
            with self.assertRaisesRegex(ValueError, 'nonempty'):
                finalized_palette_paths(root)
            file.write_bytes(b'synthetic palette')
            file.rename(root / 'unexpected.weight.safetensors')
            with self.assertRaisesRegex(ValueError, 'missing 1, unexpected 1'):
                finalized_palette_paths(root)

    def test_export_wrapper_rejects_partial_capture_after_exporter_returns(self):
        wrapper = load_script('export-gemma-with-palettes')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            exporter = root / 'export.py'
            exporter.write_text('# synthetic exporter')
            palettes = root / 'palettes'
            @contextmanager
            def retain(directory):
                directory.mkdir()
                yield
            def run_export(*args, **kwargs):
                (palettes / 'extend.model.layers.0.self_attn.q_proj.weight.safetensors').write_bytes(b'partial')
            with patch.object(wrapper, 'retain_palettes', retain), patch.object(wrapper.runpy, 'run_path', run_export), \
                    patch.object(sys, 'argv', ['wrapper', '--exporter', str(exporter), '--palettes', str(palettes)]):
                with self.assertRaisesRegex(ValueError, 'exact 275'):
                    wrapper.main()

    def test_canonical_suite_accepts_original_and_rejects_edited_expected_answer(self):
        suite = SCRIPTS / 'fixtures/gemma-quality.json'
        self.assertEqual(diagnostic_suite(suite)[0]['case_count'], 8)
        with tempfile.TemporaryDirectory() as temporary:
            modified = Path(temporary) / 'cases.json'
            value = json.loads(suite.read_text())
            value['cases'][0]['expected'] = '1,2,3,4,5'
            modified.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, 'canonical'):
                diagnostic_suite(modified)

    def test_checkpoint_fingerprint_covers_configs_tokenizer_and_chat_template(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.checkpoint(root)
            manifest, digest = checkpoint_manifest(root)
            self.assertEqual(len(manifest['files']), 5)
            for name in ('config.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja'):
                with self.subTest(file=name):
                    path, before = root / name, (root / name).read_bytes()
                    path.write_bytes(before + b'changed')
                    self.assertNotEqual(checkpoint_manifest(root)[1], digest)
                    path.write_bytes(before)
            (root / 'extra_config.json').write_text('{}')
            self.assertNotEqual(checkpoint_manifest(root)[1], digest)

    def test_checkpoint_rejects_symlink_file_and_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.checkpoint(root)
            (root / 'linked.json').symlink_to(root / 'config.json')
            with self.assertRaisesRegex(ValueError, 'symlink'):
                checkpoint_manifest(root)
            (root / 'linked.json').unlink()
            (root / 'linked-directory').symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'symlink'):
                checkpoint_manifest(root)

    def test_print_manifest_works_without_model_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.checkpoint(root)
            result = subprocess.run([sys.executable, str(SCRIPTS / 'check-gemma-quality.py'),
                                     '--checkpoint', str(root), '--print-checkpoint-manifest'],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['checkpoint_manifest_sha256'], checkpoint_manifest(root)[1])

    def test_quality_cli_rejects_modified_tokenizer_before_importing_model(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.checkpoint(root)
            digest = checkpoint_manifest(root)[1]
            (root / 'tokenizer_config.json').write_text('{"chat_template":"tampered"}')
            result = subprocess.run([sys.executable, str(SCRIPTS / 'check-gemma-quality.py'), '--checkpoint', str(root),
                                     '--checkpoint-sha256', hashlib.sha256((root / 'model.safetensors').read_bytes()).hexdigest(),
                                     '--checkpoint-manifest-sha256', digest, '--output', str(root / 'result.json')],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('Complete checkpoint manifest SHA-256 mismatch', result.stderr)
            self.assertFalse((root / 'result.json').exists())

    def test_quality_cli_rejects_edited_expected_answers_before_importing_model(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.checkpoint(root)
            cases = root.parent / (root.name + '-cases.json')
            try:
                suite = json.loads((SCRIPTS / 'fixtures/gemma-quality.json').read_text())
                suite['cases'][0]['expected'] = '1,2,3,4,5'
                cases.write_text(json.dumps(suite))
                result = subprocess.run([sys.executable, str(SCRIPTS / 'check-gemma-quality.py'), '--checkpoint', str(root),
                                         '--checkpoint-sha256', hashlib.sha256((root / 'model.safetensors').read_bytes()).hexdigest(),
                                         '--checkpoint-manifest-sha256', checkpoint_manifest(root)[1],
                                         '--cases', str(cases), '--output', str(root / 'result.json')], capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn('reviewed canonical prompts and answers', result.stderr)
                self.assertFalse((root / 'result.json').exists())
            finally:
                cases.unlink(missing_ok=True)


class ProbeContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with patch.dict(sys.modules, probe_stubs()):
            cls.f16 = load_script('export-rmsnorm-probe')
            cls.f32 = load_script('export-rmsnorm-fp32-probe')

    def provenance(self, variant):
        root = RESOURCES / ('NumericalProbeFP32' if variant == 'f32' else 'NumericalProbe')
        return root, json.loads((root / 'generator-provenance.json').read_text())

    def check_provenance(self, variant, root, value, checks):
        if variant == 'f16':
            self.f16.verify_provenance(value, root, checks)
        else:
            with patch.object(self.f32, 'version', side_effect=value['versions'].__getitem__):
                self.f32.verify_provenance(value, root, RESOURCES / 'NumericalProbe', checks)

    def test_reviewed_legacy_fixture_provenance_and_metadata_remain_verifiable(self):
        for variant in ('f16', 'f32'):
            with self.subTest(variant=variant):
                root, value = self.provenance(variant)
                self.check_provenance(variant, root, value, value['eagerChecks'])

    def test_new_provenance_requires_metadata_hash(self):
        for variant, module in (('f16', self.f16), ('f32', self.f32)):
            with self.subTest(variant=variant):
                root, value = self.provenance(variant)
                value['generatorSHA256'] = self.f16.sha(Path(module.__file__))
                if variant == 'f32':
                    value['originalGeneratorSHA256'] = self.f32.ORIGINAL_GENERATOR_SHA256
                with self.assertRaisesRegex(RuntimeError, 'Missing asset metadata provenance'):
                    self.check_provenance(variant, root, value, value['eagerChecks'])
                value['assetMetadataSHA256'] = self.f16.sha(root / self.f16.ASSET / 'metadata.json')
                self.check_provenance(variant, root, value, value['eagerChecks'])

    def test_recomputed_eager_checks_must_match_recorded_results(self):
        for variant in ('f16', 'f32'):
            with self.subTest(variant=variant):
                root, value = self.provenance(variant)
                checks = copy.deepcopy(value['eagerChecks'])
                checks[0]['maxF16ULP'] += 1
                with self.assertRaisesRegex(RuntimeError, 'Recorded eager checks'):
                    self.check_provenance(variant, root, value, checks)

    def test_fixed_scope_and_status_provenance_cannot_be_changed(self):
        for variant in ('f16', 'f32'):
            root, original = self.provenance(variant)
            fields = ('modelWeightsLoaded', 'runtimeOrSpecializationInvoked', 'nativeCorrectnessVerified',
                      'aneExecutionVerified', 'kind', 'schemaVersion', 'generator')
            fields += ('epsilon', 'rowPatterns', 'scaleStorage') if variant == 'f16' else ('variant', 'fixtureInputsExpectedAndScalesUnchanged')
            for field in fields:
                with self.subTest(variant=variant, field=field):
                    value = copy.deepcopy(original)
                    value[field] = not value[field] if isinstance(value[field], bool) else 'changed'
                    with self.assertRaisesRegex(RuntimeError, 'Fixed generator provenance'):
                        self.check_provenance(variant, root, value, original['eagerChecks'])

    def test_metadata_changes_cannot_hide_in_legacy_compatibility(self):
        for variant in ('f16', 'f32'):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as temporary:
                source, value = self.provenance(variant)
                root = Path(temporary) / 'fixtures'
                shutil.copytree(source, root)
                metadata = root / self.f16.ASSET / 'metadata.json'
                metadata.write_text('{"assetVersion":"2.0","producer":"changed","creationDate":"20261016T000000Z"}')
                with self.assertRaisesRegex(RuntimeError, 'metadata SHA256'):
                    self.check_provenance(variant, root, value, value['eagerChecks'])
                value['assetMetadataSHA256'] = self.f16.sha(metadata)
                with self.assertRaisesRegex(RuntimeError, 'Historical asset metadata'):
                    self.check_provenance(variant, root, value, value['eagerChecks'])

    def test_current_metadata_contract_rejects_wrong_content_even_with_matching_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'metadata.json'
            path.write_text('{"assetVersion":"2.0","producer":"other","creationDate":"20261016T000000Z"}')
            with self.assertRaisesRegex(RuntimeError, 'metadata contract'):
                self.f16.verify_metadata(path, self.f16.sha(path))

    def test_scale_provenance_requires_exact_inventory(self):
        root, value = self.provenance('f16')
        value['scales'].pop()
        with self.assertRaisesRegex(RuntimeError, 'Scale provenance'):
            self.check_provenance('f16', root, value, value['eagerChecks'])

    def test_macos_rss_is_already_bytes_and_linux_is_kibibytes(self):
        with patch.object(self.f16.resource, 'getrusage', return_value=SimpleNamespace(ru_maxrss=4096)):
            with patch.object(self.f16.sys, 'platform', 'darwin'):
                self.assertEqual(self.f16.max_rss_bytes(), 4096)
            with patch.object(self.f16.sys, 'platform', 'linux'):
                self.assertEqual(self.f16.max_rss_bytes(), 4096 * 1024)

    def test_cgroup_v1_and_unavailable_v2_are_optional_unless_required(self):
        with patch.object(self.f16.sys, 'platform', 'linux'):
            for cgroup in ('4:memory:/test\n3:cpu,cpuacct:/test\n', '0::/test\n'):
                def read(path, *args, **kwargs):
                    if str(path) == '/proc/self/cgroup':
                        return cgroup
                    raise FileNotFoundError(str(path))
                with self.subTest(cgroup=cgroup), patch.object(Path, 'read_text', read):
                    self.assertIsNone(self.f16.resource_limits(False))
                    with self.assertRaisesRegex(RuntimeError, 'Required cgroup v2'):
                        self.f16.resource_limits(True)

    def test_fp32_rejects_overlapping_output_before_directory_creation(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            source = parent / 'fixtures'
            source.mkdir()
            (source / 'sentinel').write_bytes(b'immutable')
            link = parent / 'linked-fixtures'
            link.symlink_to(source, target_is_directory=True)
            for output in (source, source / 'nested', parent, link / 'nested'):
                with self.subTest(output=output):
                    before = self.f32.tree_snapshot(source)
                    with self.assertRaisesRegex(RuntimeError, 'must not overlap'):
                        self.f32.export(output, source)
                    self.assertEqual(self.f32.tree_snapshot(source), before)
                    self.assertFalse((source / 'nested').exists())
            self.f32.require_disjoint_resources(parent / 'separate', source)


if __name__ == '__main__':
    unittest.main()
