import { mkdirSync } from "node:fs";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub, installUploadCapability } from "./fixtures/api";

// THE COMPOSER STACKS ITS TWO BUTTONS BESIDE A TALL DRAFT (ADR 0057, amended 2026-10-19), measured in
// a real engine. jsdom (`components/composer.test.tsx`) models the field's height by hand, so this is
// the check that the real layout does what that model says: the default one-line box is the 44px row
// it always was, a draft of three lines or more puts attach over the primary action, nothing remounts
// or loses the caret on the way, and the state cannot flip-flop because the freed width rewraps the
// text.
//
// Geometry only, never a pixel. Screenshots go to SHOTS when it is set, for a human to look at.
test.use({ serviceWorkers: "block" });

const SHOTS = process.env.COMPOSER_STACK_SHOTS;

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no composer");
  await installApiStub(page);
});

const field = (page: Page) => page.getByRole("textbox", { name: en["composer.placeholder.reply"] });
const group = (page: Page) => page.locator('[data-slot="composer-buttons"]');
const box = (page: Page) => page.locator('[data-slot="composer-box"]');
const attach = (page: Page) => page.getByRole("button", { name: en["composer.attach.aria"] });
const primary = (page: Page) => group(page).locator("button").last();

async function open(page: Page) {
  await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
  await expect(field(page)).toBeVisible();
}

async function rect(locator: Locator) {
  const r = await locator.boundingBox();
  expect(r).not.toBeNull();
  return r!;
}

const stacked = (page: Page) => group(page).evaluate((el) => el.getAttribute("data-stacked") === "true");


/** Records every change of the group's layout from now on, as a comma list on `<body>`. */
async function watchFlips(page: Page) {
  await page.evaluate(() => {
    const g = document.querySelector('[data-slot="composer-buttons"]')!;
    document.body.dataset.flips = "";
    new MutationObserver(() => {
      document.body.dataset.flips += `${g.getAttribute("data-stacked") ?? "?"},`;
    }).observe(g, { attributes: true, attributeFilter: ["data-stacked"] });
  });
}

/** The changes since the last call, then forgets them. */
async function takeFlips(page: Page): Promise<string[]> {
  const list = await page.evaluate(() => {
    const out = document.body.dataset.flips ?? "";
    document.body.dataset.flips = "";
    return out;
  });
  return list.split(",").filter((x) => x !== "");
}

/** Distinct short rows: each one is one visual line at any width this suite uses. */
const rows = (n: number) => Array.from({ length: n }, (_, i) => `row ${String(i + 1)}`).join("\n");

async function shot(page: Page, name: string, testInfo: { project: { name: string } }) {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-${name}.png` });
}

test("the empty box and one or two lines stay the one-row box; three lines stack attach over the primary action", async ({ page }, testInfo) => {
  await open(page);
  const emptyBox = await rect(box(page));
  expect(await stacked(page)).toBe(false);
  const a0 = await rect(attach(page));
  const p0 = await rect(primary(page));
  expect(Math.abs(a0.y - p0.y)).toBeLessThan(1);
  expect(p0.x).toBeGreaterThan(a0.x);
  await shot(page, "empty", testInfo);

  await field(page).fill("one line");
  expect(await stacked(page)).toBe(false);
  expect((await rect(box(page))).height).toBeCloseTo(emptyBox.height, 0);
  await shot(page, "one-line", testInfo);

  await field(page).fill(rows(2));
  expect(await stacked(page)).toBe(false);
  await shot(page, "two-lines", testInfo);
  const fieldAtTwo = await rect(field(page));

  await field(page).fill(rows(3));
  await expect(group(page)).toHaveAttribute("data-stacked", "true");
  const a1 = await rect(attach(page));
  const p1 = await rect(primary(page));
  // Over, not beside: the same column, attach entirely above the primary action, both 36px faces.
  expect(a1.y + a1.height).toBeLessThanOrEqual(p1.y);
  expect(Math.abs(a1.x - p1.x)).toBeLessThan(1);
  expect(Math.abs(a1.width - p1.width)).toBeLessThan(1);
  // The primary action is still at the box's bottom edge, where a thumb is, and the field is wider.
  const boxRect = await rect(box(page));
  expect(boxRect.y + boxRect.height - (p1.y + p1.height)).toBeLessThan(6);
  expect((await rect(field(page))).width).toBeGreaterThan(fieldAtTwo.width + 30);
  // Stacking does not grow the box to speak of: it is the three-line field plus its padding and
  // border, give or take the pixel by which a face with a tighter line height leaves the field (3 x
  // line + 12) under the 76px column.
  expect(boxRect.height).toBeLessThanOrEqual((await rect(field(page))).height + 12);
  await shot(page, "three-lines", testInfo);
});

test("a long dictated paragraph stacks, and the field takes the width the column gave back", async ({ page }, testInfo) => {
  await open(page);
  const before = (await rect(field(page))).width;
  await field(page).fill("This is what a dictated message looks like when it runs on and on past two lines of a phone sized composer, with plenty of words in it. ".repeat(2));
  await expect(group(page)).toHaveAttribute("data-stacked", "true");
  expect((await rect(field(page))).width).toBeGreaterThan(before + 30);
  await shot(page, "dictated", testInfo);
});

test("typing across the boundary one key at a time toggles once, keeps the caret and remounts nothing", async ({ page }) => {
  await open(page);
  await field(page).click();
  const tagged = await page.evaluate(() => {
    const els = [document.querySelector('[data-slot="chat-input"]'), ...document.querySelectorAll('[data-slot="composer-buttons"] button')];
    els.forEach((el, i) => el?.setAttribute("data-probe", String(i)));
    return els.length;
  });
  expect(tagged).toBe(3);
  await watchFlips(page);

  const text = "word ".repeat(70);
  await page.keyboard.type(text, { delay: 3 });
  await expect(group(page)).toHaveAttribute("data-stacked", "true");
  expect(await takeFlips(page)).toEqual(["true"]);

  // Nothing was rebuilt, and the caret is where the typing left it, still in the field.
  const state = await page.evaluate(() => {
    const f = document.querySelector<HTMLTextAreaElement>('[data-slot="chat-input"]')!;
    return {
      same: [...document.querySelectorAll("[data-probe]")].length,
      focused: document.activeElement === f,
      caretAtEnd: f.selectionStart === f.value.length,
    };
  });
  expect(state).toEqual({ same: 3, focused: true, caretAtEnd: true });

  // And back down, a key at a time: it lets go once, when the draft is down to one line.
  await page.keyboard.down("Backspace");
  for (let i = 0; i < text.length; i++) await page.keyboard.press("Backspace");
  await page.keyboard.up("Backspace");
  await expect(group(page)).toHaveAttribute("data-stacked", "false");
  expect(await takeFlips(page)).toEqual(["false"]);
});

test("sweeping the draft length through the boundary never flips more than once per direction", async ({ page }) => {
  await open(page);
  await watchFlips(page);
  // Every length from 20 to 160 characters, set directly, grown and then shrunk: wherever the wrap
  // lands at the phone's width, a flip-flop would show as an extra record.
  for (let n = 20; n <= 160; n += 1) await field(page).fill("x ".repeat(n / 2));
  expect((await takeFlips(page)).length).toBeLessThanOrEqual(1);
  for (let n = 160; n >= 0; n -= 1) await field(page).fill("x ".repeat(n / 2));
  expect((await takeFlips(page)).length).toBeLessThanOrEqual(1);
  expect(await stacked(page)).toBe(false);
});

test("a draft at the field's cap scrolls inside it, stays stacked and keeps both buttons on screen", async ({ page }, testInfo) => {
  await open(page);
  await field(page).fill(rows(60));
  await expect(group(page)).toHaveAttribute("data-stacked", "true");
  const scrolls = await field(page).evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(scrolls).toBe(true);
  const viewport = page.viewportSize()!;
  for (const b of [attach(page), primary(page)]) {
    const r = await rect(b);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y + r.height).toBeLessThanOrEqual(viewport.height);
    expect(r.x + r.width).toBeLessThanOrEqual(viewport.width);
  }
  await shot(page, "capped", testInfo);
});

test("the attach picker opens above the box in both layouts, right-aligned to it", async ({ page }, testInfo) => {
  await installUploadCapability(page);
  await open(page);
  for (const [name, text] of [["row", ""], ["column", rows(4)]] as const) {
    await field(page).fill(text);
    await expect(group(page)).toHaveAttribute("data-stacked", name === "column" ? "true" : "false");
    await attach(page).click();
    const panel = page.getByRole("dialog", { name: en["composer.attach.title"] });
    await expect(panel).toBeVisible();
    const p = await rect(panel);
    const b = await rect(box(page));
    expect(p.y + p.height).toBeLessThanOrEqual(b.y + 1);
    expect(Math.abs(p.x + p.width - (b.x + b.width))).toBeLessThan(2);
    await shot(page, `picker-${name}`, testInfo);
    if (name === "column") {
      // The picker's backdrop is a screen-wide button inside the group; it is no control, so a reading
      // taken while it is open (the draft shrinks to a line) still lets the column go.
      await field(page).fill("x");
      await expect(group(page)).toHaveAttribute("data-stacked", "false");
    }
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  }
});

test("a chip strip stays above the row, and a tall draft beside it still stacks", async ({ page }, testInfo) => {
  await installUploadCapability(page);
  await open(page);
  await page.getByTestId("attach-photos").setInputFiles({ name: "a.png", mimeType: "image/png", buffer: Buffer.from("x") });
  const chips = page.getByRole("list", { name: en["composer.attach.listAria"] });
  await expect(chips).toBeVisible();
  await field(page).fill(rows(4));
  await expect(group(page)).toHaveAttribute("data-stacked", "true");
  const c = await rect(chips);
  const f = await rect(field(page));
  const g = await rect(group(page));
  expect(c.y + c.height).toBeLessThanOrEqual(f.y + 1);
  expect(c.y + c.height).toBeLessThanOrEqual(g.y + 1);
  expect(f.x + f.width).toBeLessThanOrEqual(g.x + 1);
  await shot(page, "chips", testInfo);
});

test("hand left: the column stands at the box's left edge, attach over the primary action", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("collie:display-prefs:v4", JSON.stringify({ hand: "left" })));
  await open(page);
  const a0 = await rect(attach(page));
  const p0 = await rect(primary(page));
  // Mirrored row: Send on the outer (left) edge, then attach, then the field.
  expect(p0.x).toBeLessThan(a0.x);
  await field(page).fill(rows(4));
  await expect(group(page)).toHaveAttribute("data-stacked", "true");
  const a1 = await rect(attach(page));
  const p1 = await rect(primary(page));
  const b = await rect(box(page));
  const f = await rect(field(page));
  expect(a1.y + a1.height).toBeLessThanOrEqual(p1.y);
  expect(Math.abs(a1.x - p1.x)).toBeLessThan(1);
  expect(a1.x - b.x).toBeLessThan(10);
  expect(f.x).toBeGreaterThan(a1.x + a1.width);
  await shot(page, "hand-left", testInfo);
});

test("a long German placeholder leaves the empty box one row, and a tall draft still stacks", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("collie:locale:v1", "de"));
  await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
  const textbox = page.locator('[data-slot="chat-input"]');
  await expect(textbox).toBeVisible();
  const emptyHeight = (await rect(box(page))).height;
  expect(await stacked(page)).toBe(false);
  // The placeholder, however long its translation, does not make the empty box taller than a one-line draft.
  await textbox.fill("x");
  expect((await rect(box(page))).height).toBeCloseTo(emptyHeight, 0);
  await textbox.fill(rows(4));
  await expect(group(page)).toHaveAttribute("data-stacked", "true");
});

test("a desktop width stacks the same way", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  expect(await stacked(page)).toBe(false);
  await field(page).fill(rows(5));
  await expect(group(page)).toHaveAttribute("data-stacked", "true");
  const a = await rect(attach(page));
  const p = await rect(primary(page));
  expect(a.y + a.height).toBeLessThanOrEqual(p.y);
  await shot(page, "desktop", testInfo);
});
