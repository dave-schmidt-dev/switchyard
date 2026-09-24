#!/usr/bin/env python3
"""Remove one verified worktree quarantine using directory descriptors.

The caller must first stop and observe every process that could write into the
worktree. This helper checks the quarantine identity and ownership marker, then
walks entries relative to open directory descriptors without following links.
"""

import json
import os
import re
import stat
import sys


QUARANTINE_PARENT = "/private/tmp"
OWNER_MARKER = ".switchyard-cleanup-owner.json"
MAX_INPUT_BYTES = 16_384
MAX_MARKER_BYTES = 4_096
MAX_ENTRIES = 500_000
MAX_DEPTH = 256
PROGRESS_EVERY = 1_000


class RemovalError(Exception):
    """A fail-closed worktree removal error."""


def write_progress(message):
    sys.stderr.write(f"[cleanup] {message}\n")
    sys.stderr.flush()


def parse_marker(encoded):
    def no_duplicate_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise RemovalError("ownership marker contains duplicate keys")
            result[key] = value
        return result

    try:
        return json.loads(encoded.decode("utf-8"), object_pairs_hook=no_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RemovalError("ownership marker is not valid JSON") from error


def read_bounded(fd, limit):
    chunks = []
    remaining = limit + 1
    while remaining:
        chunk = os.read(fd, min(remaining, 1024))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def same_identity(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def open_directory(name, directory_fd=None):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    flags |= getattr(os, "O_CLOEXEC", 0)
    if directory_fd is None:
        return os.open(name, flags)
    return os.open(name, flags, dir_fd=directory_fd)


def validate_payload(payload):
    if not isinstance(payload, dict):
        raise RemovalError("input must be a JSON object")

    required = {
        "quarantinePath",
        "expectedDevice",
        "expectedInode",
        "runId",
        "nonce",
    }
    if set(payload) != required:
        raise RemovalError("input fields do not match the removal contract")

    path = payload["quarantinePath"]
    if (
        not isinstance(path, str)
        or not path.startswith(f"{QUARANTINE_PARENT}/")
        or path.endswith("/")
        or "\x00" in path
        or os.path.dirname(path) != QUARANTINE_PARENT
    ):
        raise RemovalError("quarantinePath must be one direct child of /private/tmp")
    name = os.path.basename(path)
    if name in ("", ".", "..") or os.path.normpath(path) != path:
        raise RemovalError("quarantinePath is not canonical")

    for field in ("expectedDevice", "expectedInode"):
        value = payload[field]
        if not isinstance(value, str) or not re.fullmatch(
            r"(?:0|[1-9][0-9]{0,19})", value
        ):
            raise RemovalError(f"{field} must be an unsigned decimal string")
        value = int(value)
        payload[field] = value
        if value < 0 or value > (1 << 64) - 1:
            raise RemovalError(f"{field} must be an unsigned integer")

    for field in ("runId", "nonce"):
        value = payload[field]
        if (
            not isinstance(value, str)
            or not value
            or len(value) > 256
            or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
        ):
            raise RemovalError(f"{field} must be a non-empty printable string")

    return name


def open_and_validate_marker(root_fd, run_id, nonce):
    flags = os.O_RDONLY | os.O_NOFOLLOW
    flags |= getattr(os, "O_CLOEXEC", 0)
    try:
        marker_fd = os.open(OWNER_MARKER, flags, dir_fd=root_fd)
    except OSError as error:
        raise RemovalError("ownership marker cannot be opened safely") from error

    try:
        marker_stat = os.fstat(marker_fd)
        if not stat.S_ISREG(marker_stat.st_mode):
            raise RemovalError("ownership marker is not a regular file")
        if marker_stat.st_uid != os.geteuid():
            raise RemovalError("ownership marker is not owned by the current user")
        if stat.S_IMODE(marker_stat.st_mode) & ~0o600:
            raise RemovalError("ownership marker permissions are broader than 0600")
        if marker_stat.st_size > MAX_MARKER_BYTES:
            raise RemovalError("ownership marker exceeds the size limit")
        encoded = read_bounded(marker_fd, MAX_MARKER_BYTES)
        if len(encoded) > MAX_MARKER_BYTES:
            raise RemovalError("ownership marker exceeds the size limit")
        marker = parse_marker(encoded)
        if marker != {"runId": run_id, "nonce": nonce}:
            raise RemovalError("ownership marker does not match the requested run")
        return marker_fd, marker_stat
    except Exception:
        os.close(marker_fd)
        raise


def verify_child_identity(parent_fd, name, expected_stat):
    try:
        actual = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as error:
        raise RemovalError("quarantine entry changed during removal") from error
    if not same_identity(actual, expected_stat):
        raise RemovalError("quarantine entry changed during removal")
    return actual


def restore_owner_marker(root_fd, contents):
    """Keep a verified quarantine retryable if its final rmdir fails."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    flags |= getattr(os, "O_CLOEXEC", 0)
    fd = os.open(OWNER_MARKER, flags, 0o600, dir_fd=root_fd)
    try:
        remaining = memoryview(contents)
        while remaining:
            remaining = remaining[os.write(fd, remaining):]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.fsync(root_fd)


class RemovalProgress:
    def __init__(self):
        self.entries = 0

    def ensure_capacity(self):
        if self.entries >= MAX_ENTRIES:
            raise RemovalError("entry limit reached; quarantine retained")

    def removed(self, relative_depth):
        self.entries += 1
        if self.entries % PROGRESS_EVERY == 0:
            write_progress(f"removed {self.entries} entries (depth {relative_depth})")


def remove_contents(
    directory_fd, root_device, progress, depth=0, preserve_owner_marker=False
):
    if depth > MAX_DEPTH:
        raise RemovalError("directory depth limit reached; quarantine retained")

    try:
        names = os.listdir(directory_fd)
    except OSError as error:
        raise RemovalError("cannot list an open quarantine directory") from error

    for name in names:
        if name in ("", ".", "..") or "/" in name or "\x00" in name:
            raise RemovalError("filesystem returned an invalid directory entry")
        if preserve_owner_marker and name == OWNER_MARKER:
            continue

        try:
            entry_stat = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except OSError as error:
            raise RemovalError("quarantine entry changed during removal") from error

        if entry_stat.st_dev != root_device:
            raise RemovalError("nested filesystem found; quarantine retained")

        if stat.S_ISDIR(entry_stat.st_mode):
            try:
                child_fd = open_directory(name, directory_fd)
            except OSError as error:
                raise RemovalError("child directory cannot be opened safely") from error
            try:
                child_stat = os.fstat(child_fd)
                if not same_identity(child_stat, entry_stat):
                    raise RemovalError("child directory changed during removal")
                if child_stat.st_dev != root_device:
                    raise RemovalError("nested filesystem found; quarantine retained")
                remove_contents(child_fd, root_device, progress, depth + 1)
                if os.listdir(child_fd):
                    raise RemovalError("child directory changed during removal")
            finally:
                os.close(child_fd)

            verify_child_identity(directory_fd, name, entry_stat)
            progress.ensure_capacity()
            try:
                os.rmdir(name, dir_fd=directory_fd)
            except OSError as error:
                raise RemovalError("child directory could not be removed safely") from error
            progress.removed(depth)
            continue

        if not (stat.S_ISREG(entry_stat.st_mode) or stat.S_ISLNK(entry_stat.st_mode)):
            raise RemovalError("special filesystem entry found; quarantine retained")

        verify_child_identity(directory_fd, name, entry_stat)
        progress.ensure_capacity()
        try:
            os.unlink(name, dir_fd=directory_fd)
        except OSError as error:
            raise RemovalError("quarantine entry could not be removed safely") from error
        progress.removed(depth)


def remove_verified_quarantine(payload, name):
    parent_fd = open_directory(QUARANTINE_PARENT)
    root_fd = None
    marker_fd = None
    try:
        parent_stat = os.fstat(parent_fd)
        if (
            not stat.S_ISDIR(parent_stat.st_mode)
            or parent_stat.st_uid != 0
            or not (parent_stat.st_mode & stat.S_ISVTX)
        ):
            raise RemovalError("/private/tmp is not a root-owned sticky directory")

        try:
            root_fd = open_directory(name, parent_fd)
        except OSError as error:
            raise RemovalError("quarantine directory cannot be opened safely") from error

        root_stat = os.fstat(root_fd)
        if not stat.S_ISDIR(root_stat.st_mode):
            raise RemovalError("quarantine path is not a directory")
        if root_stat.st_uid != os.geteuid():
            raise RemovalError("quarantine directory is not owned by the current user")
        if root_stat.st_dev != parent_stat.st_dev:
            raise RemovalError("quarantine is on a different filesystem")
        if (
            root_stat.st_dev != payload["expectedDevice"]
            or root_stat.st_ino != payload["expectedInode"]
        ):
            raise RemovalError("quarantine device or inode does not match")

        marker_fd, marker_stat = open_and_validate_marker(
            root_fd, payload["runId"], payload["nonce"]
        )
        progress = RemovalProgress()
        write_progress("identity and ownership marker verified")

        remove_contents(
            root_fd,
            root_stat.st_dev,
            progress,
            preserve_owner_marker=True,
        )

        remaining = os.listdir(root_fd)
        if remaining != [OWNER_MARKER]:
            raise RemovalError("quarantine changed during removal")

        current_marker = os.stat(
            OWNER_MARKER, dir_fd=root_fd, follow_symlinks=False
        )
        if not same_identity(current_marker, marker_stat):
            raise RemovalError("ownership marker changed during removal")
        os.lseek(marker_fd, 0, os.SEEK_SET)
        marker_contents = read_bounded(marker_fd, MAX_MARKER_BYTES)
        if len(marker_contents) > MAX_MARKER_BYTES:
            raise RemovalError("ownership marker changed during removal")
        current_value = parse_marker(marker_contents)
        if current_value != {"runId": payload["runId"], "nonce": payload["nonce"]}:
            raise RemovalError("ownership marker changed during removal")
        verify_child_identity(parent_fd, name, root_stat)

        try:
            os.unlink(OWNER_MARKER, dir_fd=root_fd)
        except OSError as error:
            raise RemovalError("ownership marker could not be removed safely") from error

        try:
            if os.listdir(root_fd):
                raise RemovalError("quarantine changed during final removal")
            verify_child_identity(parent_fd, name, root_stat)
            os.rmdir(name, dir_fd=parent_fd)
        except Exception as error:
            try:
                verify_child_identity(parent_fd, name, root_stat)
                restore_owner_marker(root_fd, marker_contents)
            except Exception as restore_error:
                raise RemovalError(
                    "quarantine final removal failed; ownership marker restoration unavailable"
                ) from restore_error
            raise RemovalError("quarantine directory could not be removed safely") from error

        write_progress(f"removed quarantine ({progress.entries} entries)")
        return progress.entries
    finally:
        if marker_fd is not None:
            os.close(marker_fd)
        if root_fd is not None:
            os.close(root_fd)
        os.close(parent_fd)


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise RemovalError("input exceeds the size limit")
        payload = json.loads(raw.decode("utf-8"))
        name = validate_payload(payload)
        removed = remove_verified_quarantine(payload, name)
        print(json.dumps({"status": "removed", "removedEntries": removed}))
        return 0
    except (RemovalError, OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        message = str(error) or type(error).__name__
        sys.stderr.write(f"[cleanup] refused: {message}\n")
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    sys.exit(main())
