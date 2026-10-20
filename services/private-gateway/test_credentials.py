import contextlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from provision import provision_file
from server import load_configured_tokens, load_tokens_file


class CredentialFileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="assist-token-test-")
        self.root = Path(self.directory.name)
        self.path = self.root / "tokens.json"

    def tearDown(self):
        self.directory.cleanup()

    def test_exclusive_private_provisioning_never_prints_the_token(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            actual = provision_file(str(self.path))
        self.assertEqual(actual, self.path)
        self.assertEqual(output.getvalue(), "")
        data = json.loads(self.path.read_text())
        self.assertEqual(len(data), 1)
        self.assertRegex(data[0], r"^[A-Za-z0-9_-]{43}$")
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(load_tokens_file(str(self.path)), data)
        self.assertEqual(load_configured_tokens({"ASSIST_GATEWAY_TOKENS_FILE": str(self.path)}), data)
        old = self.path.read_bytes()
        with self.assertRaises((ValueError, OSError)):
            provision_file(str(self.path))
        self.assertEqual(self.path.read_bytes(), old)

    def test_private_new_parent_is_created_without_changing_existing_directories(self):
        path = self.root / "new-private-directory" / "tokens.json"
        provision_file(str(path))
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        public_parent = self.root / "not-private"
        public_parent.mkdir(mode=0o755)
        public_parent.chmod(0o755)
        with self.assertRaises((ValueError, OSError)):
            provision_file(str(public_parent / "tokens.json"))
        self.assertEqual(stat.S_IMODE(public_parent.stat().st_mode), 0o755)
        self.assertFalse((public_parent / "tokens.json").exists())

    def test_symlinks_modes_relative_paths_and_non_regular_files_are_rejected(self):
        provision_file(str(self.path))
        link = self.root / "linked.json"
        link.symlink_to(self.path)
        for path in [str(link), "relative.json", str(self.root), str(self.root / ".." / "escape.json")]:
            with self.assertRaises((ValueError, OSError)):
                load_tokens_file(path)
        for mode in [0o644, 0o640, 0o400, 0o660]:
            self.path.chmod(mode)
            with self.assertRaises((ValueError, OSError)):
                load_tokens_file(str(self.path))
        self.path.chmod(0o600)
        linked_parent = self.root / "linked-parent"
        linked_parent.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises((ValueError, OSError)):
            provision_file(str(linked_parent / "new.json"))
        fifo = self.root / "fifo.json"
        os.mkfifo(fifo, 0o600)
        with self.assertRaises((ValueError, OSError)):
            load_tokens_file(str(fifo))

    def test_descriptor_owner_is_verified(self):
        provision_file(str(self.path))
        metadata = self.path.stat()
        wrong = SimpleNamespace(st_mode=metadata.st_mode, st_size=metadata.st_size, st_uid=os.getuid() + 1)
        with patch("server.os.fstat", return_value=wrong):
            with self.assertRaises((ValueError, OSError)):
                load_tokens_file(str(self.path))

    def test_bad_file_fails_closed_without_falling_back_to_legacy_environment(self):
        provision_file(str(self.path))
        legacy = json.dumps(["synthetic_legacy_" + "x" * 32])
        self.assertEqual(load_configured_tokens({"ASSIST_GATEWAY_TOKENS_JSON": legacy}), json.loads(legacy))
        environment = {"ASSIST_GATEWAY_TOKENS_FILE": str(self.path), "ASSIST_GATEWAY_TOKENS_JSON": legacy}
        for content in ["[]", "null", '["short"]', '[{"token":"no"}]', '["é"]',
                        '["' + "x" * 32 + '","' + "x" * 32 + '"]', " " * 8193]:
            self.path.write_text(content)
            with self.assertRaises((ValueError, OSError)):
                load_configured_tokens(environment)

    def test_cli_reports_only_path_and_refuses_reuse(self):
        command = [sys.executable, str(Path(__file__).with_name("provision.py")), "--file", str(self.path)]
        result = subprocess.run(command, text=True, capture_output=True, check=True)
        self.assertEqual(result.stdout, str(self.path) + "\n")
        self.assertEqual(result.stderr, "")
        token = json.loads(self.path.read_text())[0]
        self.assertNotIn(token, result.stdout + result.stderr)
        old = self.path.read_bytes()
        repeat = subprocess.run(command, text=True, capture_output=True, check=False)
        self.assertNotEqual(repeat.returncode, 0)
        self.assertNotIn(token, repeat.stdout + repeat.stderr)
        self.assertEqual(self.path.read_bytes(), old)


if __name__ == "__main__":
    unittest.main()
