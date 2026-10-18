import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

import { hasResizeObserver } from "@/lib/env";

/**
 * The visual line count at which the composer stacks its two buttons, measured at the UNSTACKED
 * width: three lines is clearly past two, and the one-line default box never reaches it.
 */
export const STACK_AT_LINES = 3;

/**
 * The line count at or under which a stacked composer lets its buttons back into the row, measured
 * at the STACKED width. It is lower than {@link STACK_AT_LINES} minus one on purpose, and that gap is
 * the whole of the hysteresis: stacking frees a button's width, so the same draft wraps to fewer
 * lines. If the box un-stacked at two lines it would narrow the field, wrap the draft to three, and
 * stack again, for ever. A draft of one line at the stacked width wraps to at most two at the
 * unstacked one (the width the row gives back is under one line's worth), so it can never meet
 * {@link STACK_AT_LINES}; the two states cannot chase each other.
 */
export const UNSTACK_AT_LINES = 1;

/** The next state from the last one and the visual line count the field reads at its current width. */
export function nextStacked(stacked: boolean, lines: number): boolean {
  return stacked ? lines > UNSTACK_AT_LINES : lines >= STACK_AT_LINES;
}

// What a `line-height: normal` field measures when the engine hands back the keyword instead of a
// length: the font's own metrics are not readable from script, 1.2 is what the fonts this app
// names resolve to. Only ever the fallback; the stylesheet sets a numeric line height.
const NORMAL_LINE_HEIGHT = 1.2;

/**
 * The visual lines a textarea's draft occupies now: its content height (scroll height less the
 * field's own vertical padding) over its computed line height, so the operator's draft font size
 * and face are already in the answer. Scroll height, not client height, so a field at its cap, which
 * scrolls inside itself, still reports every line it holds. Never under one.
 */
export function draftLines(field: HTMLTextAreaElement): number {
  const style = getComputedStyle(field);
  const fontPx = Number.parseFloat(style.fontSize);
  const declared = Number.parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(declared) ? declared : fontPx * NORMAL_LINE_HEIGHT;
  const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  if (!(lineHeight > 0)) return 1;
  return Math.max(1, Math.round((field.scrollHeight - padding) / lineHeight));
}

/**
 * Whether the composer's attach and primary buttons stand in a column beside a tall draft instead
 * of in the row. Measured after layout on every draft change, and again whenever the field's own box
 * changes size (a rotation, a keyboard, a draft-size setting), so the state is settled before paint.
 * It only ever drives a class: nothing remounts, so the field keeps its caret.
 */
export function useStackedActions(field: RefObject<HTMLTextAreaElement | null>, draft: string): boolean {
  const [stacked, setStacked] = useState(false);
  const measure = useCallback(() => {
    const el = field.current;
    if (el === null) return;
    const lines = draftLines(el);
    setStacked((was) => nextStacked(was, lines));
  }, [field]);
  useLayoutEffect(measure, [measure, draft]);
  useEffect(() => {
    const el = field.current;
    if (el === null || !hasResizeObserver()) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [field, measure]);
  return stacked;
}
