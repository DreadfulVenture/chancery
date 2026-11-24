---
name: agenix-secrets
description: Manage agenix secrets — editing, naming, recipient addition without repo-wide rekey, and verification.
license: MIT
metadata:
  audience: agents
  workflow: secrets
---

# Agenix secrets

- Use `agenix` for all new secrets.
- Secret files use `kebab-case.age` naming, stored alongside their service config.
- `secrets.nix` maps `.age` paths to `publicKeys` arrays.
- Re-encrypt existing secrets with `<skill-dir>/bin/age-env-secret`; do not pass plaintext through `agenix -e` in a
  noninteractive shell.
- Adding or rotating a value is a human operation — a human with the identity on disk carries the new plaintext; agents
  validate, list, drop, and rekey.
- **Never** print/cat/echo secrets; validate indirectly (counts, existence).
- When documenting secrets, provide constraints (length, character limits) not generation steps.
- In Nix config, always specify `owner`, `group`, and `mode` (`"0600"` for sensitive secrets).

## Editing an existing dotenv secret

`<skill-dir>/bin/age-env-secret` handles only dotenv-style files containing blank lines, comments, and `NAME=value`
assignments. It holds plaintext only in process memory, writes only a temporary encrypted file, then atomically replaces
the original. The binary ships beside this file, so `<skill-dir>` is the directory holding this SKILL.md; its python
source is the source of truth and lives with the helper's package.

1. Identify the secret's `publicKeys` list in `secrets.nix` and set one `--recipient` flag for each public key. Do not
   derive recipients from the ciphertext header.
2. Identify each required variable from the consuming configuration without decrypting the secret. Pass every one as
   `--require`.
3. Remove variables with one operation. This example drops `OLD_API_KEY` while preserving and checking `DATABASE_URL`:

   ```bash
   <skill-dir>/bin/age-env-secret edit-env \
     --secret services/<secret>.age \
     --identity <identity-file> \
     --recipient age1... \
     --recipient age1... \
     --drop OLD_API_KEY \
     --require DATABASE_URL \
     --forbid OLD_API_KEY
   ```

4. Check an existing dotenv secret without modifying it:

   ```bash
   <skill-dir>/bin/age-env-secret check-env \
     --secret services/<secret>.age \
     --identity <identity-file> \
     --require DATABASE_URL \
     --forbid OLD_API_KEY
   ```

   Success prints only `valid`. Failure does not print variable names or values.

5. List what a dotenv secret carries without touching its values:

   ```bash
   <skill-dir>/bin/age-env-secret list-keys \
     --secret services/<secret>.age \
     --identity <identity-file>
   ```

   This prints one `NAME=<value length>` line per variable, in file order, and nothing else. The length is safe
   metadata: it shows emptiness and lets you check the length constraints the documenting rule above asks for, without
   ever printing a value. Variable names are already public — the consuming configuration references them by name — so
   the listing breaks no discipline, and the helper still never prints values.

## Checking decryptability

`bin/age-env-secret can-decrypt` answers "does my key decrypt this file" for any `.age` file — dotenv or not — replacing
any temptation to decrypt by hand to find out. The decrypted content is never written, never captured, never printed:
the helper pipes it straight to the OS's null device, and the key either unlocks the file (`valid`) or it does not (the
failure message) — nothing else is observable.

```bash
<skill-dir>/bin/age-env-secret can-decrypt \
  --secret services/<secret>.age \
  --identity <identity-file>
```

## Adding a recipient to an existing multi-host secret

Do NOT use `agenix -r` (rekey). From the workstation's identity it can fail partway through the repository, modifying
unrelated files before it reaches the target secret.

1. Add the new host key to that secret's `publicKeys` list in `secrets.nix`.
2. Re-encrypt only the target secret with every resulting recipient:

   ```bash
   <skill-dir>/bin/age-env-secret rekey \
     --secret services/<secret>.age \
     --identity <identity-file> \
     --recipient age1... \
     --recipient 'ssh-ed25519 AAAAC3Nza...'
   ```

3. Confirm `valid` and inspect `git status --short` to ensure only the intended ciphertext and `secrets.nix` changed.

Invocation pitfalls: the built helper carries its own python3 and age on its PATH, so it runs wherever the skill ships;
only the test suite needs age-keygen, and the package's sandboxed check provides it. Recipient values are either
one-word `age1...` keys or two-word `ssh-ed25519 <base64>` pairs — build one `--recipient` flag per key, and pass the
two-word shape as a single quoted argument; unquoted word-splitting sends one-key fragments and fails with a bare
`secret operation failed`. Derive recipients from `secrets.nix` with `nix eval`, not from the ciphertext header.
