"""Authenticated, loopback-only search facade and request-bound public reader.

Place a private HTTPS reverse proxy in front of this listener. This module
does not configure Tailscale, certificates, firewall rules, or live services.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from collections import OrderedDict, deque
import json
import os
import re
import socket
import threading
import time
from typing import Callable
from urllib.parse import urlencode, urlsplit

from credentials import load_configured_tokens, load_tokens_file as load_tokens_file, validated_tokens
from reader import PublicPageReader

CAPABILITIES = {
    "schemaVersion": 1,
    "service": "assist-private-gateway",
    "protocolVersion": 1,
    "capabilities": ["search"],
}
CAPABILITIES_V2 = {**CAPABILITIES, "protocolVersion": 2, "capabilities": ["search", "read"]}
MAX_REQUEST = 4096
MAX_RESPONSE = 24 * 1024
MAX_UPSTREAM = 1024 * 1024
MAX_CONNECTIONS = 2
MAX_SEARCHES_PER_MINUTE = 30
MAX_READS_PER_MINUTE = 12
MAX_CACHED_REQUESTS = 32
MAX_REQUESTS_PER_CLIENT = 4
MAX_READS_PER_REQUEST = 4
HANDLE_TTL = 600
RESERVED_MARKERS = ("<|", "|>", "<turn", "<channel", "<tool", "</tool", "<bos", "<eos", "<pad", "<unk",
                    "<function", "</function", "<atem:", "</atem:", "[TOOL_CALLS]")


def strict_json(raw: bytes):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError("non-finite number")

    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                      parse_constant=invalid_constant)


def encode(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      separators=(",", ":")).encode("utf-8")


def plain(value, maximum: int) -> str:
    if not isinstance(value, str):
        return ""
    text = " ".join(value.split())
    if any(ord(character) < 32 or ord(character) == 127 for character in text):
        return ""
    if any(marker in text for marker in RESERVED_MARKERS):
        return ""
    return text.encode("utf-8")[:maximum].decode("utf-8", errors="ignore")


def public_https_url(value) -> bool:
    # Search-hit syntax policy only. No URL is fetched here; this is NOT a
    # DNS/rebinding defense or proof that a page has been read.
    if (not isinstance(value, str) or not value or len(value.encode("utf-8")) > 2048
            or any(ord(c) <= 32 or ord(c) == 127 for c in value)
            or "\\" in value):
        return False
    try:
        url = urlsplit(value)
        host = url.hostname
        if (not value.startswith("https://") or not host or url.username is not None
                or url.password is not None or url.port not in (None, 443) or "#" in value
                or not host.isascii() or len(host) > 253):
            return False
        host = host.lower()
        reserved = ("local", "localhost", "internal", "invalid", "test", "example", "home.arpa", "localhost.localdomain",
                    "lan", "home", "ts.net")
        labels = host.split(".")
        if (len(labels) < 2 or not re.fullmatch(r"[a-z]{2,63}", labels[-1])
                or any(host == suffix or host.endswith("." + suffix) for suffix in reserved)):
            return False
        return all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                   for label in host.split("."))
    except (ValueError, UnicodeError):
        return False


def search_request(raw: bytes) -> dict:
    value = strict_json(raw)
    if (not isinstance(value, dict)
            or set(value) != {"schemaVersion", "requestId", "query"}
            or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
            or not isinstance(value["requestId"], str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value["requestId"])
            or not isinstance(value["query"], str) or not value["query"].strip()
            or len(value["query"].encode("utf-8")) > 512
            or any(ord(c) < 32 or ord(c) == 127 for c in value["query"])
            or any(marker in value["query"] for marker in RESERVED_MARKERS)):
        raise ValueError("invalid request")
    return value


def read_request(raw: bytes) -> dict:
    value = strict_json(raw)
    if (not isinstance(value, dict) or set(value) != {"schemaVersion", "requestId", "resultId"}
            or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
            or not isinstance(value["requestId"], str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value["requestId"])
            or not isinstance(value["resultId"], str) or not re.fullmatch(r"[a-f0-9]{32}", value["resultId"])):
        raise ValueError("invalid request")
    return value


def fetch_existing_search(query: str, *, connection_factory=http.client.HTTPConnection) -> dict:
    # Fixed upstream. Incoming cookies, headers and bearer tokens are NEVER
    # forwarded; only the validated query is encoded into SearXNG's form.
    connection = connection_factory("127.0.0.1", 8721, timeout=12)
    try:
        connection.request("POST", "/search", urlencode({"q": query, "format": "json"}),
                           {"Content-Type": "application/x-www-form-urlencoded",
                            "Accept": "application/json", "Accept-Encoding": "identity"})
        response = connection.getresponse()
        if (response.status != 200 or response.getheader("Content-Encoding", "identity") != "identity"
                or response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json"):
            raise ValueError("upstream unavailable")
        data = response.read(MAX_UPSTREAM + 1)
        if len(data) > MAX_UPSTREAM:
            raise ValueError("upstream too large")
        value = strict_json(data)
        if not isinstance(value, dict) or not isinstance(value.get("results"), list):
            raise ValueError("invalid upstream")
        return value
    finally:
        connection.close()


def search_result(request_id: str, upstream: dict) -> dict:
    if not isinstance(upstream, dict) or not isinstance(upstream.get("results"), list):
        raise ValueError("invalid upstream")
    result = {"schemaVersion": 1, "requestId": request_id,
              "results": [], "degraded": bool(upstream.get("unresponsive_engines"))}
    seen = set()
    for index, row in enumerate(upstream["results"][:100]):
        if not isinstance(row, dict):
            result["degraded"] = True
            continue
        url = row.get("url")
        title = plain(row.get("title"), 256)
        if not title or not public_https_url(url) or any(marker in url for marker in RESERVED_MARKERS):
            result["degraded"] = True
            continue
        if url in seen:
            continue
        seen.add(url)
        raw_snippet = row.get("content", "")
        snippet = plain(raw_snippet, 1024)
        if raw_snippet and not snippet:
            result["degraded"] = True
        item = {"id": hashlib.sha256(url.encode("utf-8")).hexdigest()[:32],
                "title": title, "url": url, "snippet": snippet}
        result["results"].append(item)
        if len(encode(result)) > MAX_RESPONSE:
            result["results"].pop()
            result["degraded"] = True
            break
        if len(result["results"]) == 10:
            if index + 1 < len(upstream["results"]):
                result["degraded"] = True
            break
    if not result["results"]:
        result["degraded"] = True
    return result


class PrivateGateway(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, tokens: list[str], search: Callable[[str], dict] = fetch_existing_search,
                 *, reader=None, clock=time.monotonic):
        if address[0] != "127.0.0.1":
            raise ValueError("listener must remain loopback")
        self.tokens = tuple(validated_tokens(tokens))
        self.search = search
        self.reader = reader if reader is not None else PublicPageReader()
        self.clock = clock
        self._connection_slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self._rate_lock = threading.Lock()
        self._search_times = deque(maxlen=MAX_SEARCHES_PER_MINUTE)
        self._read_times = deque(maxlen=MAX_READS_PER_MINUTE)
        self._handles_lock = threading.Lock()
        self._handles = OrderedDict()
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        # Bound the handler threads themselves, including slow header/body
        # clients, instead of only putting a semaphore around provider calls.
        if not self._connection_slots.acquire(blocking=False):
            body = encode({"error": "busy"})
            response = (b"HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n"
                        + b"Connection: close\r\nContent-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body)
            try:
                request.settimeout(1)
                request.sendall(response)
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._connection_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._connection_slots.release()

    def reserve_search(self):
        with self._rate_lock:
            now = time.monotonic()
            while self._search_times and self._search_times[0] <= now - 60:
                self._search_times.popleft()
            if len(self._search_times) >= MAX_SEARCHES_PER_MINUTE:
                return False
            self._search_times.append(now)
            return True

    def remember_hits(self, client: str, result: dict):
        with self._handles_lock:
            now = self.clock()
            for key in list(self._handles):
                if self._handles[key]["expires"] <= now:
                    del self._handles[key]
            key = client, result["requestId"]
            self._handles.pop(key, None)
            client_keys = [key for key in self._handles if key[0] == client]
            while len(client_keys) >= MAX_REQUESTS_PER_CLIENT:
                self._handles.pop(client_keys.pop(0))
            while len(self._handles) >= MAX_CACHED_REQUESTS:
                self._handles.popitem(last=False)
            self._handles[key] = {"expires": now + HANDLE_TTL,
                                  "hits": {hit["id"]: dict(hit) for hit in result["results"]},
                                  "consumed": set(), "attempts": 0}

    def take_hit(self, client: str, request_id: str, result_id: str):
        with self._handles_lock:
            now = self.clock()
            key = client, request_id
            entry = self._handles.get(key)
            if entry is None:
                return None
            if entry["expires"] <= now:
                del self._handles[key]
                return None
            if result_id not in entry["hits"] or result_id in entry["consumed"]:
                return None
            if entry["attempts"] >= MAX_READS_PER_REQUEST:
                return "busy"
            with self._rate_lock:
                while self._read_times and self._read_times[0] <= now - 60:
                    self._read_times.popleft()
                if len(self._read_times) >= MAX_READS_PER_MINUTE:
                    return "busy"
                self._read_times.append(now)
            # Consume before network activity. Failure or a lost response must
            # never silently repeat a page request for this handle.
            entry["attempts"] += 1
            entry["consumed"].add(result_id)
            return dict(entry["hits"][result_id])

    def handle_error(self, request, client_address):
        pass  # Never print request data, secrets, or raw framework tracebacks.


class Handler(BaseHTTPRequestHandler):
    server: PrivateGateway
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_):
        pass  # Deliberately no URLs, queries, tokens, or raw failure messages.

    def send_json(self, status: int, value):
        data = encode(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self) -> bool:
        values = self.headers.get_all("Authorization", [])
        token = values[0][7:] if len(values) == 1 and values[0].startswith("Bearer ") else ""
        if not token.isascii() or len(token) > 256:
            return False
        # Compare every configured token; do not reveal which device matched.
        matches = [hmac.compare_digest(token, allowed) for allowed in self.server.tokens]
        allowed = bool(token) and any(matches)
        # Request-local, nonreversible client key; never log or return it.
        self.client_key = hashlib.sha256(token.encode("ascii")).hexdigest() if allowed else None
        return allowed

    def dispatch(self, method: str):
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        if method == "GET" and self.path == "/v1/capabilities":
            self.send_json(200, CAPABILITIES)
            return
        if method == "GET" and self.path == "/v2/capabilities":
            self.send_json(200, CAPABILITIES_V2)
            return
        if method != "POST" or self.path not in ("/v1/search", "/v2/read"):
            self.send_json(404, {"error": "not_found"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if (len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,6}", lengths[0])
                or not 0 < int(lengths[0]) <= MAX_REQUEST
                or len(self.headers.get_all("Content-Type", [])) != 1
                or len(self.headers.get_all("Content-Encoding", [])) > 1
                or self.headers.get("Transfer-Encoding") is not None
                or self.headers.get("Content-Encoding", "identity") != "identity"
                or self.headers.get_content_type() != "application/json"):
            self.send_json(400, {"error": "invalid_request"})
            return
        try:
            raw = self.rfile.read(int(lengths[0]))
            if len(raw) != int(lengths[0]):
                raise ValueError("incomplete body")
            request = read_request(raw) if self.path == "/v2/read" else search_request(raw)
        except (ValueError, UnicodeError, RecursionError, socket.timeout):
            self.send_json(400, {"error": "invalid_request"})
            return
        if self.path == "/v2/read":
            hit = self.server.take_hit(self.client_key, request["requestId"], request["resultId"])
            if hit == "busy":
                self.send_json(429, {"error": "busy"})
                return
            if hit is None:
                self.send_json(404, {"error": "read_unavailable"})
                return
            try:
                page = self.server.reader.read(hit["url"], hit["title"])
                result = {"schemaVersion": 1, "requestId": request["requestId"],
                          "resultId": request["resultId"], **page}
                if len(encode(result)) > MAX_RESPONSE:
                    raise ValueError("result too large")
            except Exception:
                self.send_json(502, {"error": "read_unavailable"})
                return
            self.send_json(200, result)
            return
        if not self.server.reserve_search():
            self.send_json(429, {"error": "busy"})
            return
        try:
            result = search_result(request["requestId"], self.server.search(request["query"]))
            self.server.remember_hits(self.client_key, result)
        except Exception:
            self.send_json(502, {"error": "search_unavailable"})
            return
        self.send_json(200, result)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")


if __name__ == "__main__":
    try:
        configured = load_configured_tokens(os.environ)
        gateway = PrivateGateway(("127.0.0.1", 8722), configured)
    except (ValueError, OSError):
        raise SystemExit("Private gateway configuration invalid; no listener started.") from None
    try:
        gateway.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        gateway.server_close()
