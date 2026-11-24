#!/usr/bin/env python3

import argparse
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path


class SecretOperationError(Exception):
    pass


ASSIGNMENT = re.compile(rb"([A-Za-z_][A-Za-z0-9_]*)=(.*)")


def run_decrypt(secret: Path, identity: Path, stdout: int) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["age", "--decrypt", "--identity", str(identity), str(secret)],
        check=False,
        stderr=subprocess.DEVNULL,
        stdout=stdout,
    )


def decrypt(secret: Path, identity: Path) -> bytes:
    result = run_decrypt(secret, identity, subprocess.PIPE)
    if result.returncode != 0:
        raise SecretOperationError
    return result.stdout


def split_lines(content: bytes) -> list[bytes]:
    # bytes.splitlines also breaks on \x0b, \x0c, \x1c, \x1d, and \x1e, so a
    # value carrying one of those would split into a phantom line; only
    # carriage returns and newlines end a dotenv line.
    lines: list[bytes] = []
    start = 0
    for match in re.finditer(b"\r\n|\r|\n", content):
        lines.append(content[start : match.end()])
        start = match.end()
    if start < len(content):
        lines.append(content[start:])
    return lines


def parse_env(content: bytes) -> dict[str, bytes]:
    assignments: dict[str, bytes] = {}
    for line in split_lines(content):
        value = line.rstrip(b"\r\n")
        if not value or value.startswith(b"#"):
            continue
        match = ASSIGNMENT.fullmatch(value)
        if match is None:
            raise SecretOperationError
        name = match.group(1).decode("ascii")
        if name in assignments:
            raise SecretOperationError
        assignments[name] = match.group(2)
    return assignments


def validate(assignments: dict[str, bytes], required: set[str], forbidden: set[str]) -> None:
    if not required <= assignments.keys() or forbidden & assignments.keys():
        raise SecretOperationError
    if any(not assignments[name] for name in required):
        raise SecretOperationError


def encrypt_replace(content: bytes, secret: Path, recipients: list[str]) -> None:
    fd, temporary_name = tempfile.mkstemp(prefix=f".{secret.name}.", dir=secret.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as destination:
            result = subprocess.run(
                [
                    "age",
                    *[item for recipient in recipients for item in ("--recipient", recipient)],
                ],
                check=False,
                stderr=subprocess.DEVNULL,
                stdout=destination,
                input=content,
            )
        if result.returncode != 0:
            raise SecretOperationError
        # os.replace swaps inodes, and the temp file carries mkstemp's 0600
        # mode; re-apply the original's mode so a re-encrypted secret keeps it.
        os.chmod(temporary, stat.S_IMODE(os.stat(secret).st_mode))
        os.replace(temporary, secret)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def rekey(arguments: argparse.Namespace) -> None:
    encrypt_replace(
        decrypt(arguments.secret, arguments.identity), arguments.secret, arguments.recipient
    )


def edit_env(arguments: argparse.Namespace) -> None:
    content = decrypt(arguments.secret, arguments.identity)
    assignments = parse_env(content)
    dropped = set(arguments.drop)
    if not dropped <= assignments.keys():
        raise SecretOperationError

    output = b"".join(
        line
        for line in split_lines(content)
        if not (match := ASSIGNMENT.fullmatch(line.rstrip(b"\r\n")))
        or match.group(1).decode("ascii") not in dropped
    )
    resulting_assignments = parse_env(output)
    validate(resulting_assignments, set(arguments.require), set(arguments.forbid))
    encrypt_replace(output, arguments.secret, arguments.recipient)


def check_env(arguments: argparse.Namespace) -> None:
    assignments = parse_env(decrypt(arguments.secret, arguments.identity))
    validate(assignments, set(arguments.require), set(arguments.forbid))


def list_keys(arguments: argparse.Namespace) -> None:
    assignments = parse_env(decrypt(arguments.secret, arguments.identity))
    for name, value in assignments.items():
        print(f"{name}={len(value)}")


def can_decrypt(arguments: argparse.Namespace) -> None:
    # The answer is the returncode alone: the decrypted content goes
    # straight to the OS's null device and never enters this process.
    if run_decrypt(arguments.secret, arguments.identity, subprocess.DEVNULL).returncode != 0:
        raise SecretOperationError


def add_secret_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--secret", required=True, type=Path)
    parser.add_argument("--identity", required=True, type=Path)


def add_validation_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--require", action="append", default=[])
    parser.add_argument("--forbid", action="append", default=[])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Rekey and validate dotenv age secrets without outputting plaintext."
    )
    commands = parser.add_subparsers(dest="command", required=True)

    rekey_parser = commands.add_parser("rekey")
    add_secret_arguments(rekey_parser)
    rekey_parser.add_argument("--recipient", action="append", required=True)
    rekey_parser.set_defaults(handler=rekey)

    edit_parser = commands.add_parser("edit-env")
    add_secret_arguments(edit_parser)
    edit_parser.add_argument("--recipient", action="append", required=True)
    edit_parser.add_argument("--drop", action="append", required=True)
    add_validation_arguments(edit_parser)
    edit_parser.set_defaults(handler=edit_env)

    check_parser = commands.add_parser("check-env")
    add_secret_arguments(check_parser)
    add_validation_arguments(check_parser)
    check_parser.set_defaults(handler=check_env)

    list_parser = commands.add_parser(
        "list-keys",
        help="Print each variable name and its value's byte length, in file order.",
    )
    add_secret_arguments(list_parser)
    list_parser.set_defaults(handler=list_keys)

    can_decrypt_parser = commands.add_parser(
        "can-decrypt",
        help="Check that the identity decrypts the secret, discarding any plaintext.",
    )
    add_secret_arguments(can_decrypt_parser)
    can_decrypt_parser.set_defaults(handler=can_decrypt)

    return parser


def main() -> int:
    arguments = build_parser().parse_args()
    try:
        arguments.handler(arguments)
    except (OSError, SecretOperationError):
        print("secret operation failed", file=sys.stderr)
        return 1
    if arguments.command != "list-keys":
        print("valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
