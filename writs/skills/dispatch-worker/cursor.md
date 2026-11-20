## Cursor

**Worktree.** From the project checkout, create it under Cursor's own worktree root, on a branch named for the slice:

```bash
wt=~/.cursor/worktrees/<repo>/worker-<slug>
git worktree add -b worker/<slug> "$wt" <base>
```

**Mint.** From inside `$wt`, run:

```bash
cursor-agent -p --trust --force --output-format stream-json "<brief>" \
  > <project>/artifacts/<date>-<run>.worker-<slug>.jsonl
```

The log goes beside the manifest so steer-worker can read it later, and its path goes in the manifest row too. Give it
as an absolute path into the coordinator's checkout: the command runs inside the worktree, so a relative path would put
the log in the worker's own `git status`. `--trust` skips the prompt a fresh worktree would otherwise raise.

Verified live 2026-11-13 against cursor-agent 2026.10.01: every event line carries `session_id`, so the id is captured
from the first event (`"type": "system"`, `"subtype": "init"`, which also carries `cwd`). `"type": "thinking"` events
arrive too and can be skipped. The worker's reply arrives in `"type": "assistant"` events (`message.content[].text`),
and a finished turn ends with `"type": "result"`, `"subtype": "success"`, whose `result` field holds the whole reply.
When the model is Auto, that text starts with a `> Auto routed to <model>` line before the reply.

When the process exits non-zero, the stream can stop without a `result` line and the error goes to stderr. Treat that as
turn-not-completed and re-dispatch.

**Permissions.** `--force` auto-approves shell commands. Without it, file edits still go through, but every shell
command comes back `"rejected"` in its `tool_call` completed event, and the turn still ends in `result` `success` with
exit 0. A worker without `--force` therefore cannot run the tests or builds its brief names, and nothing in the exit
code says so. Give `--force` to a worker only because its worktree is disposable, never on a host checkout, never for
work that reaches outside the worktree.

**Never-restart line** for the brief's `standing` field:
`never kill a cursor-agent process or reload a Cursor window that hosts a live session`.
