// Per-pane composer drafts, persisted so a reply survives leaving the pane.
//
// The composer's input is phone-owned local state, and the pane view is keyed by paneId — so
// walking over to another tab to check something (the exact reason you're composing a reply in the
// first place) unmounted the composer and ate the draft. This is the tiny store that keeps it.
//
// **localStorage, not sessionStorage.** A phone PWA gets killed mid-composition by the OS all the
// time — backgrounded, memory pressure, screen off long enough — and sessionStorage dies with the
// page. The draft has to outlive the process, not just the navigation.
//
// Same storage-guard style as lib/haptics.ts: every access is behind a `typeof localStorage` check
// AND a try/catch, because Safari private mode throws on setItem rather than reporting quota. A
// draft is never important enough to break a render or a send.

import { normalizeScope, type Scope } from "./scope";

const PREFIX = "collie:draft:";

/** Drafts older than this are pruned on first use — an ancient half-thought must never resurface. */
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Upper bound per PERSISTED draft. Nobody types 8 KiB on a phone; a value that big is a paste gone
 *  wrong or a bug. Oversize is never truncated — a silently half-saved message that you then send is
 *  worse than no draft at all — and, since the memory tier below took over the job of surviving a
 *  remount, it is no longer merely skipped either: skipping LEFT THE PREVIOUS, SHORTER DRAFT in
 *  place, so pasting a long file over a short note and coming back showed the note. Wrong text is
 *  worse than no text, one tier up. See {@link fitsDraftStore} for the notice that narrates it. */
const MAX_CHARS = 8 * 1024;

/**
 * Ceiling on everything the memory tier holds at once, in characters. Bounded by TOTAL rather than
 * entry count because the count is operator-scale (the panes in a herd) while a single entry is
 * whatever got pasted — so the pathological session is a few huge files across a few panes, not many
 * small drafts. Oldest-first eviction, and never the entry being written.
 */
const MEMORY_MAX_CHARS = 4 * 1024 * 1024;

export interface DraftAttachment {
  path: string;
  name: string;
  size: number;
}

interface DraftEntry {
  text: string;
  at: number;
  attachments: DraftAttachment[];
}

function isDraftAttachment(value: unknown): value is DraftAttachment {
  if (typeof value !== "object" || value === null) return false;
  const attachment = value as Partial<DraftAttachment>;
  return (
    typeof attachment.path === "string" &&
    attachment.path.length > 0 &&
    typeof attachment.name === "string" &&
    attachment.name.length > 0 &&
    typeof attachment.size === "number" &&
    Number.isFinite(attachment.size) &&
    attachment.size >= 0
  );
}

function normalizeAttachments(attachments: readonly DraftAttachment[]): DraftAttachment[] {
  return attachments.filter(isDraftAttachment).map(({ path, name, size }) => ({ path, name, size }));
}

/**
 * The memory tier: this page-session's drafts, uncapped per entry, gone on reload.
 *
 * It exists because the disk tier refuses anything over {@link MAX_CHARS}, and "too big to persist"
 * should not also mean "lost when you glance at another pane". The pane view is keyed by paneId, so
 * a pane switch remounts the composer — this is what it remounts from.
 *
 * IT IS COVERED BY ADR 0017 ONLY BECAUSE EVERY WRITE AND CLEAR GOES THROUGH `saveDraft` /
 * `clearDraft`. The password-prompt gates live upstream of both (composer.tsx's `noEchoRef` guards
 * the keystroke write-through and the pane-leave save; the recognising outcome calls `clearDraft`),
 * so a recognised prompt reaches neither tier and purges both in the same tick. A cache written from
 * anywhere else — component state, a second module — would re-open #103 in RAM, where nothing is
 * gating it. Don't add one.
 *
 * No age prune, deliberately: `MAX_AGE_MS` exists because localStorage outlives the process and an
 * ancient half-thought resurfacing is jarring. A entry here cannot be older than this page session,
 * which is exactly how long the composer would have held it had it never unmounted.
 */
const memory = new Map<string, DraftEntry>();

// A pane id is unique only within one session on one machine, so a draft is keyed by the whole
// (host, session, paneId) triple — otherwise the draft you typed for `w1:p1` on one machine would be
// restored into `w1:p1` on another. The lead's keys are byte-identical to what shipped: the host
// segment is emitted only when there IS one, so every existing stored draft is still found. Both
// tiers key off this one function, so memory and disk can never disagree about which pane is which.
function keyFor(scope: Scope | undefined, paneId: string): string {
  const { host, session } = normalizeScope(scope);
  return `${PREFIX}${host ? `${host}@` : ""}${session ?? "default"}:${paneId}`;
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null; // SSR / blocked storage
  }
}

let pruned = false;

/** Drop expired entries. Runs once per page load, lazily on the first draft access. */
export function pruneDrafts(now: number = Date.now()): void {
  const store = storage();
  if (!store) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key === null || !key.startsWith(PREFIX)) continue;
      const raw = store.getItem(key);
      const entry = parse(raw);
      // Unparseable entries go too — a key we can't read is a key we can never clean up later.
      if (entry === null || now - entry.at > MAX_AGE_MS) stale.push(key);
    }
    for (const key of stale) store.removeItem(key);
  } catch {
    // Enumeration can throw in locked-down storage — nothing to do but leave the drafts be.
  }
}

function prunedOnce(): void {
  if (pruned) return;
  pruned = true;
  pruneDrafts();
}

function parse(raw: string | null): DraftEntry | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    // SAFETY: `value` was just checked to be a non-null object, so reading `text`/`at` off it is
    // defined behaviour; both are validated as the right primitive on the very next line before any
    // of them is used. `Partial` is what makes those two checks mandatory rather than assumed.
    const entry = value as Partial<DraftEntry> & { attachments?: unknown };
    if (typeof entry.text !== "string" || typeof entry.at !== "number") return null;
    if (entry.attachments === undefined) return { text: entry.text, at: entry.at, attachments: [] };
    if (!Array.isArray(entry.attachments) || !entry.attachments.every(isDraftAttachment)) return null;
    return { text: entry.text, at: entry.at, attachments: entry.attachments.map((attachment) => ({ ...attachment })) };
  } catch {
    return null;
  }
}

/** Whether a draft is small enough for the disk tier — i.e. whether it will survive the app closing.
 *  The composer renders a notice from this; it is the only honest warning the user gets. */
export function fitsDraftStore(text: string): boolean {
  return text.length <= MAX_CHARS;
}

/** The disk tier's entry for a pane, expiring (and removing) anything past MAX_AGE_MS. */
function loadStored(scope: Scope | undefined, paneId: string): DraftEntry | null {
  const store = storage();
  if (!store) return null;
  try {
    const entry = parse(store.getItem(keyFor(scope, paneId)));
    if (entry === null) return null;
    if (Date.now() - entry.at > MAX_AGE_MS) {
      store.removeItem(keyFor(scope, paneId));
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}
/**
 * The newer of the memory and disk entries for a pane, or null if neither tier has one.
 */
function loadEntry(scope: Scope | undefined, paneId: string): DraftEntry | null {
  prunedOnce();
  const cached = memory.get(keyFor(scope, paneId)) ?? null;
  const stored = loadStored(scope, paneId);
  if (cached === null) return stored;
  if (stored === null) return cached;
  return stored.at > cached.at ? stored : cached;
}

/**
 * The stored draft for a pane, or null if there is none (or it's expired/unreadable).
 *
 * The NEWER of the two tiers wins rather than memory unconditionally: another tab or a second app
 * instance writes only to disk, and this tier has never seen it. Memory wins every ordinary tie
 * because it is written first and holds what the disk tier refused.
 */
export function loadDraft(scope: Scope | undefined, paneId: string): string | null {
  return loadEntry(scope, paneId)?.text ?? null;
}

/** The uploaded-file metadata stored alongside the pane's draft. */
export function loadDraftAttachments(scope: Scope | undefined, paneId: string): DraftAttachment[] {
  return loadEntry(scope, paneId)?.attachments.map((attachment) => ({ ...attachment })) ?? [];
}

/**
 * Persist a pane's draft. Empty text with no attachments removes the key; attachment-only entries
 * remain persisted so a file can be sent without a textual message.
 */
export function saveDraft(
  scope: Scope | undefined,
  paneId: string,
  text: string,
  attachments: readonly DraftAttachment[] = [],
): void {
  prunedOnce();
  const storedAttachments = normalizeAttachments(attachments);
  if (text.trim() === "" && storedAttachments.length === 0) {
    clearDraft(scope, paneId);
    return;
  }
  const key = keyFor(scope, paneId);
  const at = Date.now();
  const entry: DraftEntry = { text, at, attachments: storedAttachments };

  // Memory first, and unconditionally: it is the tier that has to hold what the disk tier won't, and
  // it must be written even where there is no storage at all (SSR, Safari private mode).
  memory.set(key, entry);
  evictMemory(key);

  const store = storage();
  if (!store) return;
  if (!fitsDraftStore(text)) {
    // CLEAR rather than skip: leaving the previous entry means a remount restores an older, shorter
    // draft, and the user acts on text they never wrote. The memory tier above still has the whole
    // thing, so this only bites when the process actually dies — which fitsDraftStore's notice has
    // been saying on screen the entire time.
    clearStored(store, key);
    return;
  }
  try {
    store.setItem(key, JSON.stringify(entry));
  } catch {
    // Quota / private mode. The in-memory draft is still on screen; only its persistence is lost.
  }
}
/** Hold the memory tier under {@link MEMORY_MAX_CHARS}, oldest first, never evicting `keep`. */
function evictMemory(keep: string): void {
  const entryChars = (entry: DraftEntry) =>
    entry.text.length + entry.attachments.reduce((total, attachment) => total + attachment.path.length + attachment.name.length, 0);
  let total = 0;
  for (const entry of memory.values()) total += entryChars(entry);
  if (total <= MEMORY_MAX_CHARS) return;
  const byAge = [...memory.entries()]
    .filter(([key]) => key !== keep)
    .toSorted((a, b) => a[1].at - b[1].at);
  for (const [key, entry] of byAge) {
    memory.delete(key);
    total -= entryChars(entry);
    if (total <= MEMORY_MAX_CHARS) return;
  }
}

function clearStored(store: Storage, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    // ignore
  }
}

/** Drop a pane's draft from BOTH tiers. The password-prompt outcome (ADR 0017) calls this, and it is
 *  the reason the memory tier needs no gate of its own — see the note on `memory`. */
export function clearDraft(scope: Scope | undefined, paneId: string): void {
  const key = keyFor(scope, paneId);
  memory.delete(key);
  const store = storage();
  if (!store) return;
  clearStored(store, key);
}

/** Test seam — forgets the once-per-load prune so a case can control when pruning happens, and
 *  empties the memory tier, which `localStorage.clear()` in a test's setup cannot reach. */
export function __resetDraftPrune(): void {
  pruned = false;
  memory.clear();
}
