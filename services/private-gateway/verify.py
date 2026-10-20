"""Explicit operator HTTPS qualification; prints only redacted proof metadata.

No page reader, proxy configuration, service mutation, or automatic retry.
Default mode verifies authentication and capabilities, without a search query.
"""
import argparse
import json
import re
import secrets
import ssl
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener

from credentials import load_tokens_file
from server import CAPABILITIES, MAX_RESPONSE, RESERVED_MARKERS, encode, public_https_url, search_request, strict_json


class QualificationError(ValueError):
    def __init__(self, code, status=None):
        super().__init__(code)
        self.code = code
        self.status = status


class RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def origin_url(value):
    if (not isinstance(value, str) or len(value.encode("utf-8")) > 2048
            or not value.startswith("https://") or "\\" in value
            or any(ord(c) <= 32 or ord(c) == 127 for c in value)):
        raise QualificationError("invalid_origin")
    try:
        parts = urlsplit(value)
        if (not parts.hostname or not parts.hostname.isascii() or "%" in parts.netloc
                or parts.username is not None or parts.password is not None
                or parts.path not in ("", "/") or "?" in value or "#" in value
                or parts.port is not None and not 1 <= parts.port <= 65535):
            raise ValueError("invalid origin")
    except ValueError:
        raise QualificationError("invalid_origin") from None
    return value.rstrip("/")


def https_request(opener, url, *, token=None, body=None):
    headers = {"Accept": "application/json", "Cache-Control": "no-store",
               "User-Agent": "Assist-Private-Qualifier/1"}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(url, data=body, headers=headers, method="POST" if body is not None else "GET")
    try:
        response = opener.open(request, timeout=20)
    except HTTPError as error:
        response = error
    with response:
        status = response.code
        # Redirects, 401s and errors are never read, followed or reflected.
        if status != 200:
            return status, b""
        if response.geturl() != url or response.headers.get_content_type() != "application/json":
            raise QualificationError("invalid_response", status)
        data = response.read(MAX_RESPONSE + 1)
        if len(data) > MAX_RESPONSE:
            raise QualificationError("oversized_response", status)
        return status, data


def validate_capabilities(raw):
    if len(raw) > MAX_RESPONSE:
        raise QualificationError("oversized_response")
    value = strict_json(raw)
    if (not isinstance(value, dict) or set(value) != set(CAPABILITIES)
            or type(value.get("schemaVersion")) is not int
            or type(value.get("protocolVersion")) is not int or value != CAPABILITIES):
        raise QualificationError("invalid_capabilities")


def validate_search(raw, request_id):
    if len(raw) > MAX_RESPONSE:
        raise QualificationError("oversized_response")
    value = strict_json(raw)
    if (not isinstance(value, dict) or set(value) != {"schemaVersion", "requestId", "results", "degraded"}
            or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
            or value["requestId"] != request_id or type(value["degraded"]) is not bool
            or not isinstance(value["results"], list) or len(value["results"]) > 10):
        raise QualificationError("invalid_search")
    ids = set()
    for hit in value["results"]:
        if (not isinstance(hit, dict) or set(hit) != {"id", "title", "url", "snippet"}
                or not isinstance(hit["id"], str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", hit["id"])
                or hit["id"] in ids or not isinstance(hit["title"], str)
                or len(hit["title"].encode("utf-8")) > 256
                or not isinstance(hit["snippet"], str) or len(hit["snippet"].encode("utf-8")) > 1024
                or not public_https_url(hit["url"])
                or any(marker in text for text in (hit["title"], hit["snippet"], hit["url"])
                       for marker in RESERVED_MARKERS)
                or any(ord(c) < 32 or ord(c) == 127 for text in (hit["title"], hit["snippet"]) for c in text)):
            raise QualificationError("invalid_search")
        ids.add(hit["id"])
    return len(value["results"]), value["degraded"]


def qualify(origin, tokens_file, query=None):
    origin = origin_url(origin)
    tokens = load_tokens_file(tokens_file)
    # Do not trust proxy environment variables; redirects are refused, and TLS
    # certificate/hostname validation uses the unmodified system default.
    opener = build_opener(ProxyHandler({}), HTTPSHandler(context=ssl.create_default_context()), RejectRedirects())
    endpoint = origin + "/v1/capabilities"
    status, _ = https_request(opener, endpoint)
    if status != 401:
        raise QualificationError("authentication_not_required", status)
    wrong = secrets.token_urlsafe(32)
    while wrong in tokens:
        wrong = secrets.token_urlsafe(32)
    status, _ = https_request(opener, endpoint, token=wrong)
    if status != 401:
        raise QualificationError("wrong_credential_accepted", status)
    status, data = https_request(opener, endpoint, token=tokens[0])
    if status != 200:
        raise QualificationError("authenticated_service_unavailable", status)
    validate_capabilities(data)
    report = {"tlsVerified": True, "unauthenticatedRejected": True, "wrongCredentialRejected": True,
              "capabilitiesVerified": True, "searchChecked": query is not None, "pagesFetched": 0}
    if query is not None:
        request_id = "qualification-" + secrets.token_hex(8)
        body = encode({"schemaVersion": 1, "requestId": request_id, "query": query})
        search_request(body)  # Same exact request contract, no headers/URL escape hatch.
        status, data = https_request(opener, origin + "/v1/search", token=tokens[0], body=body)
        if status != 200:
            raise QualificationError("search_unavailable", status)
        count, degraded = validate_search(data, request_id)
        report.update(searchVerified=True, hitCount=count, degraded=degraded)
    return report


def main():
    parser = argparse.ArgumentParser(description="Verify private HTTPS auth/schema without printing credentials or results.")
    parser.add_argument("--origin", required=True, help="HTTPS origin only, without path, query or user information.")
    parser.add_argument("--tokens-file", required=True, help="Absolute private credential-file path.")
    parser.add_argument("--query", help="Optional explicit PUBLIC technical query; omitted by default.")
    args = parser.parse_args()
    try:
        report = qualify(args.origin, args.tokens_file, args.query)
    except Exception as error:
        report = {"tlsVerified": False, "ok": False,
                  "error": error.code if isinstance(error, QualificationError) else "qualification_failed"}
        if isinstance(error, QualificationError) and isinstance(error.status, int) and 100 <= error.status <= 599:
            report["status"] = error.status
        print(json.dumps(report, separators=(",", ":")))
        return 1
    print(json.dumps(report, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
