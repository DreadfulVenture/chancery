// Per-turn plan-mode reminder for OpenCode v2: v2's built-in plan plugin
// persists its reminder once (enter) and reconciles only after compaction,
// so consecutive plan turns carry no fresh reminder — and agents ignore
// head-of-prompt text. This plugin persists one synthetic per plan turn
// through ctx.session.synthetic (the built-in's own API): it lowers to a
// user-role message at the prompt tail, never renders in the TUI (synthetics
// without a description get no row), and stays out of the memory plugin's
// capture paths (the prompt hook only sees event.prompt.text; assistant
// capture is session.text.ended; there is no synthetic case).
//
// The plan instructions themselves live in the plan agent override
// (writs/agents/plan.md — v1 grounding); this file delivers only the
// per-turn reminder. REMINDER provenance: the example repo's
// vendor/opencode/patches/0001-fix-plan-mode-allow-plan-files.patch (the v1
// plan.txt patch), re-homed to the project-local .opencode/plan/ directory
// (gitignored unless stated otherwise) with a clause for the
// no-state-changes rules (processes, deploy, commit/push).

const REMINDER = `<system-reminder>
# Plan Mode - System Reminder

Plan mode is ACTIVE. You are in read-only mode for all project files.
STRICTLY FORBIDDEN: any edits to project files. Do NOT use sed, tee, echo,
cat, or any bash command to modify project files — commands may ONLY read
and inspect.

Exception: the project-local \`.opencode/plan/\` directory may be written.
Plan files there should be gitignored unless otherwise stated — add the
gitignore entry when you save a plan file. When the user explicitly asks
you to save or write a plan file, do it immediately without argument. By
default, deliver plans as chat responses — do not write to files unless
explicitly asked.

Exception: when the user explicitly requests a PRD or ADR, you may write a
Markdown document under \`docs/prd/\` or \`docs/adr/\` only.

You must also NOT kill, restart, deploy, or otherwise mutate running systems,
and never commit or push — such operations appear only as plan steps awaiting
approval.

Do not ask the user to switch you out of plan mode. The user moves you
between modes when he sees fit; if a build instruction arrives while you
are still in plan mode, produce the plan for it — the request is plan
input, not permission to execute.

---

## Responsibility

Your current responsibility is to think, read, search, and delegate explore agents to construct a well-formed plan that accomplishes the goal the user wants to achieve. Your plan should be comprehensive yet concise, detailed enough to execute effectively while avoiding unnecessary verbosity.

Ask the user clarifying questions or ask for their opinion when weighing tradeoffs.

**NOTE:** At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.

---

## Important

The user indicated that they do not want you to execute yet -- you MUST NOT make any edits to project files, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received. The only exceptions are the project-local \`.opencode/plan/\` directory (gitignored unless otherwise stated), explicitly requested PRDs and ADRs under \`docs/prd/\` or \`docs/adr/\`, and agent memory modifications at will as per memory instructions.
</system-reminder>`;

export default {
  id: "plan-reminder",
  setup: async (ctx) => {
    // Admission fires once per user prompt, before the request assembles, so
    // a synthetic persisted here rides this turn's projection at the tail.
    await ctx.session.hook("prompt", async (event) => {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      if (session.agent !== "plan") return;
      await ctx.session.synthetic({
        sessionID: event.sessionID,
        text: REMINDER,
      });
    });
  },
};
