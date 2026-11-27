---
name: write-pr-description
description: Instructions for writing PR descriptions, use when editing or creating a PR body
---

# Write PR description

## Context

Many repos squash-merge, so the PR body becomes the commit message on main. Write it for that record, like a good commit
message: what the change does and WHY it is right.

## The form

A short description of what the change does (present tense, plain words), the why (the design reasoning a reviewer
needs, stated as fact), and the ticket link in magic-word form (Fixes PRJ-###) when a ticket exists. Agent-authored
descriptions carry the Agent-generated prefix per comms standards. The body does not describe gates or test outcomes by
default — CI speaks for itself. Include the verification line (what was run) only when the operator asks or a separate
skill or instruction requires it.

## Never in a PR body

Branch-history narration (first/then/rebased/dropped-scope sections), commit-by-commit walkthroughs (squash means those
shas never exist on main), operator-directed steps or who-owes-what-click lines, private-system detail (host names,
customers, private paths — PR bodies are history and some repos mirror publicly). Disposition calls and dropped-scope
notes live in the ticket, not the body.

## Length

Short. If the body needs a "dropped from this slice" section, the scope does not belong in this PR.
