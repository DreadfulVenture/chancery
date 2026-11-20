## Resume, the common case

From the worker's worktree directory:
`cursor-agent -p --trust --force --resume <session_id> --output-format stream-json "<next instruction>" >> <log>`, where
`<log>` is the path the manifest row records. Pass `--force` on every turn, for the reason dispatch-worker gives. The
call blocks until the turn ends; read the new lines exactly as dispatch-worker does. Verified live 2026-11-13: the
resumed turn keeps the same `session_id` and the session's earlier context, and a backgrounded resume appends a complete
turn ending in `result`.

## Continue without waiting

When the next instruction should fire without the coordinator standing still, start the same command in the background
(a trailing `&` in a shell, or a shell call that does not block on the result). Cursor has no service to hand a prompt
to and return, so the appended log is the only record of what the turn did. The coordinator does not wait on parked
workers.

## Probe an idle worker

Two sources, in this order:

1. The log: a last line of `"type": "result"` means the turn finished, and its `result` field is the reply. A log with
   no `result` after its process has exited means the turn failed. `pgrep -f "resume <session_id>"` shows whether the
   turn is still running.
2. The worktree: `git log --oneline` and `git status --short` show whether anything landed.

Cursor's `ls` and `resume` subcommands are interactive pickers, so a coordinator cannot list or export sessions from a
script.
