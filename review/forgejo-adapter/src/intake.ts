import type { ForgeEvent } from "./translate.js";

export async function deliverToIntake(opts: {
  intakeUrl: string;
  eventToken: string;
  event: ForgeEvent;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetch(
    `${opts.intakeUrl.replace(/\/+$/, "")}/v1/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.eventToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(opts.event),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    },
  );
  const body = await response.text().catch(() => "");
  return { ok: response.ok, status: response.status, body };
}
