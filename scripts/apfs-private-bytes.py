#!/usr/bin/env python3
"""
scripts/apfs-private-bytes.py - APFS private-byte measurement helper.

Counts private bytes of regular files in specified roots without following symlinks,
using the macOS getattrlist(2) system call with ATTR_CMNEXT_PRIVATESIZE.
"""

import argparse
import ctypes
import json
import os
import stat
import struct
import sys

# macOS getattrlist constants (from <sys/attr.h>)
ATTR_BIT_MAP_COUNT = 5
ATTR_CMNEXT_PRIVATESIZE = 0x00000008

FSOPT_NOFOLLOW = 0x00000001
FSOPT_ATTR_CMN_EXTENDED = 0x00000020


class AttrList(ctypes.Structure):
    _fields_ = [
        ("bitmapcount", ctypes.c_ushort),
        ("reserved", ctypes.c_ushort),
        ("commonattr", ctypes.c_uint32),
        ("volattr", ctypes.c_uint32),
        ("dirattr", ctypes.c_uint32),
        ("fileattr", ctypes.c_uint32),
        ("forkattr", ctypes.c_uint32),
    ]


def init_getattrlist():
    if sys.platform != "darwin":
        return None
    try:
        libc = ctypes.CDLL("/usr/lib/libc.dylib", use_errno=True)
        fn = libc.getattrlist
        fn.argtypes = [
            ctypes.c_char_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.c_ulong,
        ]
        fn.restype = ctypes.c_int
        return fn
    except Exception:
        return None


def get_file_private_size(getattrlist_fn, file_path):
    alist = AttrList()
    alist.bitmapcount = ATTR_BIT_MAP_COUNT
    alist.reserved = 0
    alist.commonattr = 0
    alist.volattr = 0
    alist.dirattr = 0
    alist.fileattr = 0
    alist.forkattr = ATTR_CMNEXT_PRIVATESIZE

    buf = ctypes.create_string_buffer(64)
    options = FSOPT_ATTR_CMN_EXTENDED | FSOPT_NOFOLLOW

    try:
        encoded = os.fsencode(file_path)
    except Exception:
        return None, -1

    ret = getattrlist_fn(
        encoded,
        ctypes.byref(alist),
        buf,
        ctypes.sizeof(buf),
        options,
    )
    if ret != 0:
        err = ctypes.get_errno()
        return None, err

    length = struct.unpack_from("<I", buf.raw, 0)[0]
    # One requested 64-bit fork attribute follows the four-byte result length.
    # An unfamiliar layout must not be guessed from padded bytes.
    if length != 12:
        return None, -1
    val = struct.unpack_from("<q", buf.raw, 4)[0]

    if val < 0:
        return None, -1
    return val, 0


def measure_single_root(getattrlist_fn, root_path, max_files_remaining):
    try:
        st = os.lstat(root_path)
    except Exception:
        return {
            "measurable": False,
            "bytes": None,
            "fileCount": 0,
            "unavailableReason": "inaccessible",
        }, 0

    # Symlink refusal: never measure symlink roots
    if stat.S_ISLNK(st.st_mode):
        return {
            "measurable": False,
            "bytes": None,
            "fileCount": 0,
            "unavailableReason": "symlink_refused",
        }, 0

    # Regular file root
    if stat.S_ISREG(st.st_mode):
        if max_files_remaining <= 0:
            return {
                "measurable": False,
                "bytes": None,
                "fileCount": 0,
                "unavailableReason": "file_count_exceeded",
            }, 0
        size, err = get_file_private_size(getattrlist_fn, root_path)
        if size is None:
            return {
                "measurable": False,
                "bytes": None,
                "fileCount": 0,
                "unavailableReason": "private_bytes_unavailable",
            }, 1
        return {
            "measurable": True,
            "bytes": size,
            "fileCount": 1,
            "unavailableReason": None,
        }, 1

    if not stat.S_ISDIR(st.st_mode):
        return {
            "measurable": False,
            "bytes": None,
            "fileCount": 0,
            "unavailableReason": "unsupported_type",
        }, 0

    # Directory root: walk regular files without following symlinks
    stack = [root_path]
    visited_dirs = {(st.st_dev, st.st_ino)}
    total_bytes = 0
    total_files = 0
    failed = False
    fail_reason = None

    while stack:
        current_dir = stack.pop()
        try:
            with os.scandir(current_dir) as it:
                for entry in it:
                    try:
                        # Refuse to follow symlinks:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            try:
                                dstat = entry.stat(follow_symlinks=False)
                                did = (dstat.st_dev, dstat.st_ino)
                                if did not in visited_dirs:
                                    visited_dirs.add(did)
                                    stack.append(entry.path)
                            except Exception:
                                failed = True
                                fail_reason = "inaccessible"
                                break
                        elif entry.is_file(follow_symlinks=False):
                            total_files += 1
                            if total_files > max_files_remaining:
                                failed = True
                                fail_reason = "file_count_exceeded"
                                break
                            size, err = get_file_private_size(getattrlist_fn, entry.path)
                            if size is None:
                                failed = True
                                fail_reason = "private_bytes_unavailable"
                                break
                            total_bytes += size
                            if total_files % 100 == 0:
                                sys.stderr.write(
                                    f"[gc] {os.path.basename(root_path)}: measured {total_files} files...\n"
                                )
                                sys.stderr.flush()
                    except Exception:
                        failed = True
                        fail_reason = "inaccessible"
                        break
        except Exception:
            failed = True
            fail_reason = "inaccessible"
            break
        if failed:
            break

    if failed:
        return {
            "measurable": False,
            "bytes": None,
            "fileCount": total_files,
            "unavailableReason": fail_reason,
        }, total_files

    return {
        "measurable": True,
        "bytes": total_bytes,
        "fileCount": total_files,
        "unavailableReason": None,
    }, total_files


def main():
    parser = argparse.ArgumentParser(
        description="Bounded APFS private-byte measurement helper."
    )
    parser.add_argument(
        "--max-files",
        type=int,
        default=100_000,
        help="Maximum total files to inspect across whole inventory.",
    )
    parser.add_argument(
        "--stdin",
        action="store_true",
        help="Read root paths from stdin as a JSON array.",
    )
    parser.add_argument(
        "paths",
        nargs="*",
        help="Root paths to measure.",
    )
    args = parser.parse_args()

    paths = list(args.paths)
    if args.stdin:
        try:
            parsed = json.loads(sys.stdin.read())
            if not isinstance(parsed, list) or not all(
                isinstance(path, str) and path for path in parsed
            ):
                raise ValueError("invalid root list")
            paths.extend(parsed)
        except (ValueError, json.JSONDecodeError):
            sys.stderr.write("[gc] Invalid root list on stdin\n")
            sys.stderr.flush()
            return 2

    if not paths:
        print(json.dumps({"status": "ok", "roots": {}, "totalFiles": 0, "totalBytes": 0}))
        return 0

    getattrlist_fn = init_getattrlist()
    if getattrlist_fn is None:
        sys.stderr.write("[gc] APFS private bytes unsupported on this platform or kernel\n")
        sys.stderr.flush()
        roots_out = {
            p: {
                "measurable": False,
                "bytes": None,
                "fileCount": 0,
                "unavailableReason": "private_bytes_unavailable",
            }
            for p in paths
        }
        print(json.dumps({"status": "unsupported", "roots": roots_out, "totalFiles": 0, "totalBytes": None}))
        return 0

    roots_out = {}
    max_files = args.max_files
    files_remaining = max_files
    total_measured_files = 0
    total_measured_bytes = 0
    all_complete = True

    sys.stderr.write(f"[gc] Measuring APFS private bytes for {len(paths)} candidate roots\n")
    sys.stderr.flush()

    for i, path in enumerate(paths, 1):
        name = os.path.basename(path) or path
        sys.stderr.write(f"[gc] [{i}/{len(paths)}] Measuring {name}...\n")
        sys.stderr.flush()

        result, file_count = measure_single_root(getattrlist_fn, path, files_remaining)
        files_remaining -= file_count
        roots_out[path] = result

        if result["measurable"] and isinstance(result["bytes"], int):
            total_measured_files += result["fileCount"]
            total_measured_bytes += result["bytes"]
            sys.stderr.write(
                f"[gc] [{i}/{len(paths)}] {name}: {result['bytes']} private bytes ({result['fileCount']} files)\n"
            )
        else:
            all_complete = False
            sys.stderr.write(
                f"[gc] [{i}/{len(paths)}] {name}: unavailable ({result['unavailableReason']})\n"
            )
        sys.stderr.flush()

    sys.stderr.write(
        f"[gc] Finished measurement: {len(paths)} roots inspected, {total_measured_files} files, {total_measured_bytes} bytes\n"
    )
    sys.stderr.flush()

    output = {
        "status": "ok",
        "roots": roots_out,
        "totalFiles": total_measured_files,
        "totalBytes": total_measured_bytes if all_complete else None,
    }
    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
