---
name: review-gates
description: >-
  Run a repo's own automated checks over the changed files: compile/typecheck, the tests covering the changed behavior,
  and static analysis where the repo expects it. Discovers what the repo defines — Makefile targets, package scripts —
  and never invents commands. Emits a pass/fail/skipped result per check with real output on failure. `review-work` runs
  it as step 4 and `review-until-clean` between rounds; use it standalone when the user wants the repo checks
  mid-flight.
---

# Review gates

The repo's own machinery, run over the changed files. Not a judgment pass: it runs what the repo defines and reports
what happened. A failing gate is a fact about the branch; reading the failure and fixing it is the caller's work.

## Workflow

```
- [ ] 0. Discover the repo's checks
- [ ] 1. Compile / typecheck
- [ ] 2. Targeted tests
- [ ] 3. Static analysis
- [ ] 4. Report
```

### 0. Discover the repo's checks

Do not invent commands — use what the repo defines: Makefile targets, package scripts, `make semgrep` when the repo
expects it for changed files. Read the Makefile, the package manifest, and any CI config; the repo's own definitions are
the authority on what a gate is. A check the repo does not define is `skipped`, not invented.

### 1. Compile / typecheck

Run the repo's compile and type-check commands when it has them.

### 2. Targeted tests

Run tests covering the changed behavior — the tests that exercise what the diff touched, not necessarily the whole
suite. If none cover the changed behavior, note the gap rather than papering over it; a missing test is a finding the
caller reports, not a reason to run something unrelated and call it coverage.

### 3. Static analysis

Run `make semgrep` (or the repo equivalent) when the repo expects it for changed files.

### 4. Report

One table, real output on failure:

```markdown
## Gates: <branch>

| Check             | Result            |
| ----------------- | ----------------- |
| compile/typecheck | pass/fail/skipped |
| targeted tests    | pass/fail/skipped |
| semgrep           | pass/fail/skipped |
```

A failure carries the command, the exit, and the actual error output — the caller should not need to rerun it to see
what broke. Record each check as pass / fail / skipped even when the run stops early: a compile failure usually makes
the rest pointless, and that reason belongs next to the skips rather than leaving them looking like the repo defines
nothing.

## Does not own

Judging code quality is `review-blind`; tickets and scope are `review-alignment`. A missing test surfaces here as a
noted gap and in the blind pass as a finding — both are in lane, and the caller dedupes.

## Guardrails

- **Repo-defined only.** Never invent a command; discover what the repo runs.
- **No source edits.** Running tests and builds writes artifacts; it never edits code, and it fixes nothing.
- **Real output.** A failure without its error text is not a result.
