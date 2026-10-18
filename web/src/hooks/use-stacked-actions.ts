import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { hasResizeObserver } from "@/lib/env";

/**
 * The visual line count at which the composer stacks its two buttons, measured at the UNSTACKED
 * width: three lines is clearly past two, and the one-line default box never reaches it.
 */
export const STACK_AT_LINES = 3;

/**
 * The line count at or under which a stacked composer may let its buttons back into the row,
 * measured at the STACKED width. It is lower than {@link STACK_AT_LINES} minus one on purpose, and
 * that gap is the hysteresis: stacking frees a button's width, so the same draft wraps to fewer
 * lines. If the box un-stacked at two lines it would narrow the field, wrap the draft to three, and
 * stack again, for ever. A one-line draft at the stacked width is at most `ratio` lines at the row's,
 * where `ratio` is how much wider the stacked field is, so while that stays under
 * {@link RELEASE_MAX_WIDTH_RATIO} it cannot reach {@link STACK_AT_LINES}.
 */
export const UNSTACK_AT_LINES = 1;

/**
 * The widest the stacked field may be, as a multiple of its width in the row, for the column to let
 * go of a one-line draft. The width a column frees is fixed (the attach button and a gap, about 40px),
 * so on an ordinary phone the ratio is about 1.2. When the primary action is a long translated word
 * and the row leaves the field a sliver, the same 40px is most of its width: a short draft is one
 * line in the column and could be three in the row, and releasing it would flip the box for ever.
 * Past this ratio the column holds until the draft is empty or sent. 1.5 keeps a one-line draft to
 * two lines in the row, even counting the space a long word wastes at a line's end.
 */
export const RELEASE_MAX_WIDTH_RATIO = 1.5;

/** What the field reads now: how many lines, whether it is empty, and how much wider it stands stacked than it would in the row (1 when unmeasurable). */
export interface StackReading {
  readonly lines: number;
  readonly empty: boolean;
  readonly widthRatio: number;
}

/** The next state from the last one and what the field reads at its current width. */
export function nextStacked(stacked: boolean, reading: StackReading): boolean {
  if (reading.empty) return false;
  if (!stacked) return reading.lines >= STACK_AT_LINES;
  return reading.lines > UNSTACK_AT_LINES || reading.widthRatio > RELEASE_MAX_WIDTH_RATIO;
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
 *
 * The widths come from the DOM, not from a constant: what the column frees is read off the buttons
 * as they stand, so a primary action that is a long word is accounted for
 * ({@link RELEASE_MAX_WIDTH_RATIO}).
 */
export function useStackedActions(
  field: RefObject<HTMLTextAreaElement | null>,
  group: RefObject<HTMLElement | null>,
  draft: string,
): boolean {
  const [stacked, setStacked] = useState(false);
  // Read by `measure` and not a dependency of it, so the observer below is not torn down and
  // re-armed on every keystroke.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const measure = useCallback(() => {
    const el = field.current;
    const buttons = group.current;
    if (el === null || buttons === null) return;
    const reading: StackReading = {
      lines: draftLines(el),
      // The composer's own meaning of an empty draft (`hasDraft`): blank rows are not a message.
      empty: draftRef.current.trim() === "",
      widthRatio: buttons.dataset.stacked === "true" ? stackedWidthRatio(el, buttons) : 1,
    };
    setStacked((was) => nextStacked(was, reading));
  }, [field, group]);
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

/**
 * How much wider the stacked field is than it would be in the row. What the column frees is read off
 * the buttons as they stand now, so a primary action that changes while stacked is accounted for:
 * the row would hold every button side by side with the gap between them, the column holds the
 * widest one. 1 when nothing is measured (no layout) or the column freed nothing.
 */
function stackedWidthRatio(field: HTMLTextAreaElement, group: HTMLElement): number {
  const style = getComputedStyle(field);
  const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  const stackedWidth = field.clientWidth - padding;
  // The picker is absolutely positioned and takes no place in either layout.
  const widths = [...group.children].filter((el) => getComputedStyle(el).position !== "absolute").map((el) => el instanceof HTMLElement ? el.offsetWidth : 0);
  const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0;
  const freed = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1) - Math.max(0, ...widths);
  if (!(stackedWidth > 0) || !(freed > 0)) return 1;
  const rowWidth = stackedWidth - freed;
  return rowWidth > 0 ? stackedWidth / rowWidth : Number.POSITIVE_INFINITY;
}
