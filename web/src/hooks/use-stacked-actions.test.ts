import { describe, expect, it } from "vitest";

import { nextStacked, STACK_AT_LINES, UNSTACK_AT_LINES } from "./use-stacked-actions";

// The hysteresis, as a model. A line holds `perLine` characters beside the row's two buttons and
// `perLine + gained` beside a column's one; the text is `n` characters. Whatever the starting state
// and the draft, re-reading after each toggle must settle within one change: a second change is a
// flicker.
function settle(start: boolean, n: number, perLine: number, gained: number): boolean[] {
  const states = [start];
  for (let step = 0; step < 6; step++) {
    const last = states[states.length - 1]!;
    const lines = Math.max(1, Math.ceil(n / (last ? perLine + gained : perLine)));
    const next = nextStacked(last, lines);
    if (next === last) break;
    states.push(next);
  }
  return states;
}

describe("nextStacked", () => {
  it("enters at three lines and leaves at one", () => {
    expect([1, 2].map((l) => nextStacked(false, l))).toEqual([false, false]);
    expect(nextStacked(false, STACK_AT_LINES)).toBe(true);
    expect([2, 3, 40].map((l) => nextStacked(true, l))).toEqual([true, true, true]);
    expect(nextStacked(true, UNSTACK_AT_LINES)).toBe(false);
  });

  it("settles in at most one change for every draft length, line width and starting state", () => {
    // `gained` is the width a freed button returns, as a share of a line: from a sliver to well past
    // the 40px of a real phone (about 1/6 of a line at 390px).
    for (const perLine of [12, 20, 28, 40]) {
      for (const gained of [1, 3, 5, 8, perLine]) {
        for (let n = 0; n <= perLine * 12; n++) {
          for (const start of [false, true]) {
            expect(settle(start, n, perLine, gained).length, `n=${String(n)} perLine=${String(perLine)} gained=${String(gained)} start=${String(start)}`).toBeLessThanOrEqual(2);
          }
        }
      }
    }
  });
});
