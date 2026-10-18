import { describe, expect, it } from "vitest";

import { nextStacked, RELEASE_MAX_WIDTH_RATIO, STACK_AT_LINES, UNSTACK_AT_LINES } from "./use-stacked-actions";

const read = (lines: number, widthRatio = 1, empty = false) => ({ lines, widthRatio, empty });

// The hysteresis, as a model. A line holds `perLine` characters in the row and `perLine + gained` in
// the column; the text is `n` characters. Whatever the starting state and the draft, re-reading after
// each toggle must settle within one change: a second change is a flicker. The ratio the hook
// measures is the column's width over the row's, as the model has it.
function settle(start: boolean, n: number, perLine: number, gained: number): boolean[] {
  const states = [start];
  for (let step = 0; step < 6; step++) {
    const last = states[states.length - 1]!;
    const lines = Math.max(1, Math.ceil(n / (last ? perLine + gained : perLine)));
    const next = nextStacked(last, { lines, empty: n === 0, widthRatio: (perLine + gained) / perLine });
    if (next === last) break;
    states.push(next);
  }
  return states;
}

describe("nextStacked", () => {
  it("enters at three lines and leaves at one", () => {
    expect([1, 2].map((l) => nextStacked(false, read(l)))).toEqual([false, false]);
    expect(nextStacked(false, read(STACK_AT_LINES))).toBe(true);
    expect([2, 3, 40].map((l) => nextStacked(true, read(l)))).toEqual([true, true, true]);
    expect(nextStacked(true, read(UNSTACK_AT_LINES))).toBe(false);
  });

  it("an empty draft always leaves, and never enters", () => {
    expect(nextStacked(true, read(40, 3, true))).toBe(false);
    expect(nextStacked(false, read(40, 1, true))).toBe(false);
  });

  it("holds a one-line draft while the column made the field much wider than the row (a long word as the primary action)", () => {
    expect(nextStacked(true, read(1, RELEASE_MAX_WIDTH_RATIO))).toBe(false);
    expect(nextStacked(true, read(1, RELEASE_MAX_WIDTH_RATIO + 0.01))).toBe(true);
  });

  it("settles in at most one change for every draft length, line width and starting state", () => {
    // `gained` is the width a freed button returns, from a sliver to as much as a whole line, so
    // the narrow field of a long-worded primary action is in the sweep too.
    for (const perLine of [4, 8, 12, 20, 28, 40]) {
      for (const gained of [1, 3, 5, 8, perLine, perLine * 2]) {
        for (let n = 0; n <= perLine * 12; n++) {
          for (const start of [false, true]) {
            expect(settle(start, n, perLine, gained).length, `n=${String(n)} perLine=${String(perLine)} gained=${String(gained)} start=${String(start)}`).toBeLessThanOrEqual(2);
          }
        }
      }
    }
  });
});
