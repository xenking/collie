import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SentEntry } from "@/lib/types";

const getSent = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), getSent: (...args: unknown[]) => getSent(...args) }));

import { useSentList, type SentChoice } from "./use-sent-list";

const entry = (id: string, at: number): SentEntry => ({ id, line: id, cwd: "/p", at, kind: "shell", count: 1, host: "m" });
const page = (entries: SentEntry[], more: boolean) => ({ entries, more, off: false, machines: [] });

const INITIAL: { choice: SentChoice } = { choice: "folder" };

describe("useSentList", () => {
  beforeEach(() => getSent.mockReset());

  it("drops a Load more page that lands after the place changed", async () => {
    let late: (value: ReturnType<typeof page>) => void = () => {};
    getSent.mockResolvedValueOnce(page([entry("a", 9)], true));
    const { result, rerender } = renderHook((p: { choice: SentChoice }) => useSentList({ choice: p.choice, cwd: "/p", query: "", scope: undefined, lead: undefined }), { initialProps: INITIAL });
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
