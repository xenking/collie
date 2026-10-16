import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// The Keys tray's pad, measured in a real engine. jsdom (`components/nav-tray.test.tsx`) can only
// pin the CLASSES that produce the layout — it never lays anything out — so this is the check that
// the classes actually did what they were meant to on a real phone viewport.
//
// Two faults shipped in 6d7e701a: Enter's `row-span-2` was overridden back to one 36px row by the
// shared `h-9` every key gets (tailwind-merge resolves same-group conflicts by class order, and
// `h-9` used to win), and "Ctrl C" was wider than its 1/7 column at 390px. The fix is a stretch
// class on Enter alone plus explicit grid row heights, and a shorter "^C" label — see nav-tray.tsx.
//
// No pairing, no device, no second machine: the Keys dock only writes into a pane through
// `POST /api/pane/:id/keys`, which the stub answers unconditionally (`{ ok: true }`), so opening it
// against a fixture pane costs nothing this suite doesn't already pay elsewhere.
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("states"),
    "the playground has no /api/pane/:id route and no Keys dock to open",
  );
  await installApiStub(page);
});

test("Space spans four columns, Enter spans both rows and no key's label overflows its column", async ({ page }) => {
  // w1:p1 is the default fixture agent pane (`src/test/handlers.ts`), writable with no capability
  // declared false, so the Keys toggle in its composer is enabled with no further setup.
  await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
  await expect(page.getByRole("textbox", { name: en["composer.placeholder.reply"] })).toBeVisible();

  await page.getByRole("button", { name: en["composer.controls.keys"] }).click();

  // exact: true throughout — the pad's short one-word labels ("Up", "Tab", "Down"…) are substrings
  // of unrelated chrome elsewhere on the page (the tab strip's "needs you tab", "New tab"…), and
  // Playwright's default role-name match is a case-insensitive CONTAINS, not an equals.
  const up = page.getByRole("button", { name: "Up", exact: true });
  const space = page.getByRole("button", { name: "Space", exact: true });
  await expect(up).toBeVisible();
  await expect(space).toBeVisible();

  const [upBox, spaceBox] = await Promise.all([up.boundingBox(), space.boundingBox()]);
  expect(upBox).not.toBeNull();
  expect(spaceBox).not.toBeNull();
  // The default pad's Space is four cells wide, one row tall (ADR 0092). Four columns plus three gaps
  // is ~4.1x one key; 3.6x is the floor a regression to one cell (1x) or a lost span class would fail.
  expect(spaceBox!.width).toBeGreaterThanOrEqual(upBox!.width * 3.6);
  expect(spaceBox!.height).toBeLessThanOrEqual(upBox!.height * 1.2);

  // Every single-cell key reaches the 44px floor by hit area (DESIGN.md section 6): the ::before
  // reaches 2px into each side gap and 4px above and below, past the 1px border. elementFromPoint proves the reach is not
  // clipped (an overflow clip on the key would cut it).
  const hit = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const n of ["Esc", "Up", "Left", "Right"]) {
      const el = document.querySelector<HTMLElement>(`button[aria-label='${n}']`)!;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el, "::before");
      // The inset is from the padding box, inside the border, so the reach is the inset less the border.
      const b = parseFloat(getComputedStyle(el).borderLeftWidth);
      out[n] = [r.width - parseFloat(cs.left) - parseFloat(cs.right) - 2 * b, r.height - parseFloat(cs.top) - parseFloat(cs.bottom) - 2 * b].map((v) => v.toFixed(1)).join("x");
    }
    const left = document.querySelector("button[aria-label='Left']")!.getBoundingClientRect();
    const probe = document.elementFromPoint(left.right + 1, left.y + left.height / 2);
    out.rightOfLeft = probe?.getAttribute("aria-label") ?? "none";
    return out;
  });
  for (const n of ["Esc", "Up", "Left", "Right"]) {
    const [w, h] = hit[n].split("x").map(Number);
    expect(w, `${n} hit width`).toBeGreaterThanOrEqual(43.9);
    expect(h, `${n} hit height`).toBeGreaterThanOrEqual(43.9);
  }
  expect(hit.rightOfLeft, "the gap beside Left is Left's own reach").toBe("Left");

  // The tray's own Enter stands at the right edge, past the board, and spans both rows.
  const enterBox = await page.getByRole("button", { name: "Enter", exact: true }).boundingBox();
  expect(enterBox).not.toBeNull();
  expect(enterBox!.x).toBeGreaterThanOrEqual(upBox!.x + upBox!.width);
  expect(enterBox!.height).toBeGreaterThanOrEqual(upBox!.height * 1.8);

  // Every key on the fixed pad, including the quick "^C": none may scroll its own content.
  const keyNames = ["Esc", "Tab", "Shift", "Ctrl", "Alt", "Up", "Ctrl+C", "Space", "Left", "Down", "Right", "Enter"];
  // The key's CONTENT must stay inside its drawn box. The button's own scrollWidth is no test: it
  // counts the transparent ::before that reaches the 44px tap floor (2px past each side).
  const overflowing: string[] = [];
  for (const name of keyNames) {
    const bad = await page.getByRole("button", { name, exact: true }).evaluate((el) => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll("*")].some((c) => {
        const r = c.getBoundingClientRect();
        return c.scrollWidth > c.clientWidth || r.left < box.left - 0.5 || r.right > box.right + 0.5;
      });
    });
    if (bad) overflowing.push(name);
  }
  expect(overflowing, "keys whose content overflows their box").toEqual([]);
});
