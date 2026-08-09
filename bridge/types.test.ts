import { describe, expect, test } from "bun:test";

import { toPaneWire, type AgentView } from "./types.ts";

const omp: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "work",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "omp",
  status: "idle",
  cwd: "/tmp/work",
  focused: true,
};

describe("toPaneWire voice capability", () => {
  test("exposes only a safe capability flag for OMP path sessions", () => {
    const wire = toPaneWire(
      { ...omp, agentSession: { kind: "path", value: "/private/session.jsonl" } },
      () => true,
    );
    expect(wire).toMatchObject({ hasSession: true, voiceCapable: true });
    expect(wire).not.toHaveProperty("agentSession");
  });

  test("does not offer voice without OMP's session path", () => {
    expect(toPaneWire(omp, () => true).voiceCapable).toBeUndefined();
    expect(toPaneWire({ ...omp, agentSession: { kind: "id", value: "opaque" } }, () => true).voiceCapable).toBeUndefined();
  });
});
