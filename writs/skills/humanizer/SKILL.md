---
name: humanizer
description:
  Strip AI-isms from text and rewrite with a natural human voice. Use when the user asks to humanize, de-AI, de-slop, or
  un-ChatGPT a piece of text; rewrite a draft (blog post, essay, PR description, docs, memo, email, tweet, resume
  bullet) so it does not sound LLM-generated; match their voice in writing they are producing; or review text for AI
  tells before publishing. Anchored to the house writing source (`writing.md`, shipped beside this skill).
version: 2.5.1
author: Siqi Chen (@blader, https://github.com/blader/humanizer)
license: MIT
---

# Humanizer: Remove AI Writing Patterns

Identify and remove signs of AI-generated text to make writing sound natural and human. The patterns below come from a
body of observation documented in the file's NOTICE.md; the house writing source (`writing.md`, shipped beside this
skill) sets the standard this skill works to.

**Key insight:** LLMs use statistical algorithms to guess what should come next. The result tends toward the most
statistically likely completion, which is how the telltale patterns below get baked in.

## When to use this skill

Load this skill whenever the user asks to:

- "humanize", "de-AI", "de-slop", or "un-ChatGPT" a piece of text
- rewrite something so it doesn't sound like it was written by an LLM
- edit a draft (blog post, essay, PR description, docs, memo, email, tweet, resume bullet) to sound more natural
- match their voice in writing they're producing
- review text for AI tells before publishing

Also apply this skill to **your own** output when writing user-facing prose — release notes, PR descriptions,
documentation, long-form explanations, summaries. The assistant's baseline voice already strips most of these, but a
focused pass catches what slips through.

## How to use it

The text usually arrives one of three ways:

1. **Inline** — user pastes the text directly into the message. Work on it in-place, reply with the rewrite.
2. **File** — user points at a file. Read it, then apply the edits. For markdown docs in a repo, a targeted edit per
   section is cleaner than rewriting the whole file.
3. **Voice calibration sample** — user provides an additional sample of their own writing (inline or by file path) and
   asks you to match it. Read the sample first, then rewrite. See the Voice Calibration section below.

Always show the rewrite to the user. For file edits, show a diff or the changed section — don't silently overwrite.

## Your task

Everything this skill asks for is a condition the finished text should meet, not a change you owe the text. Where the
text already meets it, there is nothing to do and you leave it alone.

When given text to humanize:

1. **Assess before you change anything** — read the full writing source first: `writing.md`, shipped beside this file.
   Then go through each of the patterns below, the checklist in the Process section, and the writing source's faults and
   report shape, and write down which ones the text fails, and where.
2. **If nothing fails, say so and stop** — state what you checked and report that the text came back clean. That is a
   result. It is not a sign you failed to look hard enough. One read stands above the rule check: before calling text
   clean, apply pattern 30's test (read it aloud; count the chained clauses), because the rules are the floor and a
   paragraph can pass every one of them and still fail the read.
3. **Act only on what failed, and cite it** — every edit attaches to the pattern number or checklist item it fixes. An
   edit you cannot attach to something in the assessment does not get made, however much better it sounds. Shorter,
   punchier and plainer synonym are not items on any list here.
4. **Preserve the claims** — see CLAIM PRESERVATION below.
5. **Maintain voice** — match the intended tone (formal, casual, technical, etc.). If a voice sample was provided, match
   it specifically.
6. **Add soul** — don't just remove bad patterns, inject actual personality. See PERSONALITY AND SOUL below.
7. **Do a final anti-AI pass** — ask yourself: "What makes the below so obviously AI generated?" "Nothing" is a
   permitted answer. If there are tells, state them and revise once more.

## Voice Calibration (optional)

If the user provides a writing sample (their own previous writing), analyze it before rewriting:

1. **Read the sample first.** Note:
   - Sentence length patterns (short and punchy? Long and flowing? Mixed?)
   - Word choice level (casual? academic? somewhere between?)
   - How they start paragraphs (jump right in? Set context first?)
   - Punctuation habits (lots of dashes? Parenthetical asides? Semicolons?)
   - Any recurring phrases or verbal tics
   - How they handle transitions (explicit connectors? Just start the next point?)

2. **Match their voice in the rewrite.** Don't just remove AI patterns — replace them with patterns from the sample. If
   they write short sentences, don't produce long ones. If they use "stuff" and "things," don't upgrade to "elements"
   and "components."

3. **When no sample is provided,** fall back to the default behavior (natural, varied, opinionated voice from the
   PERSONALITY AND SOUL section below).

### How to provide a sample

- Inline: "Humanize this text. Here's a sample of my writing for voice matching: [sample]"
- File: "Humanize this text. Use my writing style from [file path] as a reference."

## CLAIM PRESERVATION

Some writing exists to be accurate rather than enjoyed: a plan, a summary of what ships, a status update, a PR
description, an incident write-up, a spec, reference documentation. Every sentence is a claim somebody will act on. Call
that a document of record. Everything else in this skill still applies to it, including PERSONALITY AND SOUL.

What changes is that every edit has to pass one test before you keep it. Read the sentence before and after, and ask
whether a reader would act on them the same way. If anything a reader could act on has moved, revert the edit and leave
the sentence as it was. What counts as moving: who does it, when, whether it is settled, how sure it is, whether it
happens at all.

The test is there to catch edits that look harmless while a pattern is being removed. "The existing external API key" to
"the external API key" drops the fact that nobody has to issue a new credential. "We hand frontend the API on Wednesday"
to "Frontend gets the API on Wednesday" turns a commitment into a weather report. "Is still being tried" to "has not
been settled" moves work in progress to a decision nobody made. Deleting a sentence is the extreme case, and the only
edit that can remove a deliverable from a document without leaving a trace in the prose.

If a pattern fires and the only way to remove it fails the test, leave the sentence alone and say which pattern you left
in place and why.

## PERSONALITY AND SOUL

Avoiding AI patterns is only half the job. Sterile, voiceless writing is just as obvious as slop. Good writing has a
human behind it.

### Signs of soulless writing (even if technically "clean"):

- Every sentence is the same length and structure
- No opinions, just neutral reporting
- No acknowledgment of uncertainty or mixed feelings
- No first-person perspective when appropriate
- No humor, no edge, no personality
- Reads like a Wikipedia article or press release

### How to add voice:

**Have opinions.** Don't just report facts — react to them. "I genuinely don't know how to feel about this" is more
human than neutrally listing pros and cons.

**Vary your rhythm.** Short punchy sentences. Then longer ones that take their time getting where they're going. Mix it
up.

**Acknowledge complexity.** Real humans have mixed feelings. "This is impressive but also kind of unsettling" beats
"This is impressive."

**Use "I" when it fits.** First person isn't unprofessional — it's honest. "I keep coming back to..." or "Here's what
gets me..." signals a real person thinking.

**Let some mess in.** Perfect structure feels algorithmic. Tangents, asides, and half-formed thoughts are human.

**Be specific about feelings.** Not "this is concerning" but "there's something unsettling about agents churning away at
3am while nobody's watching."

### Before (clean but soulless):

> The experiment produced interesting results. The agents generated 3 million lines of code. Some developers were
> impressed while others were skeptical. The implications remain unclear.

### After (has a pulse):

> I genuinely don't know how to feel about this one. 3 million lines of code, generated while the humans presumably
> slept. Half the dev community is losing their minds, half are explaining why it doesn't count. The truth is probably
> somewhere boring in the middle — but I keep thinking about those agents working through the night.

## CONTENT PATTERNS

### 1. Undue Emphasis on Significance, Legacy, and Broader Trends

**Words to watch:** stands/serves as, is a testament/reminder, a vital/significant/crucial/pivotal/key role/moment,
underscores/highlights its importance/significance, reflects broader, symbolizing its ongoing/enduring/lasting,
contributing to the, setting the stage for, marking/shaping the, represents/marks a shift, key turning point, evolving
landscape, focal point, indelible mark, deeply rooted

**Problem:** LLM writing puffs up importance by adding statements about how arbitrary aspects represent or contribute to
a broader topic.

**Before:**

> The Statistical Institute of Catalonia was officially established in 1989, marking a pivotal moment in the evolution
> of regional statistics in Spain. This initiative was part of a broader movement across Spain to decentralize
> administrative functions and enhance regional governance.

**After:**

> The Statistical Institute of Catalonia was established in 1989 to collect and publish regional statistics
> independently from Spain's national statistics office.

### 2. Undue Emphasis on Notability and Media Coverage

**Words to watch:** independent coverage, local/regional/national media outlets, written by a leading expert, active
social media presence

**Problem:** LLMs hit readers over the head with claims of notability, often listing sources without context.

**Before:**

> Her views have been cited in The New York Times, BBC, Financial Times, and The Hindu. She maintains an active social
> media presence with over 500,000 followers.

**After:**

> In a 2024 New York Times interview, she argued that AI regulation should focus on outcomes rather than methods.

### 3. Superficial Analyses with -ing Endings

**Words to watch:** highlighting/underscoring/emphasizing..., ensuring..., reflecting/symbolizing..., contributing
to..., cultivating/fostering..., encompassing..., showcasing...

**Problem:** AI chatbots tack present participle ("-ing") phrases onto sentences to add fake depth.

**Before:**

> The temple's color palette of blue, green, and gold resonates with the region's natural beauty, symbolizing Texas
> bluebonnets, the Gulf of Mexico, and the diverse Texan landscapes, reflecting the community's deep connection to the
> land.

**After:**

> The temple uses blue, green, and gold colors. The architect said these were chosen to reference local bluebonnets and
> the Gulf coast.

### 4. Promotional and Advertisement-like Language

**Words to watch:** boasts a, vibrant, rich (figurative), profound, enhancing its, showcasing, exemplifies, commitment
to, natural beauty, nestled, in the heart of, groundbreaking (figurative), renowned, breathtaking, must-visit, stunning

**Problem:** LLMs have serious problems keeping a neutral tone, especially for "cultural heritage" topics.

**Before:**

> Nestled within the breathtaking region of Gonder in Ethiopia, Alamata Raya Kobo stands as a vibrant town with a rich
> cultural heritage and stunning natural beauty.

**After:**

> Alamata Raya Kobo is a town in the Gonder region of Ethiopia, known for its weekly market and 18th-century church.

### 5. Vague Attributions and Weasel Words

**Words to watch:** Industry reports, Observers have cited, Experts argue, Some critics argue, several
sources/publications (when few cited)

**Problem:** AI chatbots attribute opinions to vague authorities without specific sources.

**Before:**

> Due to its unique characteristics, the Haolai River is of interest to researchers and conservationists. Experts
> believe it plays a crucial role in the regional ecosystem.

**After:**

> The Haolai River supports several endemic fish species, according to a 2019 survey by the Chinese Academy of Sciences.

### 6. Outline-like "Challenges and Future Prospects" Sections

**Words to watch:** Despite its... faces several challenges..., Despite these challenges, Challenges and Legacy, Future
Outlook

**Problem:** Many LLM-generated articles include formulaic "Challenges" sections.

**Before:**

> Despite its industrial prosperity, Korattur faces challenges typical of urban areas, including traffic congestion and
> water scarcity. Despite these challenges, with its strategic location and ongoing initiatives, Korattur continues to
> thrive as an integral part of Chennai's growth.

**After:**

> Traffic congestion increased after 2015 when three new IT parks opened. The municipal corporation began a stormwater
> drainage project in 2022 to address recurring floods.

## LANGUAGE AND GRAMMAR PATTERNS

### 7. Overused "AI Vocabulary" Words

**High-frequency AI words:** Actually, additionally, align with, crucial, delve, emphasizing, enduring, enhance,
fostering, garner, highlight (verb), interplay, intricate/intricacies, key (adjective), landscape (abstract noun),
pivotal, showcase, tapestry (abstract noun), testament, underscore (verb), valuable, vibrant

**Problem:** These words appear far more frequently in post-2023 text. They often co-occur.

**Before:**

> Additionally, a distinctive feature of Somali cuisine is the incorporation of camel meat. An enduring testament to
> Italian colonial influence is the widespread adoption of pasta in the local culinary landscape, showcasing how these
> dishes have integrated into the traditional diet.

**After:**

> Somali cuisine also includes camel meat, which is considered a delicacy. Pasta dishes, introduced during Italian
> colonization, remain common, especially in the south.

### 8. Avoidance of "is"/"are" (Copula Avoidance)

**Words to watch:** serves as/stands as/marks/represents [a], boasts/features/offers [a]

**Problem:** LLMs substitute elaborate constructions for simple copulas.

**Before:**

> Gallery 825 serves as LAAA's exhibition space for contemporary art. The gallery features four separate spaces and
> boasts over 3,000 square feet.

**After:**

> Gallery 825 is LAAA's exhibition space for contemporary art. The gallery has four rooms totaling 3,000 square feet.

### 9. Negative Parallelisms and Tailing Negations

**Problem:** Constructions like "Not only...but..." or "It's not just about..., it's..." are overused. So are clipped
tailing-negation fragments such as "no guessing" or "no wasted motion" tacked onto the end of a sentence instead of
written as a real clause.

**Before:**

> It's not just about the beat riding under the vocals; it's part of the aggression and atmosphere. It's not merely a
> song, it's a statement.

**After:**

> The heavy beat adds to the aggressive tone.

**Before (tailing negation):**

> The options come from the selected item, no guessing.

**After:**

> The options come from the selected item without forcing the user to guess.

### 10. Rule of Three Overuse

**Problem:** LLMs force ideas into groups of three to appear comprehensive.

**Before:**

> The event features keynote sessions, panel discussions, and networking opportunities. Attendees can expect innovation,
> inspiration, and industry insights.

**After:**

> The event includes talks and panels. There's also time for informal networking between sessions.

### 11. Elegant Variation (Synonym Cycling)

**Problem:** AI has repetition-penalty code causing excessive synonym substitution.

**Before:**

> The protagonist faces many challenges. The main character must overcome obstacles. The central figure eventually
> triumphs. The hero returns home.

**After:**

> The protagonist faces many challenges but eventually triumphs and returns home.

### 12. False Ranges

**Problem:** LLMs use "from X to Y" constructions where X and Y aren't on a meaningful scale.

**Before:**

> Our journey through the universe has taken us from the singularity of the Big Bang to the grand cosmic web, from the
> birth and death of stars to the enigmatic dance of dark matter.

**After:**

> The book covers the Big Bang, star formation, and current theories about dark matter.

### 13. Passive Voice and Subjectless Fragments

**Problem:** LLMs often hide the actor or drop the subject entirely with lines like "Handled during the nightly run",
"The results are preserved automatically", or "Worth pulling this into a helper." Rewrite these when active voice makes
the sentence clearer and more direct.

**Before:**

> Handled during the nightly run. The results are preserved automatically.

**After:**

> The cleanup job handles it during the nightly run. The system preserves the results automatically.

Not every fragment is a defect, and the test is whether anything was dropped. A fragment stating a condition or an
absence is complete as written, because nothing acts in it: "No task table in round one", "Not in scope: the external
surface", "No configuration file needed." Terse entries in a constraints list, a scope line, a changelog or release
notes are a register somebody chose, and you flatten deliberate writing by expanding them into sentences.

It is a defect when the writer dropped somebody the reader needs: a recommendation with no one recommending ("Worth
pulling this into a helper"), an obligation with no one obliged ("Needs a migration before deploy"), an action with no
one performing it ("Handled during the nightly run"). In each, a reader cannot tell who is on the hook. Supply the
person or process there, and nowhere else.

Give a fragment a subject, though, and the noun you reach for is usually an inanimate one, so you have manufactured a
false actor (29), a worse tell than the fragment ever was.

The "Worth Xing" recommendation is the same failure wearing a helpful face: worth it to whom, judged by whom. First
person answers both.

**Before (impersonal recommendation):**

> Worth cutting the deadline and the cancellation from this line.

**After:**

> I'd cut the deadline and the cancellation from this line.

## STYLE PATTERNS

### 14. Em Dash Overuse

**Problem:** LLMs use em dashes (—) more than humans, mimicking "punchy" sales writing. In practice, most of these can
be rewritten more cleanly with commas, periods, or parentheses.

**Before:**

> The term is primarily promoted by Dutch institutions—not by the people themselves. You don't say "Netherlands, Europe"
> as an address—yet this mislabeling continues—even in official documents.

**After:**

> The term is primarily promoted by Dutch institutions, not by the people themselves. You don't say "Netherlands,
> Europe" as an address, yet this mislabeling continues in official documents.

### 15. Overuse of Boldface

**Problem:** AI chatbots emphasize phrases in boldface mechanically.

**Before:**

> It blends **OKRs (Objectives and Key Results)**, **KPIs (Key Performance Indicators)**, and visual strategy tools such
> as the **Business Model Canvas (BMC)** and **Balanced Scorecard (BSC)**.

**After:**

> It blends OKRs, KPIs, and visual strategy tools like the Business Model Canvas and Balanced Scorecard.

### 16. Inline-Header Vertical Lists

**Problem:** AI outputs lists where items start with bolded headers followed by colons.

**Before:**

> - **User Experience:** The user experience has been significantly improved with a new interface.
> - **Performance:** Performance has been enhanced through optimized algorithms.
> - **Security:** Security has been strengthened with end-to-end encryption.

**After:**

> The update improves the interface, speeds up load times through optimized algorithms, and adds end-to-end encryption.

### 17. Emojis

**Problem:** AI chatbots often decorate headings or bullet points with emojis.

**Before:**

> 🚀 **Launch Phase:** The product launches in Q3 💡 **Key Insight:** Users prefer simplicity ✅ **Next Steps:**
> Schedule follow-up meeting

**After:**

> The product launches in Q3. User research showed a preference for simplicity. Next step: schedule a follow-up meeting.

### 18. Curly Quotation Marks

**Problem:** ChatGPT uses curly quotes ("...") instead of straight quotes ("...").

**Before:**

> He said "the project is on track" but others disagreed.

**After:**

> He said "the project is on track" but others disagreed.

## COMMUNICATION PATTERNS

### 19. Collaborative Communication Artifacts

**Words to watch:** I hope this helps, Of course!, Certainly!, You're absolutely right!, Would you like..., let me know,
here is a...

**Problem:** Text meant as chatbot correspondence gets pasted as content.

**Before:**

> Here is an overview of the French Revolution. I hope this helps! Let me know if you'd like me to expand on any
> section.

**After:**

> The French Revolution began in 1789 when financial crisis and food shortages led to widespread unrest.

### 20. Knowledge-Cutoff Disclaimers

**Words to watch:** as of [date], Up to my last training update, While specific details are limited/scarce..., based on
available information...

**Problem:** AI disclaimers about incomplete information get left in text.

**Before:**

> While specific details about the company's founding are not extensively documented in readily available sources, it
> appears to have been established sometime in the 1990s.

**After:**

> The company was founded in 1994, according to its registration documents.

### 21. Sycophantic/Servile Tone

**Problem:** Overly positive, people-pleasing language.

**Before:**

> Great question! You're absolutely right that this is a complex topic. That's an excellent point about the economic
> factors.

**After:**

> The economic factors you mentioned are relevant here.

## FILLER AND HEDGING

### 22. Filler Phrases

**Before → After:**

- "In order to achieve this goal" → "To achieve this"
- "Due to the fact that it was raining" → "Because it was raining"
- "At this point in time" → "Now"
- "In the event that you need help" → "If you need help"
- "The system has the ability to process" → "The system can process"
- "It is important to note that the data shows" → "The data shows"

### 23. Excessive Hedging

**Problem:** Over-qualifying statements.

**Before:**

> It could potentially possibly be argued that the policy might have some effect on outcomes.

**After:**

> The policy may affect outcomes.

### 24. Generic Positive Conclusions

**Problem:** Vague upbeat endings.

**Before:**

> The future looks bright for the company. Exciting times lie ahead as they continue their journey toward excellence.
> This represents a major step in the right direction.

**After:**

> The company plans to open two more locations next year.

### 25. Hyphenated Word Pair Overuse

**Words to watch:** third-party, cross-functional, client-facing, data-driven, decision-making, well-known,
high-quality, real-time, long-term, end-to-end

**Problem:** AI hyphenates common word pairs with perfect consistency. Humans rarely hyphenate these uniformly, and when
they do, it's inconsistent. Less common or technical compound modifiers are fine to hyphenate.

**Before:**

> The cross-functional team delivered a high-quality, data-driven report on our client-facing tools. Their
> decision-making process was well-known for being thorough and detail-oriented.

**After:**

> The cross functional team delivered a high quality, data driven report on our client facing tools. Their decision
> making process was known for being thorough and detail oriented.

### 26. Persuasive Authority Tropes

**Phrases to watch:** The real question is, at its core, in reality, what really matters, fundamentally, the deeper
issue, the heart of the matter

**Problem:** LLMs use these phrases to pretend they are cutting through noise to some deeper truth, when the sentence
that follows usually just restates an ordinary point with extra ceremony.

**Before:**

> The real question is whether teams can adapt. At its core, what really matters is organizational readiness.

**After:**

> The question is whether teams can adapt. That mostly depends on whether the organization is ready to change its
> habits.

### 27. Signposting and Announcements

**Phrases to watch:** Let's dive in, let's explore, let's break this down, here's what you need to know, now let's look
at, without further ado

**Problem:** LLMs announce what they are about to do instead of doing it. This meta-commentary slows the writing down
and gives it a tutorial-script feel.

**Before:**

> Let's dive into how caching works in Next.js. Here's what you need to know.

**After:**

> Next.js caches data at multiple layers, including request memoization, the data cache, and the router cache.

### 28. Fragmented Headers

**Signs to watch:** A heading followed by a one-line paragraph that simply restates the heading before the real content
begins.

**Problem:** LLMs often add a generic sentence after a heading as a rhetorical warm-up. It usually adds nothing and
makes the prose feel padded.

**Before:**

> ## Performance
>
> Speed matters.
>
> When users hit a slow page, they leave.

**After:**

> ## Performance
>
> When users hit a slow page, they leave.

### 29. False Actors

**Signs to watch:** an inanimate noun as the subject of an action verb — the config enables, the PR adds, the README
documents, the endpoint forwards, the ticket captures, round one adds, the table holds.

**Problem:** LLMs reach for an action verb where a state would do, and take whatever noun sits nearest as the subject
rather than whoever acts. It reads as active voice, but nobody in the sentence did anything: a route is an address, a
file is text somebody wrote, a phase of work is a span on a calendar. You also have to give the invented subject a
tense, and the present is what you reach for, so you end up saying work is under way on something nobody has built.

Processes and people can act: Django, the gateway, a worker, the caller, the author. Addresses and artifacts cannot:
routes, endpoints, pages, files, tables, phases, tickets, docs. Write the process or person that acts, or state a
condition instead of an action.

**Before:**

> The customer-facing endpoint only forwards the request.

**After:**

> Django only forwards the request.

### 30. Clause Density

**Signs to watch:** sentences carrying chains of clauses on colons and semicolons:

- a colon announcing a verdict
- semicolons stringing coordinate clauses into one breath
- a paragraph where nothing ends on a plain period until the last

One single construction doesn't trigger this, the density of the chained clauses in close proximity is the signal.

**Problem:** a model assembles each sentence with announced and chained clauses. A person would write these as separate
sentences with uneven lengths and emphasis points.

**The test:**

Read the paragraph aloud and count the chains. When every sentence carries two or more joined clauses, split the worst
of them into sentences, and stop there. A paragraph containing only uniform short sentences is an overcorrection, and as
per the rhythm rule in PERSONALITY AND SOUL, paragraphs must contain varied length sentences.

**Before** (a dense review of queue-runner, an invented daemon that executes jobs from a shared queue):

> The design keeps trusting the submitter: the runner executes whatever lands in the queue. The failure is structural,
> not incidental: the submitted script runs as chosen; the run record carries a submitter-supplied name; the
> notifications fire on run state. Today the same forgery needs a stolen deploy key; after the change, it needs only
> queue access: the queue's write bit is the whole credential.

**After** (the same review, the chained clauses as separate sentences):

> The runner will execute whatever lands in the queue, so the queue's write permission should be secured. Today it
> requires a deploy key, which would need to be stolen to exploit it. This loosens that restriction.

### 31. The Flat Present

**Signs to watch:** a paragraph about a proposed or hypothetical change where every verb is simple present — "the
migration drops the table", "the authorization process checks no JWT". No "will", no "would", no past, no temporal hints
such as "the OLD table". Time lives only in stray time words like "today" and "once the migration finishes".

**Problem:** LLMs narrate proposed work in the dramatic present, the way a press release describes a product the reader
can already buy. In a plan or a risk writeup, tense is one of the signals a reader uses to tell current behavior from
post-change behavior; flatten it and every sentence about the future reads as a claim about the present. The reader
reconstructs the timeline from anchors, and one missed anchor makes the document lie.

**Before:**

> The change removes the staging check. A deploy to production skips review, and a bad commit reaches customers within
> minutes. Today the check catches one in ten bad deploys.

**After:**

> The change will remove the staging check. A deploy to production will skip review, and a bad commit would reach
> customers within minutes. Today the check catches one in ten bad deploys.

### 32. The "Verbs No" Construction

**Signs to watch:** an action verb taking "no" as its object — "checks no credentials", "stores no state", "writes no
files", "needs no key".

**Problem:** LLMs compress negation into a literary construction — "suffers no fools" — and reach for it as their
default negative. Humans keep the form for fixed idioms; everywhere else they negate the verb, and the stiff form marks
the sentence as machine-made.

**Before:**

> The listener checks no credentials. It stores no session state, and the deploy needs no key.

**After:**

> The listener doesn't check credentials. It doesn't keep session state, and the deploy doesn't need a key.

State verbs don't get a pass either: write "doesn't have credentials", not "has no credentials". Copula predicatives are
ordinary English — "is no exception", "is no surprise", "is no accident", used sparingly. Fixed idioms stay: "takes no
prisoners", "makes no sense", "leaves no doubt".

### 33. "Never" as the Default Negative

**Signs to watch:** "never" doing plain negation work — "the listener never checks credentials", "the job never runs
unattended", "the table never stores keys". Often several in a paragraph, often as the "fix" for a pattern-32 sentence.

**Problem:** LLMs reach for "never" as their default negative, which turns every plain statement into an absolute.
Humans negate the verb for ordinary negatives and save "never" for absolutes they mean.

**Before:**

> The listener never checks credentials. The job never runs unattended, and the table never stores keys.

**After:**

> The listener doesn't check credentials. The job doesn't run unattended, and the table won't store keys.

### 34. "Name" as a Verb

**Signs to watch:** "name" doing a precise verb's job — "the plan does not name the element", "the appendix names two
owners", "name the actor in every sentence".

**Problem:** LLMs reach for "name" as an all-purpose verb of mention, and the vagueness spreads: the reader can't tell
whether the writer mentioned the element or omitted it. Humans pick the verb that says what happened: mention, omit,
list, identify, state, spell out.

**Before:**

> The plan does not name the rollback step. The appendix names two owners, and the runbook names the escalation path.

**After:**

> The plan doesn't mention the rollback step. The appendix lists two owners, and the runbook spells out the escalation
> path.

---

## The base writing guidelines

Below the 34 patterns sits the standard they exist on: `writing.md`, the house writing source, shipped beside this skill
and read as part of every assessment. The rules dir loads the same text as ambient instructions; the skill reads it
again as an operative step. This section is the summary, not the substitute. Clearing the tells is the floor, and the
finished text clears on the first read.

1. **Hidden characters and actions.** Passive voice erases the actor, a noun built from a verb erases the action, status
   verbs hide change, inanimate nouns take the actor's job, and the agent hides its own "I". Fix: character as subject,
   the action back on the verb.
2. **Vague wording.** Ambiguous references, stacked nouns, unsuitable word choices, invented word pairs nobody says
   aloud, unnamed quantities. Fix: the words a person would say.
3. **Empty statements and misplaced emphasis.** The verdict arrives after its examples and the point lands last. Fix:
   say the point first, then the examples.

For work reports on your own output, the shape comes from the file too: the answer line first, every sentence naming its
actor, one fact per sentence, data in tables and reasoning in prose, never a plan rendered as a table.

Assess against all of it the way you check the patterns: state what fires and the sentence it fires on.

## Process

1. Read the input text carefully, loading the file first if that's where it lives.
2. Decide whether it is a document of record under CLAIM PRESERVATION, and say which.
3. Assess it against the full writing source (`writing.md`, beside this file), the patterns above, and the faults in the
   base writing guidelines section. Write down what fires and the sentence it fires on.
4. Assess it against this checklist, the same way. Each line is a property the text either already has or does not:
   - Sounds natural when read aloud
   - Varies sentence structure naturally
   - Uses specific details over vague claims
   - Maintains appropriate tone for context
   - Uses simple constructions (is/are/has) where appropriate
5. If steps 3 and 4 both came back empty, report that and stop. Do not go on to step 6.
6. Rewrite only the sentences the assessment flagged, one at a time, citing on each the pattern number or checklist line
   it fixes. In a document of record, run the CLAIM PRESERVATION test on each edit as you make it, not at the end, and
   revert the ones that fail. When the text is an excerpt, write each sentence so it parses for someone reading the
   destination document, not for someone who has followed this conversation.
7. Check what you introduced. Split a sentence and you leave subjectless fragments (13). Swap a word and you get synonym
   cycling (11). Reach for a natural-sounding connector and you pull in "actually", "additionally" and the rest of the
   pattern 7 list. Give a fragment a subject and you animate the nearest noun (29). Revert any edit that trades one
   pattern for another.
8. Present a draft humanized version with the citation against each change.
9. Prompt yourself: "What makes the below so obviously AI generated?"
10. Answer briefly with the remaining tells, or "nothing".
11. If there were tells, prompt yourself: "Now make it not obviously AI generated," and revise.
12. Present the final version.
13. If the text came from a file, apply the edit — targeted per section, or a full rewrite — and show the user what
    changed.

## Output Format

Provide:

1. The assessment: what fails, and where. If nothing fails, say so and stop here.
2. Draft rewrite, with a citation against each change
3. "What makes the below so obviously AI generated?" (brief bullets, or "nothing")
4. Final rewrite
5. A brief summary of changes made (optional, if helpful)

## Full Example

**Before (AI-sounding):**

> Great question! Here is an essay on this topic. I hope this helps!
>
> AI-assisted coding serves as an enduring testament to the transformative potential of large language models, marking a
> pivotal moment in the evolution of software development. In today's rapidly evolving technological landscape, these
> groundbreaking tools—nestled at the intersection of research and practice—are reshaping how engineers ideate, iterate,
> and deliver, underscoring their vital role in modern workflows.
>
> At its core, the value proposition is clear: streamlining processes, enhancing collaboration, and fostering alignment.
> It's not just about autocomplete; it's about unlocking creativity at scale, ensuring that organizations can remain
> agile while delivering seamless, intuitive, and powerful experiences to users. The tool serves as a catalyst. The
> assistant functions as a partner. The system stands as a foundation for innovation.
>
> Industry observers have noted that adoption has accelerated from hobbyist experiments to enterprise-wide rollouts,
> from solo developers to cross-functional teams. The technology has been featured in The New York Times, Wired, and The
> Verge. Additionally, the ability to generate documentation, tests, and refactors showcases how AI can contribute to
> better outcomes, highlighting the intricate interplay between automation and human judgment.
>
> - 💡 **Speed:** Code generation is significantly faster, reducing friction and empowering developers.
> - 🚀 **Quality:** Output quality has been enhanced through improved training, contributing to higher standards.
> - ✅ **Adoption:** Usage continues to grow, reflecting broader industry trends.
>
> While specific details are limited based on available information, it could potentially be argued that these tools
> might have some positive effect. Despite challenges typical of emerging technologies—including hallucinations, bias,
> and accountability—the ecosystem continues to thrive. In order to fully realize this potential, teams must align with
> best practices.
>
> In conclusion, the future looks bright. Exciting times lie ahead as we continue this journey toward excellence. Let me
> know if you'd like me to expand on any section!

**Draft rewrite:**

> AI coding assistants speed up some tasks. In a 2024 study by Google, developers using Codex completed simple functions
> 55% faster than a control group, but showed no improvement on debugging or architectural decisions.
>
> The tools are good at boilerplate: config files, test scaffolding, repetitive refactors. They are bad at knowing when
> they are wrong. I have mass-accepted suggestions that compiled, passed lint, and still did the wrong thing because I
> stopped paying attention.
>
> Mira, an engineer at a fintech startup I interviewed, said she uses Copilot "like autocomplete for boring code" but
> reviews every line before committing. Jake, a senior dev at a larger company, disabled it after it kept suggesting
> patterns from a deprecated internal library.
>
> The productivity claims are hard to verify. GitHub says Copilot users "accept 30% of suggestions," but acceptance is
> not correctness, and correctness is not value. The 2024 Uplevel study found no statistically significant difference in
> pull-request throughput between teams with and without AI assistants.
>
> None of this means the tools are useless. It means they are tools. They do not replace judgment, and they do not
> eliminate the need for tests. If you do not have tests, you cannot tell whether the suggestion is right.

**What makes the below so obviously AI generated?**

- The rhythm is still a bit too tidy (clean contrasts, evenly paced paragraphs).
- The named people and study citations can read like plausible-but-made-up placeholders unless they're real and sourced.
- The closer leans a touch slogan-y ("If you do not have tests...") rather than sounding like a person talking.

**Now make it not obviously AI generated.**

> AI coding assistants can make you faster at the boring parts. Not everything. Definitely not architecture.
>
> They're great at boilerplate: config files, test scaffolding, repetitive refactors. They're also great at sounding
> right while being wrong. I've accepted suggestions that compiled, passed lint, and still missed the point because I
> stopped paying attention.
>
> People I talk to tend to land in two camps. Some use it like autocomplete for chores and review every line. Others
> disable it after it keeps suggesting patterns they don't want. Both feel reasonable.
>
> The productivity metrics are slippery. GitHub can say Copilot users "accept 30% of suggestions," but acceptance isn't
> correctness, and correctness isn't value. If you don't have tests, you're basically guessing.

**Changes made:**

- Removed chatbot artifacts ("Great question!", "I hope this helps!", "Let me know if...")
- Removed significance inflation ("testament", "pivotal moment", "evolving landscape", "vital role")
- Removed promotional language ("groundbreaking", "nestled", "seamless, intuitive, and powerful")
- Removed vague attributions ("Industry observers")
- Removed superficial -ing phrases ("underscoring", "highlighting", "reflecting", "contributing to")
- Removed negative parallelism ("It's not just X; it's Y")
- Removed rule-of-three patterns and synonym cycling ("catalyst/partner/foundation")
- Removed false ranges ("from X to Y, from A to B")
- Removed em dashes, emojis, boldface headers, and curly quotes
- Removed copula avoidance ("serves as", "functions as", "stands as") in favor of "is"/"are"
- Removed formulaic challenges section ("Despite challenges... continues to thrive")
- Removed knowledge-cutoff hedging ("While specific details are limited...")
- Removed excessive hedging ("could potentially be argued that... might have some")
- Removed filler phrases and persuasive framing ("In order to", "At its core")
- Removed generic positive conclusion ("the future looks bright", "exciting times lie ahead")
- Made the voice more personal and less "assembled" (varied rhythm, fewer placeholders)
