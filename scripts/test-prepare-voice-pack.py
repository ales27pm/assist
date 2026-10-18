#!/usr/bin/env python3
"""Provisioning integrity/transaction tests; small local fixtures, no weights."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("prepare_voice_pack", Path(__file__).with_name("prepare-voice-pack.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name) / "pack"
        self.body = b"a tiny fixture, never a model"
        self.manifest = {"schemaVersion": 1, "groups": {}}
        for name, repo in {"pocket": "pocket-tts-coreml", "redux": "parakeet-redux-coreml", "ultra": "parakeet-ultra-coreml", "silero": "silero-vad-coreml"}.items():
            self.manifest["groups"][name] = {"repository": "FluidInference/" + repo, "revision": "a" * 40,
                "files": [{"path": "Model.mlmodelc/weights/weight.bin", "size": len(self.body), "sha256": hashlib.sha256(self.body).hexdigest()}]}
        self.hash = hashlib.sha256(json.dumps(self.manifest, sort_keys=True).encode()).hexdigest()

    def prepare(self, download=True):
        with contextlib.redirect_stdout(io.StringIO()):
            return MODULE.prepare(self.manifest, self.hash, self.output, ["redux"], download)

    def test_shipped_manifest_is_complete_pinned_and_has_known_sizes(self):
        manifest = json.loads(MODULE.MANIFEST.read_bytes())
        MODULE.validate_manifest(manifest)
        self.assertEqual(sum(v["size"] for name in ("pocket", "silero", "redux") for v in manifest["groups"][name]["files"]), 1_252_281_265)
        self.assertTrue(any(v["path"].startswith("mimi_encoderv3.mlmodelc/") for v in manifest["groups"]["pocket"]["files"]))

    def test_verified_pack_resumes_and_verifies_without_network(self):
        with patch.object(MODULE.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: io.BytesIO(self.body)) as download:
            self.assertEqual(self.prepare(), 3 * len(self.body))
            self.assertEqual(download.call_count, 3)
            self.prepare()
            self.assertEqual(download.call_count, 3)
        with patch.object(MODULE.urllib.request, "urlopen", side_effect=AssertionError("No network during verify")):
            self.prepare(download=False)

    def test_corrupt_download_never_replaces_existing_asset(self):
        with patch.object(MODULE.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: io.BytesIO(self.body)):
            self.prepare()
        target = self.output / "pocket/Model.mlmodelc/weights/weight.bin"
        target.write_bytes(b"previous local file")
        with patch.object(MODULE.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: io.BytesIO(b"wrong")):
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                self.prepare()
        self.assertEqual(target.read_bytes(), b"previous local file")
        self.assertEqual(list(self.output.rglob("*.assist-download")), [])

    def test_oversize_download_is_bounded(self):
        with patch.object(MODULE.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: io.BytesIO(self.body * 2)):
            with self.assertRaisesRegex(ValueError, "exceeded"):
                self.prepare()
        self.assertFalse((self.output / "pocket/Model.mlmodelc/weights/weight.bin").exists())

    def test_partial_extra_variant_cannot_be_reported_as_a_valid_pack(self):
        with patch.object(MODULE.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: io.BytesIO(self.body)):
            self.prepare()
        extra = self.output / "ultra"
        extra.mkdir()
        (extra / "incomplete").write_bytes(b"keep for resume")
        with self.assertRaisesRegex(ValueError, "another Parakeet variant"):
            self.prepare(download=False)
        self.assertEqual((extra / "incomplete").read_bytes(), b"keep for resume")

    def test_unsafe_paths_mutable_revisions_and_repos_are_rejected(self):
        for path in ("../secret", "/absolute", "foo//bar", "foo\\bar", "foo/./bar", ""):
            with self.subTest(path=path):
                self.manifest["groups"]["pocket"]["files"][0]["path"] = path
                with self.assertRaises(ValueError):
                    MODULE.validate_manifest(self.manifest)
        self.manifest["groups"]["pocket"]["files"][0]["path"] = "safe"
        self.manifest["groups"]["pocket"]["revision"] = "main"
        with self.assertRaises(ValueError): MODULE.validate_manifest(self.manifest)
        self.manifest["groups"]["pocket"]["revision"] = "a" * 40
        self.manifest["groups"]["pocket"]["repository"] = "someone/another-model"
        with self.assertRaises(ValueError): MODULE.validate_manifest(self.manifest)

    def test_unknown_directory_and_symlinks_do_not_get_written(self):
        self.output.mkdir()
        unrelated = self.output / "user.txt"
        unrelated.write_text("preserve")
        with self.assertRaisesRegex(ValueError, "no Assist pack marker"):
            self.prepare()
        self.assertEqual(unrelated.read_text(), "preserve")
        (self.output / MODULE.MARKER).write_text(json.dumps({"manifestSHA256": self.hash}))
        external = self.output.parent / "external"
        external.mkdir()
        (self.output / "pocket").symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.prepare()
        self.assertEqual(list(external.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
