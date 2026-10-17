#!/usr/bin/env python3
"""Explicit host-side provisioning; Assist's inference APIs never download.

Only the app-bundled, pinned manifest supplies paths, repositories and hashes.
No recording, voice reference, credential or user text is read or uploaded.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sys
import urllib.request


MANIFEST = Path(__file__).resolve().parents[1] / "mobile/ios/Assist/AdvancedVoiceAssets.json"
MARKER = "assist-voice-pack.json"


def digest(path):
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def validate_manifest(manifest):
    if manifest.get("schemaVersion") != 1 or set(manifest.get("groups", {})) != {"pocket", "redux", "ultra", "silero"}:
        raise ValueError("Unsupported manifest")
    for name, group in manifest["groups"].items():
        expected_repo = {"pocket": "pocket-tts-coreml", "redux": "parakeet-redux-coreml",
                         "ultra": "parakeet-ultra-coreml", "silero": "silero-vad-coreml"}[name]
        if group["repository"] != "FluidInference/" + expected_repo:
            raise ValueError("Unexpected model repository")
        if len(group["revision"]) != 40 or any(c not in "0123456789abcdef" for c in group["revision"]):
            raise ValueError("Model revision must be pinned")
        seen = set()
        for item in group["files"]:
            path = item["path"]
            parts = path.split("/")
            if path in seen or "\\" in path or not parts or any(p in ("", ".", "..") for p in parts):
                raise ValueError("Unsafe or duplicate asset path")
            seen.add(path)
            if len(item["sha256"]) != 64 or any(c not in "0123456789abcdef" for c in item["sha256"]) or item["size"] <= 0:
                raise ValueError("Invalid asset hash/size")
        if not seen:
            raise ValueError("Empty model group")


def checked_target(root, relative):
    value = root
    for part in PurePosixPath(relative).parts:
        value = value / part
        if value.is_symlink():
            raise ValueError("A symlink is not allowed inside a voice pack")
    return value


def matches(path, item):
    return path.is_file() and path.stat().st_size == item["size"] and digest(path) == item["sha256"]


def prepare(manifest, manifest_hash, output, variants, download=False):
    # A resume marker owns only a dedicated pack directory, never an arbitrary
    # user's populated directory. Existing unrelated files are never removed.
    if output.is_symlink() or not output.name or output.resolve() == Path(output.anchor):
        raise ValueError("Choose a dedicated local pack folder")
    marker = output / MARKER
    if output.exists():
        if not marker.is_file() or marker.is_symlink():
            raise ValueError("Existing folder has no Assist pack marker; choose a new folder")
        if json.loads(marker.read_text())["manifestSHA256"] != manifest_hash:
            raise ValueError("Existing folder belongs to another manifest; choose a new folder")
    elif not download:
        raise ValueError("Pack does not exist")
    else:
        output.mkdir(parents=True)
        marker.write_text(json.dumps({"schemaVersion": 1, "manifestSHA256": manifest_hash}) + "\n")
    groups = ["pocket", "silero"] + list(variants)
    if any((output / name).exists() for name in ("redux", "ultra") if name not in variants):
        raise ValueError("Pack contains another Parakeet variant; use --variant both to verify it completely, or a new folder")
    total = sum(item["size"] for name in groups for item in manifest["groups"][name]["files"])
    complete = 0
    for name in groups:
        group = manifest["groups"][name]
        for item in group["files"]:
            target = checked_target(output, name + "/" + item["path"])
            if not matches(target, item):
                if not download:
                    raise ValueError("Missing or invalid asset: " + name + "/" + item["path"])
                target.parent.mkdir(parents=True, exist_ok=True)
                remote_path = ("v2.1/french_24l/" if name == "pocket" else "") + item["path"]
                url = "https://huggingface.co/" + group["repository"] + "/resolve/" + group["revision"] + "/" + remote_path
                temporary = target.with_name(target.name + ".assist-download")
                if temporary.is_symlink():
                    raise ValueError("Unsafe temporary asset")
                try:
                    hasher = hashlib.sha256()
                    size = 0
                    request = urllib.request.Request(url, headers={"User-Agent": "Assist-local-voice-provisioner/1"})
                    with urllib.request.urlopen(request, timeout=120) as source, temporary.open("wb") as destination:
                        while block := source.read(1024 * 1024):
                            size += len(block)
                            if size > item["size"]:
                                raise ValueError("Asset exceeded pinned size")
                            hasher.update(block)
                            destination.write(block)
                        destination.flush()
                        os.fsync(destination.fileno())
                    if size != item["size"] or hasher.hexdigest() != item["sha256"]:
                        raise ValueError("Asset failed pinned SHA-256 verification")
                    temporary.replace(target)
                finally:
                    temporary.unlink(missing_ok=True)
            complete += item["size"]
            print(f"Verified {name}/{item['path']} ({complete}/{total} bytes)", flush=True)
    return total


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--variant", choices=["redux", "ultra", "both"], default="redux")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--download", action="store_true", help="Explicitly download pinned public weights on this computer")
    parser.add_argument("--verify", action="store_true", help="Verify an existing pack without network access")
    args = parser.parse_args()
    data = MANIFEST.read_bytes()
    manifest = json.loads(data)
    validate_manifest(manifest)
    variants = ["redux", "ultra"] if args.variant == "both" else [args.variant]
    groups = ["pocket", "silero"] + variants
    total = sum(v["size"] for name in groups for v in manifest["groups"][name]["files"])
    print(json.dumps({"variant": args.variant, "bytes": total, "sdkRevision": manifest["sdkRevision"],
                      "manifestSHA256": hashlib.sha256(data).hexdigest()}), flush=True)
    if args.download == args.verify:
        if args.download:
            parser.error("Choose download OR verify")
        return 0  # Default is a plan, with no disk/network mutation.
    if args.output is None:
        parser.error("--output is required to download or verify")
    prepare(manifest, hashlib.sha256(data).hexdigest(), args.output, variants, args.download)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError) as error:
        print("Voice pack: " + str(error), file=sys.stderr)
        sys.exit(1)
