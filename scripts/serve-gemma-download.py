#!/usr/bin/env python3
"""Serve only the verified abliterated RMScomposite download and its public sidecars."""
import argparse
from email.utils import formatdate
import hashlib
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit

ARCHIVE = "Assist-Gemma-4-E2B-32K-group8-abliterated-rmscomposite.zip"
ARCHIVE_BYTES = 2_784_386_908
ARCHIVE_SHA256 = "74c0d0d038c5ead913f68ce8a20d01ecb09bcda9559a1c406b62becfb3511c97"


def open_regular(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    stream = os.fdopen(descriptor, "rb")
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        stream.close()
        raise ValueError("Only regular files may be served")
    return stream


def go(size):
    return f"{size / 1_000_000_000:.2f}".replace(".", ",") + " Go"


def prepare(directory):
    with open_regular(directory / "download-integrity.json") as stream:
        report = json.load(stream)
    if not (report.get("status") == "archive_verified_against_validated_inventory"
            and report.get("archive") == ARCHIVE and report.get("bytes") == ARCHIVE_BYTES
            and report.get("sha256") == ARCHIVE_SHA256 and report.get("files") == 9
            and report.get("uncompressed_bytes") == 3_763_177_239
            and report.get("structure_passed") is True and report.get("quality_passed") is False
            and report.get("new_composite_cpu_quality", {}).get("passed_cases") == 7
            and report.get("new_composite_cpu_quality", {}).get("failed_case_ids") == ["integer-cubes"]
            and report.get("physical_device_qualified") is False):
        raise ValueError("The download report differs from the reviewed candidate")
    with open_regular(directory / ARCHIVE) as stream:
        before = os.fstat(stream.fileno())
        actual_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        after = os.fstat(stream.fileno())
    fingerprint = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    if (before.st_size != ARCHIVE_BYTES or actual_hash != ARCHIVE_SHA256
            or fingerprint(before) != fingerprint(after)):
        raise ValueError("Archive bytes changed or failed the pinned SHA-256")
    with open_regular(directory / (ARCHIVE + ".sha256")) as stream:
        if stream.read().decode().strip() != f"{ARCHIVE_SHA256}  {ARCHIVE}":
            raise ValueError("SHA-256 sidecar differs from the reviewed archive")
    template = Path(__file__).with_name("gemma-download-page.html").read_text()
    replacements = {
        "__ARCHIVE_NAME__": ARCHIVE,
        "__ARCHIVE_SIZE__": go(ARCHIVE_BYTES),
        "__UNPACKED_SIZE__": go(report["uncompressed_bytes"]),
        "__COMBINED_SIZE__": go(ARCHIVE_BYTES + report["uncompressed_bytes"]),
        "__ARCHIVE_BYTES__": f"{ARCHIVE_BYTES:,}".replace(",", " "),
        "__SHA256__": ARCHIVE_SHA256,
    }
    for key, value in replacements.items():
        template = template.replace(key, html.escape(value, quote=True))
    if re.search(r"__[A-Z_]+__", template):
        raise ValueError("Unresolved page placeholder")
    output = directory / "index.html"
    if output.is_symlink():
        raise ValueError("Refusing to replace a symlinked page")
    output.write_text(template)
    return fingerprint(after)


def handler(directory, archive_fingerprint):
    allowed = {
        "/": ("index.html", "text/html; charset=utf-8"),
        "/index.html": ("index.html", "text/html; charset=utf-8"),
        "/" + ARCHIVE: (ARCHIVE, "application/zip"),
        "/" + ARCHIVE + ".sha256": (ARCHIVE + ".sha256", "text/plain; charset=utf-8"),
        "/download-integrity.json": ("download-integrity.json", "application/json"),
    }

    class Download(BaseHTTPRequestHandler):
        def do_HEAD(self):
            self.serve(False)

        def do_GET(self):
            self.serve(True)

        def serve(self, body):
            item = allowed.get(urlsplit(self.path).path)
            if item is None:
                self.send_error(404)
                return
            name, kind = item
            try:
                stream = open_regular(directory / name)
            except (OSError, ValueError):
                self.send_error(404)
                return
            with stream:
                info = os.fstat(stream.fileno())
                if name == ARCHIVE and (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != archive_fingerprint:
                    self.send_error(503, "Archive changed since verification")
                    return
                size = info.st_size
                etag = '"' + (ARCHIVE_SHA256 if name == ARCHIVE else str(info.st_mtime_ns)) + '"'
                start, end = 0, size - 1
                requested = self.headers.get("Range")
                if self.headers.get("If-Range", etag) != etag:
                    requested = None
                if requested:
                    match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested) if len(requested) <= 100 else None
                    valid = match is not None and bool(match[1] or match[2])
                    if valid:
                        if match[1]:
                            start = int(match[1])
                            end = min(int(match[2]), size - 1) if match[2] else size - 1
                        else:
                            suffix = int(match[2])
                            start = max(0, size - suffix)
                            valid = suffix > 0
                        valid = valid and 0 <= start <= end < size
                    if not valid:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                self.send_response(206 if requested else 200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(end - start + 1))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("ETag", etag)
                self.send_header("Last-Modified", formatdate(info.st_mtime, usegmt=True))
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("X-Robots-Tag", "noindex, nofollow")
                if name == "index.html":
                    self.send_header("Cache-Control", "no-cache")
                if name == ARCHIVE:
                    self.send_header("Content-Disposition", f'attachment; filename="{name}"')
                if requested:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.end_headers()
                if body:
                    try:
                        stream.seek(start)
                        remaining = end - start + 1
                        while remaining:
                            block = stream.read(min(1024 * 1024, remaining))
                            if not block:
                                break
                            self.wfile.write(block)
                            remaining -= len(block)
                    except (BrokenPipeError, ConnectionResetError):
                        pass

    return Download


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--bind", default="127.0.0.1", choices=["127.0.0.1"])
    parser.add_argument("--port", type=int, default=9451)
    args = parser.parse_args()
    directory = args.directory.resolve(strict=True)
    fingerprint = prepare(directory)
    print(json.dumps({"status": "archive_verified_page_ready", "archive": ARCHIVE,
                      "bytes": ARCHIVE_BYTES, "sha256": ARCHIVE_SHA256,
                      "bind": args.bind, "port": args.port}), flush=True)
    ThreadingHTTPServer((args.bind, args.port), handler(directory, fingerprint)).serve_forever()
