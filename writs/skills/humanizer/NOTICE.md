# humanizer - attribution and provenance

Operative file: SKILL.md (this notice is provenance; agents need not read it).

This skill is ported from [blader/humanizer](https://github.com/blader/humanizer) (MIT licensed), which is itself based
on [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), maintained by
WikiProject AI Cleanup. The patterns documented there come from observations of thousands of instances of AI-generated
text on Wikipedia.

Original author: Siqi Chen ([@blader](https://github.com/blader)). Original repo: https://github.com/blader/humanizer
(version 2.5.1). The patterns, personality/soul section, and full worked example are preserved verbatim from the source,
except as noted below. The Hermes Agent port's tool references in the "How to use it" and "Process" sections are gone,
since the skill runs on hosts that name those tools differently. MIT license preserved.

Key insight from Wikipedia: "LLMs use statistical algorithms to guess what should come next. The result tends toward the
most statistically likely result that applies to the widest variety of cases."

## Local divergence from upstream

The process assesses the text against the patterns and the checklist before changing anything, stops there when nothing
fails, and requires each edit to cite what it fixes. CLAIM PRESERVATION is new. Upstream's pattern 17, Title Case in
Headings, is dropped and the ones after it renumbered. Pattern 29, False Actors, is new. Pattern 30, Clause Density, is
new (2026-11-20, from the operator's observation that a passage can clear every rule and still not be something a person
would write): it is the first-read standard's enforcement arm, and process step 2 leans on it before any clean verdict.
Pattern 13 gains the boundary between fragments that hide an actor and fragments that are merely short, and its
Before/After pair is replaced, since upstream's "No configuration file needed" is the second kind. Pattern 13 also gains
the "Worth Xing" recommendation and its before/after. The checklist and PERSONALITY AND SOUL are unchanged. The base
writing guidelines section is local: the skill anchors its standard to the house writing source (the writing.md shipped
beside the skill), assesses its three faults in the process, and carries its work-report shape.
