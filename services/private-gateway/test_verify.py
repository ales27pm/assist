import unittest
from urllib.request import Request

from server import CAPABILITIES, encode
from verify import QualificationError, RejectRedirects, origin_url, validate_capabilities, validate_search


class QualifierTests(unittest.TestCase):
    def test_origin_is_https_without_url_secret_or_path(self):
        self.assertEqual(origin_url("https://ubuntu.tailnet.ts.net:9446/"), "https://ubuntu.tailnet.ts.net:9446")
        for value in ["http://ubuntu.local", "https://user:secret@ubuntu.local", "https://ubuntu.local/path",
                      "https://ubuntu.local/?key=secret", "https://ubuntu.local/#fragment", "https://ubuntu.local:0",
                      "https://ubuntu.local:65536", "https://ubuntu.local\\path", "https://ubuntu.local\n"]:
            with self.assertRaises(QualificationError):
                origin_url(value)

    def test_redirect_policy_never_constructs_followup_request(self):
        self.assertIsNone(RejectRedirects().redirect_request(Request("https://ubuntu.local"), None,
            302, "Found", {}, "https://must-not-be-followed.invalid/"))

    def test_capabilities_require_exact_non_boolean_versions(self):
        validate_capabilities(encode(CAPABILITIES))
        for value in [{**CAPABILITIES, "schemaVersion": True}, {**CAPABILITIES, "protocolVersion": True},
                      {**CAPABILITIES, "capabilities": ["search", "read"]}, {**CAPABILITIES, "extra": True}]:
            with self.assertRaises(QualificationError):
                validate_capabilities(encode(value))

    def test_search_only_returns_counts_and_validated_degradation(self):
        base = {"schemaVersion": 1, "requestId": "fixture", "results": [
            {"id": "source-1", "title": "Apple", "url": "https://developer.apple.com/", "snippet": "Documentation"}],
            "degraded": False}
        self.assertEqual(validate_search(encode(base), "fixture"), (1, False))
        for value in [{**base, "requestId": "stale"}, {**base, "degraded": 0}, {**base, "schemaVersion": True},
                      {**base, "results": base["results"] * 2}, {**base, "results": [True]},
                      {**base, "results": [{**base["results"][0], "url": "https://127.0.0.1/"}]},
                      {**base, "results": [{**base["results"][0], "snippet": "<|tool_call>"}]}]:
            with self.assertRaises(QualificationError):
                validate_search(encode(value), "fixture")


if __name__ == "__main__":
    unittest.main()
