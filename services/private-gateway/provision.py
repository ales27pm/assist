"""Create one new device credential file, without displaying its token."""
import argparse
import json
import os
from pathlib import Path
import secrets
import sys

from credentials import open_parent


def provision_file(file_path):
    parent, name = open_parent(file_path, create_private_parent=True, require_private_parent=True)
    descriptor = None
    try:
        # Exclusive creation refuses existing files AND symlinks. There is no
        # update/overwrite mode; adding a device is a separate operator action.
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             0o600, dir_fd=parent)
        os.fchmod(descriptor, 0o600)  # Only our newly created descriptor, never an existing file.
        payload = json.dumps([secrets.token_urlsafe(32)], separators=(",", ":")).encode("ascii") + b"\n"
        remaining = memoryview(payload)
        while remaining:
            written = os.write(descriptor, remaining)
            if written <= 0:
                raise OSError("credential write failed")
            remaining = remaining[written:]
        os.fsync(descriptor)
        os.fsync(parent)
        return Path(file_path)
    except BaseException:
        if descriptor is not None:
            # Remove only the new incomplete inode created by this operation.
            try:
                current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                created = os.fstat(descriptor)
                if (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino):
                    os.unlink(name, dir_fd=parent)
            except OSError:
                pass
        raise
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def main():
    parser = argparse.ArgumentParser(description="Create a new private device-token file without printing the token.")
    parser.add_argument("--file", required=True, help="Explicit absolute destination; refuses existing files.")
    args = parser.parse_args()
    try:
        path = provision_file(args.file)
    except (ValueError, OSError):
        print("Credential provisioning refused; existing data was not overwritten.", file=sys.stderr)
        return 1
    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
