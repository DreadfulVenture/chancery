---
name: humanizer-report
description: >-
  The report mode for the humanizer: load it alongside `humanizer` when the operator wants the results back. Run its
  full process and bring the results back - the assessment, the cited draft, what still reads as AI, the final text -
  and apply only on the operator's go.
---

# The report mode

This lens is loaded alongside `humanizer` when the operator wants the results back: the assessment, what changed with a
citation on each, what still reads as AI, and the final text, applied only on the operator's go. Load `humanizer`, run
its full process through the cited rewrite, then deliver per the report shape below; when the lens is loaded, its report
shape governs delivery. No pattern text lives here; the lens runs the core and adds only this results-back contract.

## Output Format

Provide:

1. The assessment: what fails, and where. If nothing fails, say so and stop here.
2. Draft rewrite, with a citation against each change
3. "What makes the below so obviously AI generated?" (brief bullets, or "nothing")
4. Final rewrite
5. A brief summary of changes made (optional, if helpful)

Then apply on the operator's go. When the text lives in a file, apply the edit (targeted per section, or a full rewrite)
and show the diff, or the changed section when a whole-file diff would hide it.
