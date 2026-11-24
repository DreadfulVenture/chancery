import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


HELPER = Path(__file__).parents[1] / "bin" / "age-env-secret"


class AgeEnvSecretTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name)
        self.identity, self.recipient = self.create_identity("first")
        self.secret = self.path / "secret.age"

    def tearDown(self) -> None:
        self.directory.cleanup()

    def create_identity(self, name: str) -> tuple[Path, str]:
        identity = self.path / f"{name}.key"
        output = subprocess.run(
            ["age-keygen", "--output", str(identity)],
            check=True,
            capture_output=True,
            text=True,
        ).stderr
        return identity, re.search(r"age1[\w]+", output).group(0)

    def encrypt(self, plaintext: bytes, recipient: str | None = None) -> None:
        with self.secret.open("wb") as destination:
            subprocess.run(
                ["age", "--recipient", recipient or self.recipient],
                check=True,
                input=plaintext,
                stdout=destination,
            )

    def decrypt(self, identity: Path | None = None) -> bytes:
        return subprocess.run(
            ["age", "--decrypt", "--identity", str(identity or self.identity), str(self.secret)],
            check=True,
            capture_output=True,
        ).stdout

    def helper(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(HELPER), *arguments],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_edit_removes_only_requested_entry(self) -> None:
        self.encrypt(b"DATABASE_URL=test-database-value\nSYNTHETIC_API_KEY=test-synthetic-value\n")

        result = self.helper(
            "edit-env",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
            "--recipient",
            self.recipient,
            "--drop",
            "SYNTHETIC_API_KEY",
            "--require",
            "DATABASE_URL",
            "--forbid",
            "SYNTHETIC_API_KEY",
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "valid\n")
        self.assertNotIn("test-database-value", result.stdout + result.stderr)
        self.assertNotIn("test-synthetic-value", result.stdout + result.stderr)
        self.assertEqual(self.decrypt(), b"DATABASE_URL=test-database-value\n")

    def test_check_rejects_empty_required_entry_without_outputting_values(self) -> None:
        self.encrypt(b"DATABASE_URL=\n")

        result = self.helper(
            "check-env",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
            "--require",
            "DATABASE_URL",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("DATABASE_URL", result.stdout + result.stderr)

    def test_check_rejects_absent_required_entry(self) -> None:
        self.encrypt(b"DATABASE_URL=test-database-value\n")

        result = self.helper(
            "check-env",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
            "--require",
            "API_TOKEN",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("test-database-value", result.stdout + result.stderr)

    def test_check_rejects_forbidden_entry(self) -> None:
        self.encrypt(b"DATABASE_URL=test-database-value\nSYNTHETIC_API_KEY=test-synthetic-value\n")

        result = self.helper(
            "check-env",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
            "--require",
            "DATABASE_URL",
            "--forbid",
            "SYNTHETIC_API_KEY",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("test-database-value", result.stdout + result.stderr)
        self.assertNotIn("test-synthetic-value", result.stdout + result.stderr)

    def test_rekey_replaces_recipients(self) -> None:
        second_identity, second_recipient = self.create_identity("second")
        self.encrypt(b"DATABASE_URL=test-database-value\n")

        result = self.helper(
            "rekey",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
            "--recipient",
            second_recipient,
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "valid\n")
        self.assertEqual(self.decrypt(second_identity), b"DATABASE_URL=test-database-value\n")
        self.assertNotEqual(
            subprocess.run(
                ["age", "--decrypt", "--identity", str(self.identity), str(self.secret)],
                capture_output=True,
                check=False,
            ).returncode,
            0,
        )

    def test_list_keys_prints_names_and_value_lengths_in_file_order(self) -> None:
        self.encrypt(b"SYNTHETIC_API_KEY=test-synthetic-value\nDATABASE_URL=test-database-value\n")

        result = self.helper(
            "list-keys",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "SYNTHETIC_API_KEY=20\nDATABASE_URL=19\n")
        self.assertNotIn("test-database-value", result.stdout + result.stderr)
        self.assertNotIn("test-synthetic-value", result.stdout + result.stderr)

    def test_list_keys_prints_zero_for_an_empty_value(self) -> None:
        self.encrypt(b"DATABASE_URL=\n")

        result = self.helper(
            "list-keys",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "DATABASE_URL=0\n")

    def test_list_keys_reports_an_absent_secret_through_the_catch_all(self) -> None:
        result = self.helper(
            "list-keys",
            "--secret",
            str(self.path / "absent.age"),
            "--identity",
            str(self.identity),
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "secret operation failed\n")

    def test_list_keys_reports_an_undecryptable_secret_through_the_catch_all(self) -> None:
        wrong_identity, _ = self.create_identity("wrong")
        self.encrypt(b"DATABASE_URL=test-database-value\n")

        result = self.helper(
            "list-keys",
            "--secret",
            str(self.secret),
            "--identity",
            str(wrong_identity),
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("test-database-value", result.stdout + result.stderr)
        self.assertNotIn("DATABASE_URL", result.stdout + result.stderr)

    def test_can_decrypt_validates_with_the_right_identity_without_outputting_values(self) -> None:
        self.encrypt(b"DATABASE_URL=DECRYPT_CANARY_MARKER\n")

        result = self.helper(
            "can-decrypt",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "valid\n")
        self.assertNotIn("DECRYPT_CANARY_MARKER", result.stdout + result.stderr)

    def test_can_decrypt_reports_an_unrelated_identity_through_the_catch_all(self) -> None:
        unrelated_identity, _ = self.create_identity("unrelated")
        self.encrypt(b"DATABASE_URL=DECRYPT_CANARY_MARKER\n")

        result = self.helper(
            "can-decrypt",
            "--secret",
            str(self.secret),
            "--identity",
            str(unrelated_identity),
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "secret operation failed\n")
        self.assertNotIn("DECRYPT_CANARY_MARKER", result.stdout + result.stderr)

    def test_can_decrypt_accepts_content_that_is_not_dotenv(self) -> None:
        self.encrypt(bytes(range(1, 256)))

        result = self.helper(
            "can-decrypt",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "valid\n")

    def test_rekey_accepts_a_two_word_ssh_ed25519_recipient(self) -> None:
        ssh_identity = self.path / "ssh-identity"
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-q", "-f", str(ssh_identity)],
            check=True,
            capture_output=True,
        )
        public_key = subprocess.run(
            ["ssh-keygen", "-y", "-f", str(ssh_identity)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        recipient = "ssh-ed25519 " + public_key.split()[1]

        self.encrypt(b"DATABASE_URL=test-database-value\n", recipient=recipient)

        result = self.helper(
            "rekey",
            "--secret",
            str(self.secret),
            "--identity",
            str(ssh_identity),
            "--recipient",
            self.recipient,
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "valid\n")
        self.assertEqual(self.decrypt(), b"DATABASE_URL=test-database-value\n")

    def test_edit_env_preserves_the_secret_file_mode(self) -> None:
        self.encrypt(b"DATABASE_URL=test-database-value\nOLD_API_KEY=x\n")
        os.chmod(self.secret, 0o644)

        result = self.helper(
            "edit-env",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
            "--recipient",
            self.recipient,
            "--drop",
            "OLD_API_KEY",
            "--require",
            "DATABASE_URL",
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(stat.S_IMODE(os.stat(self.secret).st_mode), 0o644)
        self.assertEqual(self.decrypt(), b"DATABASE_URL=test-database-value\n")

    def test_edit_env_preserves_comments_and_blank_lines_byte_for_byte(self) -> None:
        self.encrypt(b"# header\n\nDATABASE_URL=test-database-value\n\n# footer\nOLD_API_KEY=x\n")

        result = self.helper(
            "edit-env",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
            "--recipient",
            self.recipient,
            "--drop",
            "OLD_API_KEY",
            "--require",
            "DATABASE_URL",
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            self.decrypt(), b"# header\n\nDATABASE_URL=test-database-value\n\n# footer\n"
        )

    def test_edit_env_preserves_crlf_line_endings(self) -> None:
        self.encrypt(b"DATABASE_URL=test-database-value\r\nOLD_API_KEY=x\r\n")

        result = self.helper(
            "edit-env",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
            "--recipient",
            self.recipient,
            "--drop",
            "OLD_API_KEY",
            "--require",
            "DATABASE_URL",
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.decrypt(), b"DATABASE_URL=test-database-value\r\n")

    def test_edit_env_rejects_dropping_an_absent_key(self) -> None:
        self.encrypt(b"DATABASE_URL=test-database-value\n")

        result = self.helper(
            "edit-env",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
            "--recipient",
            self.recipient,
            "--drop",
            "ABSENT_KEY",
            "--require",
            "DATABASE_URL",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "secret operation failed\n")
        self.assertEqual(self.decrypt(), b"DATABASE_URL=test-database-value\n")

    def test_list_keys_keeps_a_value_carrying_a_control_byte_intact(self) -> None:
        # bytes.splitlines breaks on \x0b too, so this fixture would have
        # parsed "va" and a phantom "BKEY=1" line; the shared splitter must
        # keep the value whole and the length exact.
        self.encrypt(b"DATABASE_URL=va\x0bBKEY=1\n")

        result = self.helper(
            "list-keys",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "DATABASE_URL=9\n")

    def test_edit_env_never_rewrites_on_a_phantom_name(self) -> None:
        content = b"DATABASE_URL=va\x0bBKEY=1\n"
        self.encrypt(content)

        result = self.helper(
            "edit-env",
            "--secret",
            str(self.secret),
            "--identity",
            str(self.identity),
            "--recipient",
            self.recipient,
            "--drop",
            "BKEY",
            "--require",
            "DATABASE_URL",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "secret operation failed\n")
        self.assertEqual(self.decrypt(), content)

    def test_the_helper_carries_its_own_age(self) -> None:
        self.encrypt(b"DATABASE_URL=test-database-value\n")

        result = subprocess.run(
            [
                str(HELPER),
                "list-keys",
                "--secret",
                str(self.secret),
                "--identity",
                str(self.identity),
            ],
            capture_output=True,
            text=True,
            check=False,
            env={"PATH": "/nonexistent"},
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "DATABASE_URL=19\n")


if __name__ == "__main__":
    unittest.main()
