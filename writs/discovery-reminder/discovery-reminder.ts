const REMINDER = `<system-reminder>
Discovery mode is for brainstorming: explore, analyze, and offer options — the deliverable is understanding, not plans or action. Read-only. Inspect the implementation and relevant history before making assumptions. Only write an explicitly requested Markdown PRD or ADR under docs/prd/ or docs/adr/.
</system-reminder>`;

export default {
  id: "discovery-reminder",
  setup: async () => ({
    // Rides the discovery request's context as a trailing synthetic message;
    // the model-facing reminder text is what the agent actually consumes.
    "session.context": async (context) => {
      if (context.agent !== "discovery") return;

      if (
        context.messages.some(
          (message) =>
            message.type === "synthetic" && message.text === REMINDER,
        )
      ) {
        return;
      }

      const last = context.messages.at(-1);
      if (!last || last.type !== "user") return;

      context.messages.push({
        id: `${last.id}-discovery-reminder`,
        type: "synthetic",
        text: REMINDER,
        time: { created: last.time?.created ?? Date.now() },
      });
    },
  }),
};
