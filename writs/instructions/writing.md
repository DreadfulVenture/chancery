# Writing

Context for every agent reading this: this file governs all agent prose.

Every sentence tells a small story: a character does something. Every sentence has two levels. The story level: what
happened (a character, and what it does). The grammar level: how the sentence states it (a subject, and a verb). "A duck
walked up to a lemonade stand and asked, 'Got any grapes?'" shows the alignment:

| Story level (what happened)    | Grammar level (how the sentence states it) |
| ------------------------------ | ------------------------------------------ |
| the duck: who acts             | the subject: "the duck"                    |
| walked up; asked: what it does | the verbs: "walked up", "asked"            |

Alignment (character as subject, action as verb) is a preference, not a law: moving pieces on purpose, to place
emphasis, keeps a sentence clear. AI writing drifts them apart without a purpose, and one of three faults is near:

1. **Hidden characters and actions.** Passive voice erases the actor; a noun built from a verb erases the action. "A
   request for grapes was made upon the duck's arrival at the lemonade stand" taxes the reader twice: past the
   grammatical subject ("request") to find the character, and through the nouns ("arrival") to rebuild two actions the
   writer had on hand: "walked up", "asked". The same fault in two subtler forms. Status verbs hide change: "is now in
   CUDA" hides "recreated in CUDA". Inanimate nouns take an actor's job: "stages will close it" fails because stages
   don't close anything; a person closes it by rebuilding. Agents dodge the first person: "The Triton code is read"
   instead of "I read the Triton code". When the actor is you, name yourself. When the fault is unintentional, fix it:
   character as subject, verbs back on the actions.
2. **Vague wording**, the most common fault in agent output. Humans commit three forms too: ambiguous references,
   stacked nouns, unsuitable word choices. The agent-specific failure is strange word combinations: the model lacks
   common sense for how people normally describe things. "A grape availability request at the beverage retailer" is a
   made-up register; "he asked for grapes at the lemonade stand" is what a person says. The fault hides best where you
   work: "the database readiness check sits at the user-session entry boundary" sounds native in specialist prose. It
   also hides in quantities and coinages. "Same numbers within ±2%": which numbers, the outputs or the runtimes? Name
   the quantity that matched within 2%. "Warm-regime gap", "L2 evict-first hint", "the Triton tactic" name vocabulary
   the writing invented and never explained. Read the sentence aloud and ask whether any person speaking would use those
   words.
3. **Empty statements and misplaced emphasis.** A sentence can be readable word by word and still take over ten seconds
   to process when a skim should be enough: "Nothing else depends on anything but the result, so I'll report as soon as
   the poll returns" means "I'll report when the poll finishes"; write that one, point first. Between paragraphs, the
   same fault: a verdict arriving after its examples. A decision reads as the point only when it stands as the point:
   "so it is out" dangles when the sentence hasn't settled anything yet. Once emphasis is placed right, further cutting
   is taste, not repair.

Surface tells (sentences built around "delve" and its kin, tidy triads, em-dash habits, curly quotes) mark text as
machine-made. A text with no tells can still hide the duck. Clearing tells is the floor; the standard is the first read.
An em dash earns its place only where a sentence needs the turn. A dash habit (dashes doing comma or period work,
several in a paragraph) is the tell: rewrite those with commas, periods, or parentheses. Field separators in structured
lists are markup, not prose; they don't count. Work reports are where agent prose fails hardest, and the shape is
learnable. Below is a real one: an agent's reply in

a coding session, after its operator asked it to read GPU kernel code and reproduce it elsewhere. The Zonder Labs
clarity article (Sources, end of file) annotated it with all three faults (the reply's middle is collapsed in the
article; it is not part of the lesson: the shape and the annotations carry it). Imitate the shape: the answer line, the
state of the work, "What this settles.", the recap of goal, verified-so-far, next step. Do not write the annotated
spans; carry their fixes: name the actor, including yourself; name the quantity; say what a person would say; never coin
vocabulary without explaining it.

> what the operator asked: read the triton sm90a code, make sure we can reproduce it
>
> the reply: Done: the Triton code is read, and the CUDA clone reproduces it. … +33 lines (collapsed in the article)
> Same algorithm, same numbers within ±2%, and the first CUDA-only knobs already buy 3 to 5% on qkv and unpooler M16.
> The one remaining warm-regime gap (o: 12.3 vs 7.9 µs) is purely stage depth, since the 10-stage instantiation exceeds
> this GPU's 101,376-byte limit by 1 KB; 8 or 9 stages will close it. One negative finding: cp.async with an L2
> evict-first hint is harmful on sm_120 (turns warm into cold) and crashed once, so it is out. **What this settles.**
> Nothing was wrong with CUDA. The fat-CTA, TMA, cluster-reduction design was the wrong algorithm for this GPU, and the
> Triton structure (512 to 1024 small CTAs, thread-issued loads, 2 to 3 stages in flight) is now in CUDA with every knob
> exposed. That gives us a controlled vehicle: each change to it can be attributed, locally and then on the H200 where
> this same design (with wgmma swapped in, as Triton does) is the one that produced 1.2347x. Notes are in
> experiments/PLAN.md. Worked for 8m 49s recap: Goal is a faster OKC dense kernel on the H200 (board best is v14 at
> 1.2347x); I just verified the CUDA clone of the Triton tactic reproduces it within 2% locally. Next: tune the clone's
> CUDA-only knobs and lab-check it on the H200.

Everything annotated on that reply, in the annotator's words: span, fault, and the fix it names:

- "the Triton code is read" — hidden characters and actions — "This is an unnecessary use of passive voice. 'I read the
  Triton code' would be clearer."
- "Same algorithm, same numbers within ±2%" — vague wording — "'Same algorithm' describes the code. 'Same numbers' could
  mean the outputs or the runtimes. Name the quantity that matched within 2%."
- "CUDA-only knobs already buy 3 to 5%" — vague wording, hidden characters and actions — "vague and obscure the main
  subject. A clearer way is 'The CUDA implementation already improved 3-5% over the Triton implementation.'"
- "The one remaining warm-regime gap" — vague wording — "'Warm-regime gap' is vague and unexplained."
- "is purely stage depth" — vague wording — "'Is purely a stage depth' is abstract and unexplained."
- "stages will close it" — vague wording — "'Stages' is not commonly used as an animate subject. Saying 'stages will
  close it' is unnatural."
- "L2 evict-first hint" — vague wording — "'L2 evict-first hint' is an unexplained terminology."
- "so it is out" — empty statements and misplaced emphasis — "It is unclear if this is the central point of the sentence
  or a modifier."
- "The fat-CTA, TMA, cluster-reduction design was the wrong algorithm for this GPU" — empty statements and misplaced
  emphasis — "The main action and consequence is delayed behind examples."
- "is now in CUDA with every knob exposed" — hidden characters and actions — "'Is now' hides two actions. A clearer way
  is 'the Triton structure is now recreated in CUDA.'"
- "a controlled vehicle" — vague wording — "'A controlled vehicle' here is unnatural and vague."
- "each change to it can be attributed" — hidden characters and actions — "This phrasing convolutes the action of the
  sentence."
- "where this same design (with wgmma swapped in, as Triton does) is the one that produced 1.2347x" — both faults —
  "Vague and confusing. Can split into a new sentence without passive voice and hidden action."
- "the Triton tactic" — vague wording — "'The Triton tactic' is now a wording we are using that we have not explained."
- "reproduces it within 2% locally" — vague wording — "Unclear sentence and weird verb usage. A better way would be 'I
  just verified that the CUDA reimplementation is within 2% performance of the Triton implementation.'"
- "lab-check" — vague wording — "'Lab-check' is an awkward wording."

On delivery, keep it text only: no assessments, no diffs, no "what I changed" narration. Code in chat only when the code
is the subject. English only. Data goes in tables, reasoning in prose, never a plan as a table. Gap lists: numbered, one
sentence per item. No coined words, no jargon the operator has to decode. Documents the operator owns take the
operator's tone and tense; public copy keeps its voice.

A path the operator is meant to open goes out as the full absolute path: no `~`, no backticks around it, and no
punctuation directly after it. The operator clicks it, and the terminal does not link a path with a period stuck to its
end. Name files you generate with hyphens, not underscores: a renderer reads `_8133_` as italics and drops the
underscores, so the link points at a file that does not exist.

Reports of finished work name the actor and carry one fact per sentence. An enumeration counts as one fact; each new
verb starts a new sentence. The rejected form, from this file's own build session:

> Written: instructions/writing.md, 110 lines, max wrap 120, complete — a context line, the alignment table, the three
> faults, the annotated report and all sixteen annotations, delivery rules, sources. Finding recorded so no future
> session sends writing work to the wrong skill.

What fails in it: no actor appears, and the whole report is one sentence. The set form:

> I wrote instructions/writing.md. It holds a context line explaining what the rule governs, a table showing how the
> story level maps onto the grammar level, the three fault points, the annotated report and all sixteen annotations, one
> paragraph on delivery, and the sources. I recorded why, so no future session sends writing work to the wrong skill.

Same facts; actor named; one claim per sentence.

Sources: the story/grammar alignment and the three faults come from Joseph M. Williams & Joseph Bizup, _Style: The
Basics of Clarity and Grace_, 5th ed., carried by "Why is AI Slop so Frustrating to Read?" (Zonder Labs, 2026-11-09,
zonderlabs.com/slop); the duck, grape, readiness-check, and poll examples are the article's; the annotated report and
all sixteen annotations are the article's; the completion-report pair is this file's own build session.
