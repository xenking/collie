// A REAL SEND over captures of omp 18.10.0's borderless composer (the `›` gutter), 2026-10-16.
//
// The bug: Collie typed `reply ok @READ`, verified it, pressed Enter and reported "Sent" with the draft
// cleared, while omp had spent that Enter on its `@` file menu. The menu applied the highlighted entry
// and left `› reply ok @README.md` in the prompt: nothing was submitted and the message sat stranded
// there. The bridge's ack of the key is all the client had to go on, so it could not know.
//
// Each screen below is a real `herdr pane read --format ansi` capture; the fake pane moves between them
// the way the real one did.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw";
import type * as Liveness from "@/lib/liveness";
import { sendGuardedReply } from "../reply-action";

vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof Liveness>()),
  isLive: () => true,
  useLive: () => true,
}));

const PANES = join(import.meta.dirname, "../../fixtures/panes");
const capture = (name: string) => readFileSync(join(PANES, `omp--v18-10-borderless-glyph-${name}.txt`), "utf8");
const TEXT = "reply ok @READ";

type Reply = { text: string; submit?: boolean; expected_prompt?: string };

/**
 * A pane whose screen after the n-th submit key is given; the typed text brings the `@` menu up.
 * `refuse` names the submit keys (0-based) the bridge answers with 409 prompt_changed, as it does when
 * the bound prompt is gone by the time the key would go out.
 */
function fakePane(afterSubmit: string[], refuse: number[] = []) {
  let screen = capture("empty");
  let submits = 0;
  const replies: Reply[] = [];
  server.use(
    http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: "w1V:p1", text: screen })),
    http.post<never, Reply>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
      const body = await request.json();
      replies.push(body);
      if (body.submit === true && body.text === "") {
        const n = submits++;
        screen = afterSubmit[Math.min(n, afterSubmit.length - 1)]!;
        if (refuse.includes(n)) return HttpResponse.json({ ok: false, code: "prompt_changed", error: "prompt changed" }, { status: 409 });
      } else screen = capture("autocomplete");
      return HttpResponse.json({ ok: true });
    }),
  );
  return replies;
}

const submitKeys = (replies: Reply[]) => replies.filter((r) => r.submit === true && r.text === "");

const send = () =>
  sendGuardedReply({ paneId: "w1V:p1", agent: "omp", text: TEXT, requestedLines: 200, sleep: async () => {} });

describe("omp 18.10 borderless send: the message must leave the prompt before it is reported sent", () => {
  it("never submits a completion: the `@` menu rewrote the draft, so it stays unsent with the draft kept", async () => {
    const replies = fakePane([capture("completion-accepted"), capture("submitted")]);
    expect(await send()).toMatchObject({ status: "error", textDelivered: true });
    expect(submitKeys(replies)).toHaveLength(1);
  });

  it("presses Enter again while the box still holds exactly the sent text", async () => {
    const replies = fakePane([capture("autocomplete"), capture("submitted")]);
    expect((await send()).status).toBe("sent");
    const submits = submitKeys(replies);
    expect(submits).toHaveLength(2);
    expect(submits[1]!.expected_prompt).toBe("› reply ok @READ");
  });

  it("keeps the draft when the unchanged text is still in the prompt after the retry", async () => {
    const replies = fakePane([capture("autocomplete")]);
    expect(await send()).toMatchObject({ status: "error", textDelivered: true });
    expect(submitKeys(replies)).toHaveLength(2);
  });

  it("reports sent when the retry finds its prompt gone because a late repaint emptied the box", async () => {
    const replies = fakePane([capture("autocomplete"), capture("submitted")], [1]);
    expect((await send()).status).toBe("sent");
    expect(submitKeys(replies)).toHaveLength(2);
  });

  it("reports sent after one Enter when the prompt is empty again", async () => {
    const replies = fakePane([capture("submitted")]);
    expect((await send()).status).toBe("sent");
    expect(submitKeys(replies)).toHaveLength(1);
  });

  it("keeps the draft when no pane read after Enter succeeds, since nothing proves the send", async () => {
    const replies = fakePane([capture("submitted")]);
    let reads = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () =>
        submitKeys(replies).length > 0 ? HttpResponse.error() : (reads++, HttpResponse.json({ paneId: "w1V:p1", text: capture("autocomplete") })),
      ),
    );
    expect(await send()).toMatchObject({ status: "error", textDelivered: true });
    expect(reads).toBeGreaterThan(0);
    expect(submitKeys(replies)).toHaveLength(1);
  });
});
