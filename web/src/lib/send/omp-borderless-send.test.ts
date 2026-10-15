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

/** A pane whose screen after the n-th submit key is given; the typed text brings the `@` menu up. */
function fakePane(afterSubmit: string[]) {
  let screen = capture("empty");
  let submits = 0;
  const replies: Reply[] = [];
  server.use(
    http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: "w1V:p1", text: screen })),
    http.post<never, Reply>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
      const body = await request.json();
      replies.push(body);
      if (body.submit === true && body.text === "") screen = afterSubmit[Math.min(submits++, afterSubmit.length - 1)]!;
      else screen = capture("autocomplete");
      return HttpResponse.json({ ok: true });
    }),
  );
  return replies;
}

const send = () =>
  sendGuardedReply({ paneId: "w1V:p1", agent: "omp", text: TEXT, requestedLines: 200, sleep: async () => {} });

describe("omp 18.10 borderless send: the message must leave the prompt before it is reported sent", () => {
  it("presses Enter again when the first one only accepted the `@` completion", async () => {
    const replies = fakePane([capture("completion-accepted"), capture("submitted")]);
    expect((await send()).status).toBe("sent");
    const submits = replies.filter((r) => r.submit === true && r.text === "");
    expect(submits).toHaveLength(2);
    // The second Enter is bound to the prompt the retry read, completion included.
    expect(submits[0]!.expected_prompt).toBe("› reply ok @READ");
    expect(submits[1]!.expected_prompt).toBe("› reply ok @README.md");
  });

  it("keeps the draft and says so when the message is still in the prompt after the retry", async () => {
    const replies = fakePane([capture("completion-accepted")]);
    const result = await send();
    expect(result).toMatchObject({ status: "error", textDelivered: true });
    expect(replies.filter((r) => r.submit === true && r.text === "")).toHaveLength(2);
  });

  it("reports sent after one Enter when the prompt is empty again", async () => {
    const replies = fakePane([capture("submitted")]);
    expect((await send()).status).toBe("sent");
    expect(replies.filter((r) => r.submit === true && r.text === "")).toHaveLength(1);
  });
});
