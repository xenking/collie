// pi-o-my's statusline-below patch paints omp's borderless composer with a `›` gutter, and omp 18.10
// keeps a blank row between the prompt block and the status row. Both are read here off captures taken
// from a real omp 18.10.0 pane (`herdr pane read --format ansi`, 2026-10-16, a temp git dir):
//
//   - `empty`, `fresh-hint`, `working`, `submitted`: the idle, first-run, streaming and just-sent screens
//   - `autocomplete`, `autocomplete-many`, `slash-palette`: the `@` menu and the slash palette, which
//     REPLACE the status row while they are up
//   - `completion-accepted`: what is left in the prompt when Enter accepted the `@` completion instead
//     of submitting it
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { ompAdapter } from "../omp";

const PANES = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const screen = (name: string) =>
  splitLines(parseAnsi(readFileSync(join(PANES, `omp--v18-10-borderless-glyph-${name}.txt`), "utf8")));

describe("omp 18.10 borderless composer with the `›` gutter (real captures)", () => {
  it.each(["empty", "fresh-hint", "working", "submitted"])("%s: the composer is ready and holds no draft", (name) => {
    const lines = screen(name);
    expect(ompAdapter.composerReady!(lines)).toBe(true);
    expect(ompAdapter.extractInputDraft(lines)).toBeNull();
  });

  it("reads the stranded text left by an Enter that only accepted the completion", () => {
    const lines = screen("completion-accepted");
    expect(ompAdapter.composerReady!(lines)).toBe(true);
    expect(ompAdapter.extractInputDraft(lines)).toBe("reply ok @README.md");
  });

  it.each([
    ["autocomplete", "reply ok @READ"],
    ["autocomplete-many", "see @"],
    ["slash-palette", "/co"],
  ])("%s: reads the draft while the menu stands in for the status row", (name, draft) => {
    const lines = screen(name);
    expect(ompAdapter.composerReady!(lines)).toBe(true);
    expect(ompAdapter.extractInputDraft(lines)).toBe(draft);
  });

  it("binds a write to the prompt while a short menu is up, and declines to when the palette is long", () => {
    expect(ompAdapter.composerPrompt!(screen("autocomplete"))).toBe("› reply ok @READ");
    expect(ompAdapter.composerPrompt!(screen("slash-palette"))).toBeNull();
  });
});
