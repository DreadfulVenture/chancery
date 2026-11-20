## Sessions on OpenCode

The operator wakes the coordinator with `opencode run -s <id>`. Truth about a worker comes from the service timeline
(`opencode session list`, `opencode session export <id>`) and the worktree.

The process hosting live sessions is `opencode.service`, together with any other process running a session. Never
restart it.
