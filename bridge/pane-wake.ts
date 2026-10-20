import type { MuxAdapter } from "./mux/types.ts";
import { gateFor } from "./surface/key-gate.ts";
import type { StateEngine } from "./state-engine.ts";
import type { AgentView } from "./types.ts";

/** What waking a parked pane needs of its runtime. */
export interface PaneWakeRuntime {
  readonly engine: Pick<StateEngine, "current" | "pokeNow">;
  readonly herdr: Pick<MuxAdapter, "snapshot" | "refresh" | "writeKeys">;
}

/**
 * How a wake went. `ok` covers a pane that was awake already and one that woke inside the deadline.
 * `unavailable`: the fresh listing failed; `gone`: it does not list the pane; `failed`: the Enter was
 * refused (`detail` says why); `timeout`: the Enter went and the pane did not read ready in time.
 */
export type PaneWake = { readonly ok: true } | { readonly ok: false; readonly why: "unavailable" | "gone" | "failed" | "timeout"; readonly detail?: string };

export const WAKE_DEADLINE_MS = 15_000;
const WAKE_POLL_MS = 250;

/** The pane as the engine's last poll saw it: agent panes and bare shells are separate collections. */
export function findPane(rt: Pick<PaneWakeRuntime, "engine">, paneId: string): AgentView | undefined {
  const { agents, shellPanes } = rt.engine.current();
  return agents.find((candidate) => candidate.paneId === paneId) ?? shellPanes.find((candidate) => candidate.paneId === paneId);
}

/**
 * Wake a pane Herdr parked (`omp (sleeping)`: the pane runs a parked screen, not omp, and Enter there
 * starts omp again in the same session), then wait until `ready` holds for the engine's view of it.
 * Only an omp pane parks, so any other pane is `ok` with no listing read.
 *
 * The wake Enter is the operator's own tap (the key gate's `person_tap` door): the caller runs this
 * only for something the operator just asked for on that pane. It is decided from a FRESH multiplexer
 * listing, never from the engine's cached `sleeping`: a pane someone woke after the last poll would
 * otherwise get an Enter in its live composer, which submits a draft or accepts a completion.
 */
export async function wakePane(
  rt: PaneWakeRuntime,
  paneId: string,
  ready: (pane: AgentView) => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  now: () => number = Date.now,
): Promise<PaneWake> {
  if (findPane(rt, paneId)?.agent !== "omp") return { ok: true };
  let fresh;
  try {
    fresh = (await rt.herdr.snapshot()).panes.find((candidate) => candidate.paneId === paneId);
  } catch {
    return { ok: false, why: "unavailable" };
  }
  if (!fresh) return { ok: false, why: "gone" };
  if (fresh.sleeping !== true) return { ok: true };
  const sent = await gateFor(rt.herdr).press(paneId, ["Enter"], "person_tap");
  if (!sent.ok) return { ok: false, why: "failed", detail: sent.detail };
  const deadline = now() + WAKE_DEADLINE_MS;
  for (;;) {
    try {
      await rt.herdr.refresh();
      rt.engine.pokeNow();
    } catch {
      // Keep the bounded wake wait; the next poll may recover the adapter.
    }
    const pane = findPane(rt, paneId);
    if (pane !== undefined && pane.sleeping !== true && ready(pane)) return { ok: true };
    if (now() >= deadline) return { ok: false, why: "timeout" };
    await sleep(WAKE_POLL_MS);
  }
}
