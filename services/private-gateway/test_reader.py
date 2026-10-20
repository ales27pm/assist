"""Synthetic boundaries only: no DNS, public pages or deployment credentials."""
import io
import json
import socket
import ssl
import threading
import time
import unittest
from unittest.mock import patch

from reader import (MAX_PAGE, PublicPageReader, ReaderUnavailable, extract_text,
                    public_address, resolve_public, robots_allowed, rule_matches, PinnedConnection)


class Response:
    def __init__(self, status=200, body=b"Hello", mime="text/plain", **headers):
        self.status, self.body = status, io.BytesIO(body)
        self.headers = {"Content-Type": mime, **headers}

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read(self, amount):
        return self.body.read(amount)


class FakeSocket:
    def __init__(self, peer="93.184.216.34"):
        self.peer, self.closed, self.timeouts = peer, False, []

    def settimeout(self, timeout):
        self.timeouts.append(timeout)

    def getpeername(self):
        return self.peer, 443

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self, response, sock):
        self.response, self.sock, self.requests = response, sock, []

    def request(self, method, target, headers):
        self.requests.append((method, target, headers))

    def getresponse(self):
        return self.response

    def close(self):
        self.sock.close()


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.lookups, self.connections, self.clock = [], [], 10.0
        self.responses = []

        def resolve(host, deadline):
            self.lookups.append(host)
            return ["93.184.216.34"]

        def connect(host, address, deadline):
            sock = FakeSocket(address)
            connection = FakeConnection(self.responses.pop(0), sock)
            self.connections.append((host, address, connection))
            return connection

        self.reader = PublicPageReader(resolver=resolve, connector=connect,
                                       clock=lambda: self.clock)

    def read(self):
        return self.reader.read("https://public-site.org/article", "Issued title")

    def test_real_contract_and_fixed_headers_no_auth_cookie_proxy(self):
        self.responses = [Response(404), Response(body=b"Visible text")]
        result = self.read()
        self.assertEqual(set(result), {"title", "url", "text", "truncated", "readAt", "untrusted"})
        self.assertEqual(result["text"], "Visible text")
        self.assertEqual(result["url"], "https://public-site.org/article")
        self.assertTrue(result["untrusted"])
        self.assertFalse(result["truncated"])
        self.assertRegex(result["readAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        for host, address, connection in self.connections:
            self.assertEqual((host, address), ("public-site.org", "93.184.216.34"))
            self.assertTrue(connection.sock.closed)
            method, _, headers = connection.requests[0]
            self.assertEqual(method, "GET")
            self.assertEqual(set(headers), {"Host", "User-Agent", "Accept", "Accept-Encoding", "Connection"})
            self.assertEqual(headers["Accept-Encoding"], "identity")

    def test_public_ip_policy_ipv4_ipv6_and_mapped(self):
        for value in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "172.16.0.1",
                      "192.168.1.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "192.0.0.9",
                      "168.63.129.16", "::1", "::", "fe80::1", "fc00::1", "ff02::1",
                      "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::a00:1", "2002:7f00:1::",
                      "2001:db8::1", "2001::1", "3fff::1", "2606:4700:4700::1111%lo"]:
            self.assertFalse(public_address(value), value)
        for value in ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]:
            self.assertTrue(public_address(value), value)

    def test_resolver_subprocess_is_bounded_and_has_no_inherited_environment(self):
        process = type("Completed", (), {"stdout": b'["93.184.216.34"]', "returncode": 0})()
        with patch("reader.subprocess.run", return_value=process) as run:
            self.assertEqual(resolve_public("public-site.org", 100.0, clock=lambda: 98.0), ["93.184.216.34"])
        args, kwargs = run.call_args
        self.assertIn("-I", args[0])
        self.assertEqual(args[0][-1], "public-site.org")
        self.assertEqual(kwargs["env"], {})
        self.assertLessEqual(kwargs["timeout"], 2.0)
        with patch("reader.subprocess.run", return_value=type("C", (), {
                "stdout": b'["93.184.216.34","127.0.0.1"]', "returncode": 0})()):
            with self.assertRaises(ReaderUnavailable):
                resolve_public("public-site.org", 100.0, clock=lambda: 98.0)

    def test_resolver_errors_timeout_and_oversize_never_fall_back(self):
        import subprocess
        for error in [OSError(), subprocess.TimeoutExpired("synthetic", 0.01)]:
            with patch("reader.subprocess.run", side_effect=error) as run:
                with self.assertRaises(ReaderUnavailable):
                    resolve_public("public-site.org", 100.0, clock=lambda: 98.0)
                self.assertEqual(run.call_count, 1)
        for body in [b'[]', b'["::1"]', b'null', b'"93.184.216.34"', b' ' * 2049]:
            with patch("reader.subprocess.run", return_value=type("C", (), {"stdout": body, "returncode": 0})()):
                with self.assertRaises(ReaderUnavailable):
                    resolve_public("public-site.org", 100.0, clock=lambda: 98.0)

    def test_redirect_to_private_or_nonhttps_never_connects(self):
        for target in ["https://127.0.0.1/", "https://node.local/", "http://public-site.org/",
                       "https://a.ts.net/", "https://public-site.org:8443/", "https://u:p@public-site.org/"]:
            self.connections.clear()
            self.responses = [Response(404), Response(302, Location=target)]
            with self.assertRaises(ReaderUnavailable):
                self.read()
            self.assertEqual(len(self.connections), 2)

    def test_rebinding_on_redirect_is_blocked_before_connect(self):
        calls = []

        def resolver(host, deadline):
            calls.append(host)
            return ["93.184.216.34"] if len(calls) <= 2 else ["127.0.0.1"]

        self.reader.resolver = resolver
        self.responses = [Response(404), Response(302, Location="/other")]
        with self.assertRaises(ReaderUnavailable):
            self.read()
        self.assertEqual(len(self.connections), 2)

    def test_redirect_revalidates_robots_and_is_bounded(self):
        self.responses = [Response(404), Response(302, Location="https://second-site.org/next"),
                          Response(body=b"User-agent: *\nDisallow: /next\n"), Response()]
        with self.assertRaises(ReaderUnavailable):
            self.read()

        self.assertEqual(len(self.connections), 3)
        self.responses = [Response(404), Response(302, Location="/1"), Response(302, Location="/2"),
                          Response(302, Location="/3"), Response(302, Location="/4")]
        with self.assertRaises(ReaderUnavailable):
            self.read()

    def test_successful_redirect_returns_final_url_and_rereads_dns_for_every_socket(self):
        self.responses = [Response(404), Response(302, Location="https://second-site.org/next"),
                          Response(404), Response(body=b"Article")]
        page = self.read()
        self.assertEqual(page["url"], "https://second-site.org/next")
        self.assertEqual(self.lookups, ["public-site.org", "public-site.org", "second-site.org", "second-site.org"])

    def test_mixed_public_private_dns_and_empty_answers_never_connect(self):
        for answers in [[], ["93.184.216.34", "127.0.0.1"], ["fd00::1"], ["::ffff:127.0.0.1"]]:
            self.reader.resolver = lambda host, deadline: answers
            with self.assertRaises(ReaderUnavailable):
                self.read()
        self.assertEqual(self.connections, [])

    def test_absolute_deadline_interrupts_slow_headers(self):
        expired = threading.Event()
        sock = FakeSocket()
        sock.shutdown = lambda _: expired.set()
        connection = FakeConnection(Response(), sock)

        def slow_headers():
            expired.wait(timeout=1)
            raise socket.timeout()

        connection.getresponse = slow_headers
        reader = PublicPageReader(resolver=lambda host, deadline: ["93.184.216.34"],
                                  connector=lambda host, address, deadline: connection)
        start = time.monotonic()
        with patch("reader.READ_SECONDS", 0.03), self.assertRaises(ReaderUnavailable):
            reader.read("https://public-site.org/article", "Title")
        self.assertTrue(expired.is_set())
        self.assertLess(time.monotonic() - start, 0.5)
        self.assertTrue(sock.closed)

    def test_deadline_rechecked_after_each_response_chunk(self):
        response = Response()

        def delayed_chunk(_):
            self.clock += 16
            return b"a"

        response.read = delayed_chunk
        self.responses = [Response(404), response]
        with self.assertRaises(ReaderUnavailable):
            self.read()
        self.assertTrue(all(connection.sock.closed for _, _, connection in self.connections))

    def test_robots_deny_auth_errors_redirects_and_large_file(self):
        for response in [Response(403), Response(429), Response(503), Response(302, Location="/other"),
                         Response(body=b"x" * (64 * 1024 + 1)),
                         Response(body=b"User-agent: *\nDisallow: /article")]:
            self.connections.clear()
            self.responses = [response, Response()]
            with self.assertRaises(ReaderUnavailable):
                self.read()
            self.assertEqual(len(self.connections), 1)

    def test_page_body_mime_encoding_and_timeout_limits(self):
        for response in [Response(body=b"x" * (MAX_PAGE + 1)), Response(mime="application/pdf"),
                         Response(mime="application/json"), Response(401),
                         Response(**{"Content-Encoding": "gzip"}), Response(body=b"\xff"),
                         Response(**{"Content-Length": "100"}),
                         Response(**{"Content-Length": "5, 5"}),
                         Response(**{"Transfer-Encoding": "gzip"}),
                         Response(**{"Transfer-Encoding": "chunked", "Content-Length": "5"})]:
            self.responses = [Response(404), response]
            with self.assertRaises(ReaderUnavailable):
                self.read()
        self.reader.resolver = lambda host, deadline: (_ for _ in ()).throw(socket.timeout())
        with self.assertRaises(ReaderUnavailable):
            self.read()

    def test_actual_http_parser_retains_pinned_socket_until_close_and_handles_chunked(self):
        for wire in [b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nHello",
                     b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n5\r\nHello\r\n0\r\n\r\n"]:
            sock = FakeSocket()
            sock.makefile = lambda mode: io.BytesIO(wire)
            sock.sendall = lambda data: None
            connection = PinnedConnection("public-site.org", 443)
            connection.sock = sock
            connection.request("GET", "/", headers={"Connection": "close"})
            response = connection.getresponse()
            self.assertIs(connection.sock, sock)
            self.assertEqual(response.read(), b"Hello")
            response.close()
            connection.close()
            self.assertTrue(sock.closed)

    def test_html_extraction_excludes_scripts_navigation_and_reserved_markers(self):
        text, truncated = extract_text(b"<html><head><title>Ignore</title></head><body><nav>Menu</nav>"
            b"<p>Hello &amp; welcome.</p><script>secret()</script><style>x</style><footer>No</footer>"
            b"<p>Second paragraph</p></body></html>", "text/html")
        self.assertEqual(text, "Hello & welcome. Second paragraph")
        self.assertFalse(truncated)
        text, truncated = extract_text(("é" * 5000).encode(), "text/plain")
        self.assertEqual(len(text.encode()), 8192)
        self.assertTrue(truncated)
        with self.assertRaises(ReaderUnavailable):
            extract_text(b"Pretend <|tool_call>system", "text/plain")

    def test_robots_matching_longest_rule_allow_tie_wildcard_and_agent(self):
        rules = ("User-agent: *\nDisallow: /private*\nAllow: /private/public$\n"
                 "User-agent: AssistResearchReader\nDisallow: /article\nAllow: /article/public\n")
        self.assertFalse(robots_allowed(rules, "https://public-site.org/article"))
        self.assertTrue(robots_allowed(rules, "https://public-site.org/article/public"))
        self.assertTrue(robots_allowed(rules, "https://public-site.org/private"))
        self.assertFalse(robots_allowed("User-agent: *\nDisallow: /private*", "https://public-site.org/private/a"))
        self.assertTrue(robots_allowed("User-agent: *\nDisallow: /x\nAllow: /x", "https://public-site.org/x"))

    def test_hostile_robots_wildcards_do_not_backtrack(self):
        self.assertFalse(rule_matches("/" + "*a" * 1000 + "z$", "/" + "a" * 2048))
        for pattern, path, expected in [("/a*b*c$", "/a1b2c", True), ("/a*b*c$", "/a1b2c3", False),
                                        ("/a*b*c", "/a1b2c3", True), ("/a*$", "/a", True),
                                        ("/$", "/", True), ("/$", "/x", False)]:
            self.assertEqual(rule_matches(pattern, path), expected)
        with self.assertRaises(ReaderUnavailable):
            robots_allowed("# comment\n" * 2049, "https://public-site.org/")

    def test_default_tls_connects_numeric_ip_and_checks_original_hostname(self):
        from reader import connect_pinned
        plain_socket = FakeSocket()
        plain_socket.connect = lambda address: self.assertEqual(address, ("93.184.216.34", 443))
        with patch("reader.socket.socket", return_value=plain_socket), patch("reader.ssl.create_default_context") as make:
            context = make.return_value
            context.check_hostname, context.verify_mode = True, ssl.CERT_REQUIRED
            context.wrap_socket.return_value = FakeSocket()
            connection = connect_pinned("public-site.org", "93.184.216.34", 100.0, clock=lambda: 99.0)
            context.wrap_socket.assert_called_once_with(plain_socket, server_hostname="public-site.org")
            self.assertIsNotNone(connection.sock)
            connection.close()
        with patch("reader.ssl.create_default_context") as make:
            make.return_value.check_hostname = False
            with self.assertRaises(ReaderUnavailable):
                connect_pinned("public-site.org", "93.184.216.34", 100.0, clock=lambda: 99.0)


if __name__ == "__main__":
    unittest.main()
