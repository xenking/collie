import type { Host } from "./host.ts";

/**
 * The terminal job-control stops: Ctrl+Z's SIGTSTP and the background-read/write SIGTTIN and SIGTTOU.
 * Their default action STOPS the process, and a stopped bridge is the worst way for it to fail: launchd
 * and systemd still list the service as running, so nothing restarts it, while every HTTP request and
 * every herdr poll waits forever. The bridge has no terminal to give back, so it has nothing to stop for.
 * Observed 2026-11-12 on macOS: a bridge stopped by a stray SIGTSTP (state `T`) hung for 36 hours.
 * SIGSTOP cannot be caught and stays the deliberate way to pause it.
 */
export const JOB_CONTROL_STOPS = ["SIGTSTP", "SIGTTIN", "SIGTTOU"] as const;

/** Install a no-op handler for each {@link JOB_CONTROL_STOPS} signal, so none of them stops this process. */
export function ignoreJobControlStops(host: Host): void {
  if (host.platform === "win32") return;
  for (const signal of JOB_CONTROL_STOPS) process.on(signal, () => {});
}
