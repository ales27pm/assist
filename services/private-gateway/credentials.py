"""Private credential files. No credential is returned through a log or CLI."""
import json
import os
from pathlib import Path
import re
import stat

MAX_CREDENTIAL_BYTES = 8192


def validated_tokens(value):
    if (not isinstance(value, list) or not 1 <= len(value) <= 16
            or not all(isinstance(token, str) and re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token)
                       for token in value) or len(set(value)) != len(value)):
        raise ValueError("invalid per-device token configuration")
    return list(value)


def open_parent(file_path, *, create_private_parent=False, require_private_parent=False):
    """Walk from / using directory descriptors; never follow a symlink.

    Only a missing immediate parent may be created. Existing unrelated
    directories are neither created recursively nor chmodded.
    """
    path = Path(file_path)
    if not path.is_absolute() or ".." in path.parts or not path.name:
        raise ValueError("explicit absolute credential path required")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open("/", flags)
    try:
        parts = path.parts[1:-1]
        for index, part in enumerate(parts):
            if create_private_parent and index == len(parts) - 1:
                try:
                    os.mkdir(part, 0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            next_descriptor = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        metadata = os.fstat(descriptor)
        if require_private_parent and (metadata.st_uid != os.getuid()
                                       or stat.S_IMODE(metadata.st_mode) != 0o700):
            raise ValueError("credential parent must be private and user-owned")
        return descriptor, path.name
    except BaseException:
        os.close(descriptor)
        raise


def load_tokens_file(file_path):
    parent, name = open_parent(file_path)
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        try:
            metadata = os.fstat(descriptor)
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                    or stat.S_IMODE(metadata.st_mode) != 0o600
                    or not 0 < metadata.st_size <= MAX_CREDENTIAL_BYTES):
                raise ValueError("credential file must be a private regular file")
            data = bytearray()
            while len(data) <= MAX_CREDENTIAL_BYTES:
                part = os.read(descriptor, min(4096, MAX_CREDENTIAL_BYTES + 1 - len(data)))
                if not part:
                    break
                data.extend(part)
            if len(data) > MAX_CREDENTIAL_BYTES:
                raise ValueError("credential file too large")
            return validated_tokens(json.loads(data.decode("utf-8")))
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def load_configured_tokens(environment):
    file_path = environment.get("ASSIST_GATEWAY_TOKENS_FILE")
    if file_path is not None:
        # A bad file never silently falls back to older process credentials.
        return load_tokens_file(file_path)
    encoded = environment.get("ASSIST_GATEWAY_TOKENS_JSON", "[]").encode("utf-8")
    if len(encoded) > MAX_CREDENTIAL_BYTES:
        raise ValueError("credential configuration too large")
    return validated_tokens(json.loads(encoded))
