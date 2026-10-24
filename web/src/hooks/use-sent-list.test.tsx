import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SentEntry } from "@/lib/types";

const getSent = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), getSent: (...args: unknown[]) => getSent(...args) }));

import { useSentList } from "./use-sent-list";

const entry = (id: string, at: number): SentEntry => ({ id, at, text: id, host: "m", cwd: "/p" }) as unknown as SentEntry;
const page = (entries: SentEntry[], more: boolean) => ({ entries, more, off: false, machines: [] });

describe("useSentList", () => {
  beforeEach(() => getSent.mockReset());

  it("drops a Load more page that lands after the place changed", async () => {
    let late: (value: unknown) => void = () => {};
    getSent.mockResolvedValueOnce(page([entry("a", 9)], true));
    const { result, rerender } = renderHook((p: { choice: "here" | "all" }) => useSentList({ choice: p.choice, cwd: "/p", query: "", scope: undefined, lead: true } as never), { initialProps: { choice: "here" } });
    await waitFor(() => expect(result.current.view.phase).toBe("ready"));
    getSent.mockImplementationOnce(() => new Promise((resolve) => (late = resolve)));
    act(() => result.current.loadMore());
    getSent.mockResolvedValueOnce(page([entry("b", 8)], false));
    rerender({ choice: "all" });
    await waitFor(() => expect(result.current.view.phase === "ready" && result.current.view.entries.map((e) => e.id)).toEqual(["b"]));
    await act(async () => late(page([entry("stale", 1)], true)));
    expect(result.current.view.phase === "ready" && result.current.view.entries.map((e) => e.id)).toEqual(["b"]);
    expect(result.current.loadingMore).toBe(false);
  });
});
