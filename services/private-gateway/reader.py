"""Bounded public HTTPS reader. All page content remains untrusted data.

No proxy environment, cookies, authentication, JavaScript, PDF or login support.
DNS is resolved in a short-lived isolated subprocess, then a numeric address is
pinned in the actual socket; TLS still authenticates the original DNS hostname.
"""
from __future__ import annotations

from datetime import datetime, timezone
from html.parser import HTMLParser
import http.client
import ipaddress
import json
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
from urllib.parse import quote, urljoin, urlsplit

MAX_PAGE = 512 * 1024
MAX_ROBOTS = 64 * 1024
MAX_TEXT = 8192
MAX_REDIRECTS = 3
READ_SECONDS = 15
USER_AGENT = "AssistResearchReader/1.0"
PRODUCT_TOKEN = "assistresearchreader"
RESERVED_MARKERS = ("<|", "|>", "<turn", "<channel", "<tool", "</tool", "<bos", "<eos", "<pad", "<unk",
                    "<function", "</function", "<atem:", "</atem:", "[TOOL_CALLS]")
DENIED_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "192.0.0.0/24", "192.88.99.0/24", "168.63.129.16/32",  # platform/special-purpose endpoints
    "64:ff9b::/96", "64:ff9b:1::/48", "2001::/23", "2002::/16", "3fff::/20"))


class ReaderUnavailable(ValueError):
    """Only a fixed error code may cross the HTTP boundary."""


def public_address(value: str) -> bool:
    try:
        if "%" in value:  # No IPv6 scope identifiers, including on global addresses.
            return False
        address = ipaddress.ip_address(value)
        return (address.is_global and not address.is_multicast and not address.is_reserved
                and not address.is_unspecified and not address.is_loopback and not address.is_link_local
                and not (isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None)
                and not any(address.version == network.version and address in network for network in DENIED_NETWORKS))
    except ValueError:
        return False


def validated_url(value: str):
    if (not isinstance(value, str) or not value or len(value.encode("utf-8")) > 2048
            or not value.startswith("https://") or any(ord(c) <= 32 or ord(c) == 127 for c in value)
            or "\\" in value or "#" in value or any(marker in value for marker in RESERVED_MARKERS)):
        raise ReaderUnavailable()
    try:
        parts = urlsplit(value)
        host = parts.hostname
        reserved = ("local", "localhost", "internal", "invalid", "test", "example", "home.arpa",
                    "localhost.localdomain", "lan", "home", "ts.net")
        if (not host or not host.isascii() or len(host) > 253 or parts.username is not None
                or parts.password is not None or parts.port not in (None, 443)
                or len(host.split(".")) < 2 or not re.fullmatch(r"[a-z]{2,63}", host.split(".")[-1])
                or any(host == suffix or host.endswith("." + suffix) for suffix in reserved)
                or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split("."))):
            raise ReaderUnavailable()
        return parts
    except (ValueError, UnicodeError):
        raise ReaderUnavailable() from None


def remaining(deadline: float, clock=time.monotonic) -> float:
    budget = deadline - clock()
    if budget <= 0:
        raise ReaderUnavailable()
    return budget


def resolve_public(host: str, deadline: float, *, clock=time.monotonic) -> list[str]:
    # getaddrinfo has no reliable per-call deadline. Do not leave unbounded DNS
    # threads behind after timeouts or fork the multithreaded HTTP server.
    program = ("import json,socket,sys; "
               "rows=socket.getaddrinfo(sys.argv[1],443,type=socket.SOCK_STREAM); "
               "print(json.dumps(list(dict.fromkeys(r[4][0] for r in rows))[:17]))")
    try:
        completed = subprocess.run([sys.executable, "-I", "-S", "-c", program, host],
                                   capture_output=True, check=False, env={},
                                   timeout=min(3.0, remaining(deadline, clock)))
        if completed.returncode != 0 or len(completed.stdout) > 2048:
            raise ReaderUnavailable()
        addresses = json.loads(completed.stdout)
        if (not isinstance(addresses, list) or not 1 <= len(addresses) <= 16
                or not all(isinstance(address, str) and public_address(address) for address in addresses)):
            raise ReaderUnavailable()
        return addresses
    except (OSError, subprocess.SubprocessError, ValueError, TypeError):
        raise ReaderUnavailable() from None


class PinnedConnection(http.client.HTTPConnection):
    """One request only, keeping the real socket owned until body completion.

    HTTPConnection.getresponse normally clears/closes its socket reference on
    Connection: close headers; this one-shot reader must keep that exact socket
    available for deadline updates and shutdown throughout the response body.
    """

    def getresponse(self):
        response = http.client.HTTPResponse(self.sock, method="GET")
        try:
            response.begin()
            return response
        except BaseException:
            response.close()
            raise


def connect_pinned(host: str, address: str, deadline: float, *, clock=time.monotonic):
    context = ssl.create_default_context()
    if not context.check_hostname or context.verify_mode != ssl.CERT_REQUIRED or not public_address(address):
        raise ReaderUnavailable()
    raw = None
    secure = None
    try:
        family = socket.AF_INET6 if ipaddress.ip_address(address).version == 6 else socket.AF_INET
        raw = socket.socket(family, socket.SOCK_STREAM)
        raw.settimeout(remaining(deadline, clock))
        raw.connect((address, 443))  # Numeric address: never resolves the hostname again.
        raw.settimeout(remaining(deadline, clock))
        secure = context.wrap_socket(raw, server_hostname=host)
        raw = None
        if ipaddress.ip_address(secure.getpeername()[0]) != ipaddress.ip_address(address):
            raise ReaderUnavailable()
        # HTTPConnection gets an already-connected, verified TLS socket. It has
        # no proxy/tunnel, redirect, cookie jar or implicit authentication path.
        connection = PinnedConnection(host, 443, timeout=remaining(deadline, clock))
        connection.sock = secure
        return connection
    except Exception:
        if secure is not None:
            secure.close()
        if raw is not None:
            raw.close()
        raise ReaderUnavailable() from None


def rep_path(value: str) -> str:
    # Normalize escaped unreserved octets, retain reserved octets and percent-
    # encode Unicode. Rules and request paths use the same comparison form.
    unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    value = re.sub(r"%([0-9a-fA-F]{2})", lambda m: chr(int(m[1], 16))
                   if chr(int(m[1], 16)) in unreserved else "%" + m[1].upper(), value)
    return quote(value, safe="/%?=&:;,+!$@()*-._~")


def rule_matches(pattern: str, path: str) -> bool:
    # Ordered literal searches, not a backtracking regexp compiled from an
    # attacker-controlled robots pattern (many wildcards can otherwise consume
    # unbounded CPU despite the socket deadline).
    anchored = pattern.endswith("$")
    pieces = (pattern[:-1] if anchored else pattern).split("*")
    if not path.startswith(pieces[0]):
        return False
    if len(pieces) == 1:
        return not anchored or path == pieces[0]
    position = len(pieces[0])
    for piece in pieces[1:-1]:
        position = path.find(piece, position)
        if position < 0:
            return False
        position += len(piece)
    last = pieces[-1]
    return (path.endswith(last) and len(path) - len(last) >= position) if anchored else path.find(last, position) >= 0


def robots_allowed(source: str, url: str) -> bool:
    groups = []
    agents, rules = [], []
    if len(source.splitlines()) > 2048:
        raise ReaderUnavailable()
    for raw in source.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, value = (part.strip() for part in line.split(":", 1))
        key = key.lower()
        if key == "user-agent":
            if rules:
                groups.append((agents, rules))
                agents, rules = [], []
            agents.append(value.lower())
        elif key in ("allow", "disallow") and agents:
            rules.append((key == "allow", value))
    groups.append((agents, rules))
    selected = [rules for agents, rules in groups if PRODUCT_TOKEN in agents]
    if not selected:
        selected = [rules for agents, rules in groups if "*" in agents]
    parts = urlsplit(url)
    path = rep_path((parts.path or "/") + ("?" + parts.query if parts.query else ""))
    matches = []
    for rules in selected:
        for allow, raw in rules:
            if not raw:
                continue
            pattern = rep_path(raw)
            if rule_matches(pattern, path):
                literal = pattern[:-1] if pattern.endswith("$") else pattern
                matches.append((len(literal.replace("*", "").encode("utf-8")), allow))
    return not matches or max(matches)[1]


class TextExtractor(HTMLParser):
    OMIT = frozenset(("head", "script", "style", "noscript", "nav", "header", "footer", "form", "svg",
                      "canvas", "template", "iframe", "object", "audio", "video"))

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = []
        self.fragments = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag not in ("area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr") and (
                tag in self.OMIT or "hidden" in attributes or attributes.get("aria-hidden") == "true"):
            self.hidden.append(tag)

    def handle_startendtag(self, tag, attrs):
        pass

    def handle_endtag(self, tag):
        if tag in self.hidden:
            self.hidden = self.hidden[:self.hidden.index(tag)]

    def handle_data(self, data):
        if not self.hidden:
            self.fragments.append(data)


def extract_text(body: bytes, mime: str, charset="utf-8") -> tuple[str, bool]:
    if charset.lower() not in ("utf-8", "utf8", "us-ascii", "ascii", "iso-8859-1", "windows-1252"):
        raise ReaderUnavailable()
    try:
        source = body.decode(charset, errors="strict")
        if mime == "text/html":
            parser = TextExtractor()
            parser.feed(source)
            parser.close()
            source = " ".join(parser.fragments)
        text = " ".join(source.split())
        text = "".join(c for c in text if ord(c) >= 32 and ord(c) != 127)
        if not text or any(marker in text for marker in RESERVED_MARKERS):
            raise ReaderUnavailable()
        raw = text.encode("utf-8")
        return raw[:MAX_TEXT].decode("utf-8", errors="ignore"), len(raw) > MAX_TEXT
    except (ValueError, LookupError):
        raise ReaderUnavailable() from None


class PublicPageReader:
    def __init__(self, *, resolver=resolve_public, connector=connect_pinned, clock=time.monotonic):
        self.resolver, self.connector, self.clock = resolver, connector, clock

    def fetch(self, url: str, deadline: float, maximum: int):
        parts = validated_url(url)
        addresses = self.resolver(parts.hostname, deadline)
        if not addresses or len(addresses) > 16 or not all(public_address(value) for value in addresses):
            raise ReaderUnavailable()
        connection = self.connector(parts.hostname, addresses[0], deadline)  # Exactly one connection attempt.
        active_socket = connection.sock

        def expire():
            # A per-recv socket timeout alone can be defeated by a slow stream
            # (including HTTP headers). Shut down the actual socket at the
            # absolute deadline; at most two handler/timer pairs can exist.
            try:
                active_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        timer = threading.Timer(remaining(deadline, self.clock), expire)
        timer.daemon = True
        response = None
        try:
            timer.start()
            connection.sock.settimeout(remaining(deadline, self.clock))
            target = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
            if parts.query:
                target += "?" + quote(parts.query, safe="/%?:@!$&'()*+,;=-._~")
            connection.request("GET", target, headers={"Host": parts.hostname, "User-Agent": USER_AGENT,
                               "Accept": "text/html, text/plain;q=0.9", "Accept-Encoding": "identity", "Connection": "close"})
            connection.sock.settimeout(remaining(deadline, self.clock))
            response = connection.getresponse()
            if response.status != 200:
                return response.status, response.getheader("Location"), b"", "", "utf-8"
            if response.getheader("Content-Encoding", "identity").lower() != "identity":
                raise ReaderUnavailable()
            mime_header = response.getheader("Content-Type", "")
            mime = mime_header.split(";", 1)[0].strip().lower()
            if mime not in ("text/plain", "text/html"):
                raise ReaderUnavailable()
            length = response.getheader("Content-Length")
            if length is not None and (not re.fullmatch(r"[0-9]{1,10}", length) or int(length) > maximum):
                raise ReaderUnavailable()
            transfer = response.getheader("Transfer-Encoding")
            if transfer is not None and (transfer.lower() != "chunked" or length is not None):
                raise ReaderUnavailable()
            charset = re.search(r"(?:^|;)\s*charset\s*=\s*[\"']?([A-Za-z0-9_-]+)", mime_header, re.I)
            chunks, size = [], 0
            while True:
                connection.sock.settimeout(remaining(deadline, self.clock))
                # read1 performs at most one underlying read, so the deadline
                # is also checked between individual network chunks.
                read = getattr(response, "read1", response.read)
                chunk = read(min(16384, maximum + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > maximum:
                    raise ReaderUnavailable()
            remaining(deadline, self.clock)
            if length is not None and size != int(length):
                raise ReaderUnavailable()
            return response.status, None, b"".join(chunks), mime, charset[1] if charset else "utf-8"
        finally:
            timer.cancel()
            if response is not None and hasattr(response, "close"):
                response.close()
            connection.close()

    def read(self, url: str, title: str) -> dict:
        deadline = self.clock() + READ_SECONDS
        approved_robots = {}
        current = url
        try:
            for hop in range(MAX_REDIRECTS + 1):
                parts = validated_url(current)
                origin = "https://" + parts.netloc
                if origin not in approved_robots:
                    status, _, body, mime, charset = self.fetch(origin + "/robots.txt", deadline, MAX_ROBOTS)
                    if status in (404, 410):
                        approved_robots[origin] = ""
                    elif status == 200 and mime == "text/plain":
                        approved_robots[origin] = body.decode(charset, errors="strict")
                    else:
                        raise ReaderUnavailable()
                if not robots_allowed(approved_robots[origin], current):
                    raise ReaderUnavailable()
                status, location, body, mime, charset = self.fetch(current, deadline, MAX_PAGE)
                if status in (301, 302, 303, 307, 308) and hop < MAX_REDIRECTS and location:
                    current = urljoin(current, location)
                    validated_url(current)
                    continue
                if status != 200:
                    raise ReaderUnavailable()
                text, truncated = extract_text(body, mime, charset)
                remaining(deadline, self.clock)
                return {"title": title, "url": current, "text": text, "truncated": truncated,
                        "readAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "untrusted": True}
            raise ReaderUnavailable()
        except Exception:
            raise ReaderUnavailable() from None
