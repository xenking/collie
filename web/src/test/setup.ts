import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { setupServer } from "msw/node";

import { handlers, resetTypedDraft } from "./handlers";
import { __resetConnectionHealth } from "@/lib/connection-health";

// One MSW server for all tests; tests add per-case overrides with `server.use(...)`.
export const server = setupServer(...handlers);

// Bun's Vitest/jsdom binding exposes a non-Storage `localStorage`; install the browser contract the
// app uses so persisted drafts and preferences exercise their real code paths. getItem/setItem live
// on Storage.prototype because draft tests deliberately simulate Safari failures through that seam.
const stored = new Map<string, string>();
Object.defineProperties(Storage.prototype, {
  getItem: { configurable: true, value: (key: string) => stored.get(key) ?? null, writable: true },
  setItem: { configurable: true, value: (key: string, value: string) => stored.set(key, value), writable: true },
});
const testStorage = Object.assign(Object.create(Storage.prototype) as Storage, {
  clear: () => stored.clear(),
  key: (index: number) => [...stored.keys()][index] ?? null,
  removeItem: (key: string) => stored.delete(key),
});
Object.defineProperty(testStorage, "length", { get: () => stored.size });
Object.defineProperty(window, "localStorage", { configurable: true, value: testStorage });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: testStorage });

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
// The connection-health store is module-scoped and initialises its anchor to module-load time. Pin it
// to "now" before every test so a component rendered minutes after the file loaded never reads a stale
// anchor as an escalated outage. Fake-timer escalation suites re-pin AFTER vi.useFakeTimers() so the
// anchor equals the frozen clock exactly.
beforeEach(() => __resetConnectionHealth());
// Persisted state (composer drafts, prefs) must not leak between cases — a draft saved by one test
// would be restored into the next test's freshly-mounted composer.
beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetTypedDraft(); // the fake pane's input line, so a draft can't leak into the next test
});
afterAll(() => server.close());

// jsdom gaps that the terminal mirror / sheets touch.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
if (!("matchMedia" in window)) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}
