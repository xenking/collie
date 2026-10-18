import { describe, expect, test } from "bun:test";
import { prepareVoicePane, type VoicePaneRuntime } from "./voice-pane.ts";
import type { AgentView } from "./types.ts";

function view(extra: Partial<AgentView>): AgentView {
  // SAFETY: a test double carrying only the fields the voice handshake reads.
  return { paneId: "p1", agent: "omp", ...extra } as AgentView;
}

function runtime(opts: {
  agents?: AgentView[];
  shells?: AgentView[];
  freshSleeping?: boolean;
  afterWake?: AgentView;
  snapshotThrows?: boolean;
}) {
  const keys: string[][] = [];
  let agents = opts.agents ?? [];
  const rt: VoicePaneRuntime = {
    engine: {
      current: () => ({ agents, shellPanes: opts.shells ?? [] }) as never,
      pokeNow: () => {
        if (keys.length > 0 && opts.afterWake) agents = [opts.afterWake];
      },
    },
    herdr: {
      snapshot: async () => {
        if (opts.snapshotThrows) throw new Error("down");
        return { panes: [{ paneId: "p1", sleeping: opts.freshSleeping }], spaces: [], tabs: [] } as never;
      },
      refresh: async () => undefined,
      writeKeys: async (_pane: string, k: readonly string[]) => {
        keys.push([...k]);
        return { ok: true, value: undefined } as never;
      },
    },
  };
  return { rt, keys };
}

const instant = async () => undefined;

describe("prepareVoicePane", () => {
  test("a bare shell pane is served STT-only instead of 409", async () => {
    const { rt } = runtime({ shells: [view({ agent: "shell", kind: "shell" })] });
    expect(await prepareVoicePane(rt, "p1", instant)).toEqual({ ok: true, sessionFile: null });
  });

  test("an unknown pane is refused", async () => {
    const { rt } = runtime({});
    expect(await prepareVoicePane(rt, "p1", instant)).toEqual({ ok: false, detail: "voice requires a live pane" });
  });

  test("no wake Enter when the pane was already woken after the cached poll", async () => {
    const live = view({ sleeping: true, agentSession: { kind: "path", value: "/s.jsonl" } as never });
    const { rt, keys } = runtime({ agents: [live], freshSleeping: false });
    expect(await prepareVoicePane(rt, "p1", instant)).toEqual({ ok: true, sessionFile: "/s.jsonl" });
    expect(keys).toEqual([]);
  });

  test("wakes a pane that is still asleep and waits for its session", async () => {
    const woken = view({ agentSession: { kind: "path", value: "/s.jsonl" } as never });
    const { rt, keys } = runtime({ agents: [view({ sleeping: true })], freshSleeping: true, afterWake: woken });
    expect(await prepareVoicePane(rt, "p1", instant)).toEqual({ ok: true, sessionFile: "/s.jsonl" });
    expect(keys).toEqual([["Enter"]]);
  });

  test("fails closed, sending nothing, when the fresh read fails", async () => {
    const { rt, keys } = runtime({ agents: [view({ sleeping: true })], snapshotThrows: true });
    expect(await prepareVoicePane(rt, "p1", instant)).toEqual({ ok: false, detail: "voice pane state unavailable" });
    expect(keys).toEqual([]);
  });
});
