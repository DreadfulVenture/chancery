---
name: constraint-reflex
description: "Use when a correction repeats, when writing warnings or comments, when fixing, or proposing automation"
license: MIT
metadata:
  audience: agents
  workflow: correction-design
---

# The constraint reflex

Prose is the weakest place a correction can live. It works only on the agent that reads it, every time, before acting.
The trust pyramid ranks the four rungs a correction can live on, weakest first:

- **Prose.** A warning in a rule file, a skill, or a review comment.
- **Verification.** Running the behavior and looking at the artifact: output, a screenshot, the test results. It catches
  the wrong behavior on the runs that happen, but it says nothing about the next change until someone runs it again.
- **Executable checks.** A lint rule, a type, or a test. The check refuses the change every time it appears, whether or
  not anyone reads it.
- **Codebase design.** An API or a structure that makes the wrong choice unavailable. The agent cannot pick the wrong
  thing, because the code doesn't offer it.

## When a correction repeats across changes

Move the correction to a stronger rung: a prose warning first, if that is where it lives today, then an executable
check, then a design that removes the choice entirely.

The same correction at all three rungs, from a case this repo keeps hitting: an agent pushing without the operator's
word.

- **Prose.** The rule files carry "never push without being asked." The agent that reads it asks first. The agent that
  skips it pushes.
- **Check.** A gate refuses the push the moment the agent attempts it.
- **Design.** The runtime denies `git push` to every agent without an explicit grant. Without the grant, the action
  doesn't exist.

## When about to add a prose instruction warning against a mistake

Ask what check could carry it instead, and write the check when one exists. When none exists yet, state the check that
would carry it. The prose then says what is still judgment and what has moved into tooling.

## When a fix lands

Ask whether the whole class of mistake dies with the fix. If a check or an API change can make the class impossible,
prefer that over the one-off fix: a class that dies mechanically doesn't need a reviewer to rediscover it.

## When about to write a comment justifying a workaround or a known-bad pattern

Stop. That comment is a permission slip for the next instance. It makes the workaround look intentional and doesn't
force anything to change.

The comment surface carries intent, not history: no counts, no excuses, no change narration. A comment earns its place
only when the code cannot say why it does what it does. Even then, rewrite the code so the intent shows first, and write
the comment only when no rewrite can. Show, don't tell.

When the debt is real and stays, keep the code silent about it and track it in a ticket. Point at the real fix instead:
the lint error's suggestion, the API that makes the wrong thing unavailable.

## When reviewing or judging generated work

Evidence before verdicts: run the behavior and look at the artifact (output, a screenshot, the test results), not only
the diff. A diff can be clean and the behavior wrong.

## When proposing automation that repeatedly invokes work

Two loops are in play. The inner loop is the constraints and verification that run on every invocation: checks, test
suites, review gates. The outer loop is the automation that repeatedly invokes that inner work: bots, schedulers,
pipelines, auto-merge flows.

The inner loop comes first. It must be reliable before the outer loop scales it, because automation over an unreliable
inner loop manufactures the same mistakes faster, and more of them.
