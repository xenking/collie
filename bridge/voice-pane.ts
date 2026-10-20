import { findPane, wakePane, type PaneWake, type PaneWakeRuntime } from "./pane-wake.ts";
import type { AgentView } from "./types.ts";

/** What the realtime-voice handshake needs from a pane's runtime. */
export type VoicePaneRuntime = PaneWakeRuntime;

export type VoicePaneOutcome =
  | { ok: true; sessionFile: string | null }
  | { ok: false; detail: string };

function sessionFileOf(pane: AgentView | undefined): string | null {
  return pane?.agent === "omp" && pane.agentSession?.kind === "path" ? pane.agentSession.value : null;
}

function wakeDetail(wake: Exclude<PaneWake, { ok: true }>): string {
  switch (wake.why) {
    case "unavailable":
      return "voice pane state unavailable";
    case "gone":
      return "voice requires a live pane";
    case "failed":
      return `voice wake failed: ${wake.detail ?? ""}`;
    case "timeout":
      return "voice wake timed out";
  }
}

/**
 * Resolve the pane a voice socket will serve, waking a parked OMP pane first (see {@link wakePane}).
 * `sessionFile` is the OMP session path when the pane can speak replies, and null for STT-only
 * (shells, other agents).
 */
export async function prepareVoicePane(
  rt: VoicePaneRuntime,
  paneId: string,
  sleep?: (ms: number) => Promise<void>,
  now?: () => number,
): Promise<VoicePaneOutcome> {
  if (!findPane(rt, paneId)) return { ok: false, detail: "voice requires a live pane" };
  const wake = await wakePane(rt, paneId, (pane) => sessionFileOf(pane) !== null, sleep, now);
  if (!wake.ok) return { ok: false, detail: wakeDetail(wake) };
  return { ok: true, sessionFile: sessionFileOf(findPane(rt, paneId)) };
}
