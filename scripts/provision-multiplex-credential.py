#!/usr/bin/env python3
"""Safely create or validate one multiplex credential below a user's home."""
import hashlib
import os
import secrets
import stat
import sys


def fail(message: str) -> None:
    raise SystemExit(message)


def open_directory(parent_fd: int, name: str, uid: int, gid: int) -> int:
    try:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
    except FileExistsError:
        pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    metadata = os.fstat(fd)
    if metadata.st_uid != uid or metadata.st_gid != gid:
        os.close(fd)
        fail(f"unsafe credential directory owner: {name}")
    if stat.S_IMODE(metadata.st_mode) != 0o700:
        os.fchmod(fd, 0o700)
    return fd


def main() -> None:
    if len(sys.argv) != 4:
        fail("usage: provision-multiplex-credential.py UID GID HOME")
    uid, gid, home = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    if os.geteuid() not in (0, uid):
        fail("must run as root or the target user")
    metadata = os.lstat(home)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail("home must be a real directory")
    if metadata.st_uid != uid:
        fail("home must be owned by the target user")

    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
    os.umask(0o077)

    home_fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    os.fchmod(home_fd, 0o700)
    config_fd = credential_fd = None
    try:
        config_fd = open_directory(home_fd, ".config", uid, gid)
        credential_fd = open_directory(config_fd, "whatsapp-pi-multiplex", uid, gid)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        try:
            token_fd = os.open("token", flags, 0o600, dir_fd=credential_fd)
        except FileExistsError:
            try:
                token_fd = os.open("token", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=credential_fd)
            except OSError:
                fail("existing credential is not a private regular file")
            existing = os.fstat(token_fd)
            if not stat.S_ISREG(existing.st_mode) or existing.st_uid != uid or existing.st_gid != gid or stat.S_IMODE(existing.st_mode) != 0o600 or existing.st_nlink != 1:
                os.close(token_fd)
                fail("existing credential is not a private, singly-linked regular file")
            token = os.read(token_fd, 4096).strip()
            os.close(token_fd)
        else:
            token = secrets.token_hex(32).encode("ascii")
            os.write(token_fd, token + b"\n")
            os.fsync(token_fd)
            os.close(token_fd)
            os.fsync(credential_fd)
        if len(token) < 32:
            fail("existing credential token is too short; rotate it")
        print(hashlib.sha256(token).hexdigest())
    finally:
        for fd in (credential_fd, config_fd, home_fd):
            if fd is not None:
                os.close(fd)


if __name__ == "__main__":
    main()
