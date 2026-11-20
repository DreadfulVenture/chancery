---
name: Chancery
last_updated: 2026-11-10
---

# Chancery Strategy

## Purpose

Running agent work still takes a human at the console: tasks begin only when the operator opens a workspace and issues
instructions, instead of agents working tickets and collaborating with ideas of their own. The toll taxes every job,
whether the deliverable is code, a research report, or something printed.

## Positioning

The spec is the first operator's actual workflow: the suite is built to serve one operator — user zero — so it can later
serve others. Generalizing is on-strategy only from lived use, never an imagined market; the code stays clean,
open-source work that would not embarrass its author, and the operator's environment lives in configuration, not in the
product.

## Users

**Primary:** the operator, solo — hiring the suite to carry their ideas into code, production, and whatever else the job
requires without their hands on the console. Other operators are the intended audience afterward; they get served by a
product that works, so user zero's loop is where the design authority lives. Its most demanding instance is reflexive:
the suite builds itself, its own backlog worked inside the loop it exists to enable.

## Boundaries

- Shrinking the suite to one work domain (code-shaped tickets only)
- Standing human approval gates where trustworthy checks already carry the call — merging to main included
- Burning tokens on ambiguity instead of diagnosing and routing it (answerable → resolve it; contradiction → resolve
  against guiding principles; taste → escalate)
- Building the steering window here as a standing feature — the window stays outside, consumed over the suite's API,
  though a minimal built-in UI is not banned; shape unresolved
- Designing for hypothetical users before the first operator's loop actually works
- Embedding the first operator's environment — hosts, paths, personal details — into the product rather than
  configuration

_Resist a change when:_ it puts the operator back at the console, adds a human gate the checks already cover, shrinks
the suite to a single domain, bakes in assumptions for users nobody has met yet, or hardcodes its first user's
environment into the code instead of configuration.

## Key metrics

- **Hands-on-console touches** — how many times the operator must steer agents directly to keep work moving; unmeasured
  today, startable from OpenCode session logs
- **Token burn per work item** — spend per completed ticket or PR; live in the LLM gateway's metering
- **Good on first pass** — agent-built work is good on first pass and functions when reached for; qualitative for now,
  judged by the operator in use, worth a measurable proxy (CI failures, review findings) later

## Tracks

### Ticket intake and communications channels

Where work and ideas enter from any domain — tickets, messages, whatever they speak into — and flow back out as status,
questions, and taste calls.

_Why it serves the approach:_ the spec is one operator's life, so intake must speak every language they use.

### The unattended loop

Agents pick up queued work, diagnose ambiguity and route rather than brute-force it, and carry work to done — through
checks to main — without hands.

_Why it serves the approach:_ every loop-extension trades hands-on-console touches and token burn, the two measurable
metrics, for more done.

### Execution surface

Where agents actually work — environments, permissions and security scoping for autonomous systems, tool access, and
capability across domains beyond code.

_Why it serves the approach:_ one operator's whole ticket stream means surfaces that can safely execute anything they
might delegate, not only repositories.

## Brand

**One-liner:** Chancery — where the agents earn their keep.

**Key message:** The dreadfulventure register applies: dry, literary, self-deprecating, in the dry-British-institution
family of names (bedlam, chancery) — a house of able hands with no foreman watching over them.
