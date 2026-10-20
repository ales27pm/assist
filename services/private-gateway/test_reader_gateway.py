"""Real disposable loopback HTTP contract; synthetic reader and tokens only."""
import http.client
import json
import threading
import unittest

from server import CAPABILITIES, CAPABILITIES_V2, MAX_CACHED_REQUESTS, PrivateGateway, read_request, search_result

TOKEN = "synthetic_device_one_" + "x" * 32
OTHER_TOKEN = "synthetic_device_two_" + "y" * 32


class FakeReader:
    def __init__(self):
        self.calls = []
        self.fail = False

    def read(self, url, title):
        self.calls.append((url, title))
        if self.fail:
            raise ValueError("Do not leak private token, URL, or page contents")
        return {"title": title, "url": url, "text": "Public page text", "truncated": False,
                "readAt": "2026-10-19T12:00:00Z", "untrusted": True}


class ReaderGatewayTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.reader = FakeReader()
        self.upstream = {"results": [{"title": "Title " + str(i), "url": "https://public-site.org/" + str(i)}
                                     for i in range(10)]}
        self.gateway = PrivateGateway(("127.0.0.1", 0), [TOKEN, OTHER_TOKEN], lambda _: self.upstream,
                                      reader=self.reader, clock=lambda: self.now)
        self.thread = threading.Thread(target=self.gateway.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.gateway.shutdown()
        self.gateway.server_close()
        self.thread.join(timeout=2)

    def request(self, path, value=None, *, token=TOKEN, method="POST"):
        connection = http.client.HTTPConnection(*self.gateway.server_address, timeout=2)
        headers = {"Content-Type": "application/json", "Authorization": "Bearer " + token}
        connection.request(method, path, json.dumps(value) if value is not None else None, headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def search(self, request_id="req"):
        status, result = self.request("/v1/search", {"schemaVersion": 1, "requestId": request_id, "query": "Public docs"})
        self.assertEqual(status, 200)
        return result

    def read(self, result_id, request_id="req", **kwargs):
        return self.request("/v2/read", {"schemaVersion": 1, "requestId": request_id, "resultId": result_id}, **kwargs)

    def test_v1_exact_compatibility_v2_discovery_and_read(self):
        self.assertEqual(self.request("/v1/capabilities", method="GET"), (200, CAPABILITIES))
        self.assertEqual(self.request("/v2/capabilities", method="GET"), (200, {
            "schemaVersion": 1, "service": "assist-private-gateway", "protocolVersion": 2,
            "capabilities": ["search", "read"]}))
        self.assertEqual(CAPABILITIES_V2["protocolVersion"], 2)
        hit = self.search()["results"][0]
        status, page = self.read(hit["id"])
        self.assertEqual(status, 200)
        self.assertEqual(set(page), {"schemaVersion", "requestId", "resultId", "title", "url", "text", "truncated", "readAt", "untrusted"})
        self.assertEqual((page["requestId"], page["resultId"], page["title"], page["url"]),
                         ("req", hit["id"], hit["title"], hit["url"]))
        self.assertEqual(self.reader.calls, [(hit["url"], hit["title"])])

    def test_unknown_expired_request_and_other_device_never_read(self):
        hit = self.search()["results"][0]
        self.assertEqual(self.read(hit["id"], token="wrong")[0], 401)
        self.assertEqual(self.read(hit["id"], token=OTHER_TOKEN)[0], 404)
        self.assertEqual(self.read(hit["id"], request_id="other")[0], 404)
        self.assertEqual(self.read("0" * 32)[0], 404)
        self.now += 600
        self.assertEqual(self.read(hit["id"])[0], 404)
        self.assertEqual(self.reader.calls, [])

    def test_exact_read_request_cannot_carry_url_headers_or_extra_fields(self):
        base = {"schemaVersion": 1, "requestId": "req", "resultId": "0" * 32}
        for value in [{**base, "url": "https://public-site.org/"}, {**base, "headers": {}},
                      {**base, "schemaVersion": True}, {**base, "requestId": "bad id"},
                      {**base, "resultId": "https://public-site.org/"}, {**base, "resultId": "0" * 33}]:
            self.assertEqual(self.request("/v2/read", value)[0], 400)
        for value in [b'{"schemaVersion":1,"schemaVersion":1}', b'null', b'[]', b'{"requestId":NaN}']:
            with self.assertRaises(ValueError):
                read_request(value)
        self.assertEqual(self.reader.calls, [])

    def test_consumed_handle_cannot_automatically_retry_even_after_failure(self):
        hits = self.search()["results"]
        self.assertEqual(self.read(hits[0]["id"])[0], 200)
        self.assertEqual(self.read(hits[0]["id"])[0], 404)
        self.reader.fail = True
        self.assertEqual(self.read(hits[1]["id"]), (502, {"error": "read_unavailable"}))
        self.assertEqual(self.read(hits[1]["id"])[0], 404)
        self.assertEqual(len(self.reader.calls), 2)

    def test_per_request_and_global_read_rate_bounded(self):
        hits = self.search()["results"]
        for hit in hits[:4]:
            self.assertEqual(self.read(hit["id"])[0], 200)
        self.assertEqual(self.read(hits[4]["id"])[0], 429)
        for request_id in ("second", "third"):
            for hit in self.search(request_id)["results"][:4]:
                self.assertEqual(self.read(hit["id"], request_id)[0], 200)
        hit = self.search("fourth")["results"][0]
        self.assertEqual(self.read(hit["id"], "fourth")[0], 429)
        self.now += 60
        self.assertEqual(self.read(hit["id"], "fourth")[0], 200)

    def test_handle_cache_bounded_per_device_global_and_ttl(self):
        result = search_result("req", self.upstream)
        for client in range(16):
            for request in range(8):
                result["requestId"] = "req-" + str(request)
                self.gateway.remember_hits(str(client), result)
                self.assertLessEqual(len(self.gateway._handles), MAX_CACHED_REQUESTS)
        self.assertEqual(len(self.gateway._handles), MAX_CACHED_REQUESTS)
        self.assertTrue(all(sum(key[0] == client for key in self.gateway._handles) <= 4
                            for client, _ in self.gateway._handles))
        self.assertIsNone(self.gateway.take_hit("15", "req-0", result["results"][0]["id"]))
        self.now += 600
        self.gateway.remember_hits("new", result)
        self.assertEqual(len(self.gateway._handles), 1)

    def test_two_concurrent_reads_of_same_handle_submit_once(self):
        entered, release = threading.Event(), threading.Event()
        original = self.reader.read

        def blocked(url, title):
            entered.set()
            release.wait(timeout=2)
            return original(url, title)

        self.reader.read = blocked
        hit = self.search()["results"][0]
        outcomes = []
        worker = threading.Thread(target=lambda: outcomes.append(self.read(hit["id"])[0]), daemon=True)
        try:
            worker.start()
            self.assertTrue(entered.wait(timeout=2))
            self.assertEqual(self.read(hit["id"])[0], 404)
        finally:
            release.set()
            worker.join(timeout=2)
        self.assertEqual(outcomes, [200])
        self.assertEqual(len(self.reader.calls), 1)


if __name__ == "__main__":
    unittest.main()
