import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { voicePreferencesResponse } from "./server.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the voice preferences the phone records with", () => {
  test("STT-only voice works without the OMP daemon: no token file answers the default mode", async () => {
    const res = await voicePreferencesResponse({ voiceControlUrl: "http://127.0.0.1:1/speech", voiceControlTokenFile: "/nonexistent/token" }, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recordingMode: "toggle" });
  });

  test("a daemon that does not answer falls back the same way; one that answers decides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-pref-"));
    dirs.push(dir);
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "secret\n");
    const down = await voicePreferencesResponse({ voiceControlUrl: "http://127.0.0.1:1/speech", voiceControlTokenFile: tokenFile }, null);
    expect(await down.json()).toEqual({ recordingMode: "toggle" });

    const daemon = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (req.headers.get("x-omp-voice-token") === "secret" ? Response.json({ recordingMode: "hold" }) : new Response("no", { status: 401 })) });
    try {
      const up = await voicePreferencesResponse({ voiceControlUrl: `http://127.0.0.1:${daemon.port}/speech`, voiceControlTokenFile: tokenFile }, null);
      expect(await up.json()).toEqual({ recordingMode: "hold" });
    } finally {
      void daemon.stop(true);
    }
  });
});
