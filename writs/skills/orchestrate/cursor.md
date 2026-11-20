## Sessions on Cursor

The operator wakes the coordinator with `cursor-agent --resume <id>`, or by reopening its chat in Cursor. Truth about a
worker comes from its stream log beside the manifest and from the worktree; Cursor has no command that lists or exports
sessions from a script.

Live sessions are hosted by `cursor-agent` processes, and a worker started from a Cursor window's shell is a child of
that window. Never kill such a process, and never reload or quit the window while a worker it started is running.
