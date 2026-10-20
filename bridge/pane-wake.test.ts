import { describe, expect, test } from "bun:test";
import { wakePane, WAKE_DEADLINE_MS, type PaneWakeRuntime } from "./pane-wake.ts";
import { muxAck } from "./mux/types.ts";
import type { AgentView } from "./types.ts";

function view(extra: Partial<AgentView>): AgentView {
  // SAFETY: a test double carrying only the fields the wake reads.
  return { paneId: "p1", agent: "omp", ...extra } as AgentView;
}

/** A runtime whose engine shows `cached` until the wake Enter, then `afterWake` (if any) from the next poll. */
function runtime(opts: { cached: AgentView; freshSleeping?: boolean; afterWake?: AgentView }) {
  const keys: string[][] = [];
  let snapshots = 0;
  let agents = [opts.cached];
  const rt: PaneWakeRuntime = {
    engine: {
      // SAFETY: the wake reads only `agents` and `shellPanes` of the engine's state.
      current: () => ({ agents, shellPanes: [] }) as never,
      pokeNow: () => {
        if (keys.length > 0 && opts.afterWake) agents = [opts.afterWake];
      },
    },
    herdr: {
      snapshot: async () => {
        snapshots++;
        // SAFETY: the wake reads only `panes[].paneId` and `panes[].sleeping` of a snapshot.
        return { panes: [{ paneId: "p1", sleeping: opts.freshSleeping }], spaces: [], tabs: [] } as never;
      },
      refresh: async () => undefined,
      writeKeys: async (_pane: string, k: readonly string[]) => {
        keys.push([...k]);
        return muxAck();
      },
    },
  };
  return { rt, keys, snapshots: () => snapshots };
}

const hasSession = (pane: AgentView): boolean => pane.agentSession?.kind === "path";
const awake = view({ agentSession: { kind: "path", value: "/s.jsonl" } });

describe("wakePane", () => {
  test("a parked pane gets one Enter, and the wake waits until the pane reads ready", async () => {
    const { rt, keys } = runtime({ cached: view({ sleeping: true }), freshSleeping: true, afterWake: awake });
    expect(await wakePane(rt, "p1", hasSession, async () => undefined)).toEqual({ ok: true });
    expect(keys).toEqual([["Enter"]]);
  });

  test("an awake pane gets no Enter", async () => {
    const { rt, keys } = runtime({ cached: awake, freshSleeping: false });
    expect(await wakePane(rt, "p1", hasSession, async () => undefined)).toEqual({ ok: true });
    expect(keys).toEqual([]);
  });

  test("the fresh listing wins over the cached poll, both ways", async () => {
    // Woken at the desk after the last poll: no Enter into its live composer.
    const woken = runtime({ cached: view({ sleeping: true }), freshSleeping: false });
    expect(await wakePane(woken.rt, "p1", hasSession, async () => undefined)).toEqual({ ok: true });
    expect(woken.keys).toEqual([]);
    // Parked after the last poll: the cached view says awake, the listing says parked, so it is woken.
    const parked = runtime({ cached: view({}), freshSleeping: true, afterWake: awake });
    expect(await wakePane(parked.rt, "p1", hasSession, async () => undefined)).toEqual({ ok: true });
    expect(parked.keys).toEqual([["Enter"]]);
  });

  test("a pane that does not read ready inside the deadline times out after its one Enter", async () => {
    let clock = 0;
    const { rt, keys } = runtime({ cached: view({ sleeping: true }), freshSleeping: true });
    const sleep = async (ms: number): Promise<void> => {
      clock += ms;
    };
    expect(await wakePane(rt, "p1", hasSession, sleep, () => clock)).toEqual({ ok: false, why: "timeout" });
    expect(keys).toEqual([["Enter"]]);
    expect(clock).toBeGreaterThanOrEqual(WAKE_DEADLINE_MS);
  });

  test("a pane that is no omp pane reads no listing and gets no key", async () => {
    const { rt, keys, snapshots } = runtime({ cached: view({ agent: "claude" }), freshSleeping: true });
    expect(await wakePane(rt, "p1", hasSession, async () => undefined)).toEqual({ ok: true });
    expect(snapshots()).toBe(0);
    expect(keys).toEqual([]);
  });
});
