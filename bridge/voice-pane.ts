import type { MuxAdapter } from "./mux/types.ts";
import type { StateEngine } from "./state-engine.ts";
import type { AgentView } from "./types.ts";

/** What the realtime-voice handshake needs from a pane's runtime. */
export interface VoicePaneRuntime {
  readonly engine: Pick<StateEngine, "current" | "pokeNow">;
  readonly herdr: Pick<MuxAdapter, "snapshot" | "refresh" | "sendKeys">;
}

export type VoicePaneOutcome =
  | { ok: true; sessionFile: string | null }
  | { ok: false; detail: string };

const WAKE_DEADLINE_MS = 15_000;
const WAKE_POLL_MS = 250;

function findPane(rt: VoicePaneRuntime, paneId: string): AgentView | undefined {
  // Agent panes and bare shells are separate collections; STT-only voice supports both.
  const { agents, shellPanes } = rt.engine.current();
  return agents.find((candidate) => candidate.paneId === paneId) ??
    shellPanes.find((candidate) => candidate.paneId === paneId);
}

/**
 * Resolve the pane a voice socket will serve, waking a parked OMP pane first. `sessionFile` is the
 * OMP session path when the pane can speak replies, and null for STT-only (shells, other agents).
 *
 * The wake key is decided from a FRESH multiplexer listing, never from the engine's cached `sleeping`:
 * a pane someone woke after the last poll would otherwise get an Enter in its live composer, which
 * submits a draft or accepts a completion.
 */
export async function prepareVoicePane(
  rt: VoicePaneRuntime,
  paneId: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now,
): Promise<VoicePaneOutcome> {
  const cached = findPane(rt, paneId);
  if (!cached) return { ok: false, detail: "voice requires a live pane" };

  let waking = false;
  if (cached.agent === "omp") {
    let fresh;
    try {
      fresh = (await rt.herdr.snapshot()).panes.find((candidate) => candidate.paneId === paneId);
    } catch {
      return { ok: false, detail: "voice pane state unavailable" };
    }
    if (!fresh) return { ok: false, detail: "voice requires a live pane" };
    waking = fresh.sleeping === true;
  }
  if (waking) {
    const sent = await rt.herdr.sendKeys(paneId, ["Enter"]);
    if (!sent.ok) return { ok: false, detail: `voice wake failed: ${sent.detail}` };
    const deadline = now() + WAKE_DEADLINE_MS;
    while (now() < deadline) {
      try {
        await rt.herdr.refresh();
        rt.engine.pokeNow();
      } catch {
        // Keep the bounded wake wait; the next poll may recover the adapter.
      }
      const pane = findPane(rt, paneId);
      if (pane && pane.agent === "omp" && pane.agentSession?.kind === "path") break;
      await sleep(WAKE_POLL_MS);
    }
  }

  const pane = findPane(rt, paneId);
  const sessionFile = pane?.agent === "omp" && pane.agentSession?.kind === "path" ? pane.agentSession.value : null;
  if (waking && sessionFile === null) return { ok: false, detail: "voice wake timed out" };
  return { ok: true, sessionFile };
}
