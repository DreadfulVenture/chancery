# agenix-secrets

A helper for agent operations around age-encrypted secret files: editing dotenv secrets, adding a recipient without a
repo-wide rekey, checking required and forbidden variables, and listing what a secret carries. SKILL.md teaches usage;
this README states why the tool is shaped the way it is.

## Why it exists

Agents working with secrets have historically stumbled — decrypting a file just to validate it, piping plaintext through
a shell, dumping values into a session transcript. This helper exists so the safe path is the only path an agent needs.

## What the helper guarantees

Plaintext never reaches a pipe, file, or terminal that the caller or any other process can observe — not in argv, not in
a temp file, not as a captured output. `can-decrypt` goes further: the decrypted content never enters the helper's
memory at all, because it pipes straight to the OS's null device and the returncode alone decides. Each operation's
output discipline is the point:

- `check-env` prints only `valid`.
- `list-keys` prints variable names and value lengths only.
- `edit-env` and `rekey` write only a temporary encrypted file and atomically replace the original.
- Every failure prints `secret operation failed` and nothing else.

There is no command in this tool that can print a secret value.

## Who it is for

Agents, as the skill's frontmatter says. A human with the identity on disk can decrypt directly; the helper exists
because the agent path was the one that kept leaking.
