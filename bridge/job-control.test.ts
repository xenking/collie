import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { JOB_CONTROL_STOPS } from "./job-control.ts";

// A child Bun process installs the handlers and sends itself every job-control stop. Without them the
// kernel stops it on the first one (state `T`, as the bridge was found on 2026-11-12) and it never
// prints; with them it prints and exits.
async function runChild(ignore: boolean): Promise<string | null> {
  const script = [
    `import { HOST } from ${JSON.stringify(join(import.meta.dir, "host.ts"))};`,
    `import { ignoreJobControlStops, JOB_CONTROL_STOPS } from ${JSON.stringify(join(import.meta.dir, "job-control.ts"))};`,
    ignore ? "ignoreJobControlStops(HOST);" : "",
    "for (const signal of JOB_CONTROL_STOPS) process.kill(process.pid, signal);",
    // Real signals, real clock: a default stop may land on another thread just after kill() returns.
    "await Bun.sleep(100);",
    'console.log("alive");',
  ].join("\n");
  const child = Bun.spawn([process.execPath, "-e", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  // A stopped child never closes its stdout and no event says it stopped; SIGKILL still ends it.
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const out = await new Response(child.stdout).text();
    return (await child.exited) === 0 ? out.trim() : null;
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(process.platform === "win32")("the bridge ignores job-control stops", () => {
  test("lists the three terminal stop signals", () => {
    expect([...JOB_CONTROL_STOPS]).toEqual(["SIGTSTP", "SIGTTIN", "SIGTTOU"]);
  });

  test("a process that ignores them keeps running after SIGTSTP, SIGTTIN and SIGTTOU", async () => {
    expect(await runChild(true)).toBe("alive");
  }, 10_000);
});
