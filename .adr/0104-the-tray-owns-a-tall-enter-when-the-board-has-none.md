# 0104: the tray owns a tall Enter when the board has none

- **Status:** Accepted
- **Date:** 2026-10-16
- **Shipped in:** pending
- **Amends in scope:** [ADR 0092](./0092-the-keys-pad-is-a-board-you-arrange.md), the paragraph "The
  Default changes shape slightly", the 1 to 3 column span, and the core keys named in "Losing Esc is
  made loud"
- **Trail:** the owner, 2026-10-16: in the Keys tray "Enter moved to the left, before it was on the
  right, big", and the new layout looked crooked · issue 263 (Enter apart from the arrows: a miss on an
  arrow is reversible, a miss on Enter confirms a prompt) · `web/src/components/nav-tray.tsx` ·
  `web/src/lib/key-board.ts` (`DEFAULT_BOARD`, `CORE_KEYS`, `MAX_W`, `holdsStep`) ·
  `web/src/components/key-board-editor.tsx` · DESIGN.md section 6 (the 44px tap floor)

## Context

ADR 0092 made the pad a board of 7 columns and kept the Default as "today's pad". It could not keep
one thing: the old pad set a tall, tinted Enter on an eighth column at the right edge, past a gap, and
seven columns have no room for that without moving a key of row 1. So the Default put Enter at the far
left of row 2, with a three-cell Space between it and the arrows.

That kept issue 263's separation, and it moved the key a thumb finds most often. The owner's reading of
the result was that Enter had moved left, lost its size, and left the pad lopsided. The separation was
the right reason and the wrong cost: Enter was part of the board only because the board was the only
thing that drew keys.

## Decision

**The tray, not the board, owns a commit Enter.** When the board holds no key that is exactly the one
step `Enter`, the tray lays out 7 board columns, a spacer column and one more column, and draws a tall
Enter there: tinted with the primary colour at rest, an icon and a small caption, spanning the first
two rows (one on a one-row board). The spacer and the Enter column stay past the board, so nothing in
row 1 moves and Enter stands a gap away from the arrows, which is what 263 asked for.

**A board that places its own Enter draws it there and gets no second one.** The presets keep their own
Enter in cell 7 and Space three cells wide in cell 8, on 7 columns, as before. A person who adds an Enter
to the Default sees the tray's drop away and theirs stand in its place; one who removes it gets the
tray's back. The test is the board's content (`holdsStep(board, "Enter")`), never a flag, so a stored
board, an imported code and a preset all follow the same rule with no new field and no schema change.

**The Default drops Enter and Space takes four cells.** Row 2 is Space across cells 7 to 10, then Left,
Down and Right under Up. A key may span up to 4 columns (`MAX_W` 4, `KeyWidth` 1 to 4, the editor's
Width 1 to 4), so a person can build the same Space bar. A layout code with a width of 4 is read; 5 is
still refused. `collie-keys:2:` and `v: 2` are unchanged: a width of 4 is a number in the existing slot.

**Enter leaves the core keys.** The tray draws one whenever the board has none, so Enter is never
missing and is never put back: the editor's quiet line names only Esc and the arrows.

**The tap floor is bought as hit area, as the pad already did.** With the extra columns a key is about
40px wide on a 390px phone, so a key's `::before` reaches 2px into each side gap and 4px above and below
(DESIGN.md section 6), 44px in both axes. The spacer is 8px and the Enter column 1.25 fractions, so Enter
stays visibly wider than a key and a gap wider than the keys' own stands between it and the arrows.

## Consequences

- The Default is again what the owner remembers: row 1 Esc to ^C, row 2 Space and the arrows, and a tall
  Enter on the right.
- Two surfaces draw the Default now: the tray (board plus commit column) and the editor, which draws
  the board alone and shows no Enter for the Default. A person editing the Default cannot select the
  tray's Enter. Adding an Enter to the board is the way to move it, and that is a feature of the
  rule above, not a gap.
- Nothing is stored for the Default, so a person on it gets the new one. A person who had edited the
  1.21 Default has a stored board that holds an Enter: it keeps it and draws no commit column.
- Reopen this if a second key wants to be set apart the same way (a general "outside the board" area
  would then be the better model), or if the editor must let a person place the tray's Enter.
