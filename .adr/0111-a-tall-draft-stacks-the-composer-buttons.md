# 0111: a tall draft stacks the composer buttons

- **Status:** Accepted
- **Date:** 2026-10-19
- **Shipped in:** pending
- **Amends in scope:** [ADR 0057](./0057-the-composer-is-one-box.md), the one row of "Amended
  2026-09-22" (decision 1: attach and the primary action inline)
- **Trail:** the owner, 2026-10-19: when dictating, text grows past two lines and the paperclip should
  move up above the record/stop/send button, because there is free room beside the text ·
  `web/src/components/composer.tsx` · `web/src/hooks/use-stacked-actions.ts` ·
  `web/e2e/composer-stack.spec.ts` · DESIGN.md section 2 (no state may move content)

## Context

A dictated message runs to many lines. The box is one row (ADR 0057): the field, then attach, then the
primary action, both buttons 36px and bottom-pinned. Beside a tall draft that leaves a 36px attach
button standing over empty room, and the field narrower than it needs to be.

## Decision

**When the draft is tall, attach and the primary action stand in a column, attach over the primary
action, and the field keeps the width the second button gave back. The empty box, one line and two
lines are exactly the row they were.**

1. **One group, one class.** Attach, the picker and every primary-action branch (voice control,
   answer-the-dialog, really-send, mic, Send) sit in one always-rendered `data-slot="composer-buttons"`
   element. Stacking changes its classes only (`flex-col items-center`, else `items-end`, reversed
   under `hand="left"`). Nothing remounts, the field is not touched, the caret and focus stay. The
   picker is absolute and the group is not `relative`, so it still anchors to the box and opens above it.
2. **Not by default.** Stacking an empty box was considered and declined: the column is 36 + 4 + 36
   tall, so an empty composer would stand at 76px instead of 44, a state that moves content on every
   empty box.
3. **Three lines stack; one line, or an empty draft, unstacks.** The line count is the field's scroll
   height less its padding over its computed line height, so the operator's draft size is included,
   read after layout on every draft change and on every resize of the field
   (`hooks/use-stacked-actions.ts`). It enters at three or more lines at the row's width and leaves at
   one line at the column's, or when the draft is empty or sent. A draft at the field's cap scrolls
   inside it and stays stacked.
4. **The gap between the two thresholds is what stops a flip-flop.** The column is wider for the
   field, so the same text wraps to fewer lines; a rule that left at two lines would narrow the
   field, wrap to three, and stack again, for ever. A one-line draft at the column's width is at most
   two lines at the row's while the column is under 1.5 times as wide as the row would leave the field.
   That ratio is measured, not assumed, and from the buttons as they stand on every reading: the row
   would hold every button side by side with the gap between them, the column holds the widest, and the
   difference is what the column freed. A primary action that changes while stacked (a long translated
   word in place of Send) is therefore in the sum at once, with no width remembered from an earlier
   layout. When such a word leaves the row a sliver of field, the ratio passes 1.5 and the column holds
   until the draft is empty.
5. **The gap is `gap-1`, as in the row.** The column is 76px tall, or 84 with the 44px voice control,
   never taller than the three-line field (84) that stacked it, so stacking does not grow the box. The
   two 4px hit-area reaches overlap in the gap as they do in the row; the later control wins.

## Consequences

- An empty box, one line and two lines are unchanged, so the default composer's height and the mirror
  above it do not move. Only a draft of three lines or more changes the layout, and it never makes the
  box taller.
- The field is wider by the attach button's width and a gap while stacked, about 40px, which is what
  the owner asked the room to be used for.
- A draft that shrinks from many lines to two keeps the column until it reads one line, so the buttons
  do not move on every deleted line; a draft the column cannot safely release (a long-worded primary
  action leaving a narrow row) holds the column until it is empty or sent.
- The layout reads the DOM on every draft change and on every resize of the field: one
  `scrollHeight` read per keystroke, and the group's button widths only while stacked.
- Revisit if a third control joins the group, if the primary action becomes a text button by default
  (the ratio bound then rules the column more often), or if the owner wants the column by default.

