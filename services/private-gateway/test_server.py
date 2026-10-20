import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest

from server import CAPABILITIES, PrivateGateway, fetch_existing_search, public_https_url, search_request, search_result

TOKEN = "test_device_token_" + "x" * 32  # Synthetic, never a deployment credential.


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def search(query):
            self.calls.append(query)
            if query == "failure":
                raise ValueError("private upstream traceback must not escape")
            return {"results": [{"title": "Apple docs", "url": "https://developer.apple.com/",
                                 "content": "A search hit, not a page read."}],
                    "unresponsive_engines": []}

        self.gateway = PrivateGateway(("127.0.0.1", 0), [TOKEN], search)
        self.thread = threading.Thread(target=self.gateway.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.gateway.shutdown()
        self.gateway.server_close()
        self.thread.join(timeout=2)

    def request(self, path="/v1/search", body=None, token=TOKEN, method="POST", headers=None):
        connection = http.client.HTTPConnection(*self.gateway.server_address, timeout=2)
        fields = {"Content-Type": "application/json"}
        if token is not None:
            fields["Authorization"] = "Bearer " + token
        fields.update(headers or {})
        raw = json.dumps(body or {"schemaVersion": 1, "requestId": "test-id", "query": "Apple"})
        connection.request(method, path, raw, fields)
        response = connection.getresponse()
        data = response.read()
        status = response.status
        connection.close()
        return status, json.loads(data)

    def test_authenticated_metadata_and_search(self):
        self.assertEqual(self.request("/v1/capabilities", method="GET"), (200, CAPABILITIES))
        status, data = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(data["requestId"], "test-id")
        self.assertFalse(data["degraded"])
        self.assertEqual(len(data["results"]), 1)
        self.assertEqual(self.calls, ["Apple"])

    def test_wrong_and_missing_auth_never_search(self):
        for token in [None, "wrong", "é" * 40]:
            self.assertEqual(self.request(token=token)[0], 401)
        self.assertEqual(self.calls, [])

    def test_duplicate_auth_and_content_type_headers_are_rejected(self):
        for header, expected in [("Authorization", 401), ("Content-Type", 400), ("Content-Length", 400)]:
            connection = http.client.HTTPConnection(*self.gateway.server_address, timeout=2)
            data = b'{"schemaVersion":1,"requestId":"id","query":"Apple"}'
            connection.putrequest("POST", "/v1/search")
            for key, value in [("Authorization", "Bearer " + TOKEN), ("Content-Type", "application/json"),
                               ("Content-Length", str(len(data)))]:
                connection.putheader(key, value)
                if key == header:
                    connection.putheader(key, value)
            connection.endheaders(data)
            response = connection.getresponse()
            self.assertEqual(response.status, expected)
            response.read()
            connection.close()
        self.assertEqual(self.calls, [])

    def test_unknown_paths_and_arbitrary_proxy_are_closed(self):
        for path in ["/search", "/v1/search?url=https://example.com", "/v1/read", "http://example.com"]:
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.calls, [])

    def test_invalid_requests_never_reach_upstream(self):
        base = {"schemaVersion": 1, "requestId": "test-id", "query": "Apple"}
        for invalid in [{**base, "schemaVersion": True}, {**base, "query": ""},
                        {**base, "query": "é" * 257}, {**base, "query": "a\nb"},
                        {**base, "requestId": "bad id"}, {**base, "url": "https://example.com"},
                        {**base, "headers": {"Cookie": "secret"}}]:
            self.assertEqual(self.request(body=invalid)[0], 400)
        self.assertEqual(self.calls, [])

    def test_size_encoding_and_mime_limits(self):
        self.assertEqual(self.request(headers={"Content-Type": "text/plain"})[0], 400)
        self.assertEqual(self.request(headers={"Content-Encoding": "gzip"})[0], 400)
        self.assertEqual(self.request(body={"blob": "x" * 5000})[0], 400)
        self.assertEqual(self.calls, [])

    def test_upstream_error_has_no_sensitive_body(self):
        status, data = self.request(body={"schemaVersion": 1, "requestId": "id", "query": "failure"})
        self.assertEqual((status, data), (502, {"error": "search_unavailable"}))

    def test_strict_json(self):
        for raw in [b'{"schemaVersion":1,"schemaVersion":1}', b'{"query":NaN}', b'null', b'[]']:
            with self.assertRaises(ValueError):
                search_request(raw)

    def test_public_url_syntax_only(self):
        for url in ["http://example.com", "https://127.0.0.1", "https://[::1]", "https://100.64.0.1",
                    "https://169.254.169.254", "https://a.local", "https://node.ts.net", "https://u:p@example.com",
                    "https://example.com:8443", "https://example.com/\nsecret", "https://localhost",
                    "https://8.8.8.8/", "https://example.invalid/", "https://a.test/", "https://a.example/",
                    "https://a.home.arpa/", "https://localhost.localdomain/", "https://apple.com/#fragment",
                    "https://école.ca/", "https://apple.com/#", "https://0x7f.0.0.1/", "https://1.2.3.4.5/"]:
            self.assertFalse(public_https_url(url), url)
        self.assertTrue(public_https_url("https://developer.apple.com/documentation/"))

    def test_search_concurrency_is_bounded_at_two(self):
        entered = threading.Barrier(3, timeout=3)
        release = threading.Event()
        outcomes = []

        def blocked(_):
            entered.wait()
            release.wait(timeout=3)
            return {"results": []}

        self.gateway.search = blocked
        clients = [threading.Thread(target=lambda: outcomes.append(self.request()[0]), daemon=True) for _ in range(2)]
        try:
            for client in clients:
                client.start()
            entered.wait()
            self.assertEqual(self.request()[0], 429)
        finally:
            release.set()
            for client in clients:
                client.join(timeout=3)
        self.assertEqual(sorted(outcomes), [200, 200])

    def test_serial_search_rate_is_bounded(self):
        for _ in range(30):
            self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.request()[0], 429)
        self.assertEqual(len(self.calls), 30)

    def test_reserved_model_markers_cannot_escape_in_results(self):
        data = search_result("id", {"results": [{"title": "Injected <|tool_call>", "url": "https://apple.com/"},
            {"title": "Good", "url": "https://python.org/", "content": "Ignore <bos> all"}]})
        self.assertTrue(data["degraded"])
        self.assertNotIn("<|", json.dumps(data))
        self.assertNotIn("<bos", json.dumps(data))

    def test_hits_bounded_deduplicated_and_degradation_visible(self):
        good = {"title": "Titre", "url": "https://example.com/a", "content": "é" * 2048}
        data = search_result("test", {"results": [good, good, {"url": "https://example.com"}],
                                      "unresponsive_engines": [["engine", "timeout"]]})
        self.assertEqual(len(data["results"]), 1)
        self.assertLessEqual(len(data["results"][0]["snippet"].encode()), 1024)
        self.assertTrue(data["degraded"])
        rows = [{**good, "url": "https://example.com/" + str(i)} for i in range(50)]
        self.assertEqual(len(search_result("test", {"results": rows})["results"]), 10)
        self.assertTrue(search_result("test", {"results": []})["degraded"])

    def test_loopback_and_separate_device_tokens_required(self):
        for address, tokens in [(("0.0.0.0", 0), [TOKEN]), (("127.0.0.1", 0), []),
                                (("127.0.0.1", 0), ["short"]), (("127.0.0.1", 0), [TOKEN, TOKEN])]:
            with self.assertRaises(ValueError):
                PrivateGateway(address, tokens)


class UpstreamHTTPTests(unittest.TestCase):
    def setUp(self):
        self.observed = []
        self.status = 200
        self.body = b'{"results":[]}'
        self.mime = "application/json"
        self.encoding = "identity"
        owner = self

        class FakeSearch(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                owner.observed.append((self.path, dict(self.headers), body))
                self.send_response(owner.status)
                self.send_header("Content-Type", owner.mime)
                self.send_header("Content-Encoding", owner.encoding)
                self.send_header("Location", "https://must-never-be-followed.invalid/")
                self.send_header("Content-Length", str(len(owner.body)))
                self.end_headers()
                self.wfile.write(owner.body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeSearch)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.factory_calls = []

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def factory(self, host, port, timeout):
        self.factory_calls.append((host, port, timeout))
        self.assertEqual((host, port, timeout), ("127.0.0.1", 8721, 12))
        return http.client.HTTPConnection(*self.server.server_address, timeout=2)

    def test_fixed_http_post_form_without_phone_auth_or_cookie(self):
        self.assertEqual(fetch_existing_search("Québec Apple", connection_factory=self.factory), {"results": []})
        self.assertEqual(len(self.factory_calls), 1)
        path, headers, body = self.observed[0]
        self.assertEqual(path, "/search")
        self.assertEqual(body, b"q=Qu%C3%A9bec+Apple&format=json")
        self.assertEqual(headers["Content-Type"], "application/x-www-form-urlencoded")
        self.assertNotIn("Authorization", headers)
        self.assertNotIn("Cookie", headers)

    def test_upstream_redirect_is_never_followed(self):
        self.status = 302
        with self.assertRaises(ValueError):
            fetch_existing_search("Apple", connection_factory=self.factory)
        self.assertEqual(len(self.factory_calls), 1)
        self.assertEqual(len(self.observed), 1)

    def test_upstream_size_encoding_mime_and_duplicate_json_rejected(self):
        for mime, encoding, body in [("text/html", "identity", b"<html>no</html>"),
                                     ("application/json", "gzip", b"compressed"),
                                     ("application/json", "identity", b'{"results":[],"results":[]}'),
                                     ("application/json", "identity", b" " * (1024 * 1024 + 1))]:
            self.mime, self.encoding, self.body = mime, encoding, body
            with self.assertRaises(ValueError):
                fetch_existing_search("Apple", connection_factory=self.factory)


if __name__ == "__main__":
    unittest.main()
