import type { VoteDimension } from "@reviewarena/shared-types";

// A comparison asks for eight dimension picks, eight optional notes and an
// overall verdict, all after reading two long reviews. Losing that to a
// refresh, a closed tab or a flat battery means re-reading both reviews
// from the top — and in the controlled study a participant's slot cannot be
// re-run, so the realistic outcome is a rushed second pass rather than an
// honest one.
//
// Drafts live in localStorage, per comparison, and never leave the browser.
// They are not research data: they are a scratchpad that happens to survive
// a reload. The vote itself is only ever created by an explicit submit.

export interface VoteDraft {
  /** Overall free-text rationale. */
  note: string;
  /** -1 = A better, 0 = tie, +1 = B better. */
  values: Partial<Record<VoteDimension, -1 | 0 | 1>>;
  /** Per-dimension free text. */
  notes: Partial<Record<VoteDimension, string>>;
  /** When the rater first opened this comparison, as epoch ms. */
  startedAt: number;
  /** When this draft was last written, as epoch ms. */
  savedAt: number;
}

const PREFIX = "ra-draft:";

// A draft is a convenience for "I refreshed" or "my laptop slept", not a way
// to resume a comparison next week: reviews may have been re-generated and
// the rater will not remember their reasoning. Anything older is discarded.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function draftKey(scope: string, id: string): string {
  return `${PREFIX}${scope}:${id}`;
}

export function loadDraft(key: string): VoteDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<VoteDraft>;
    // Anything that does not look like a draft is treated as absent rather
    // than repaired — a half-restored survey is worse than a blank one.
    if (
      typeof d !== "object" ||
      d === null ||
      typeof d.startedAt !== "number" ||
      typeof d.savedAt !== "number" ||
      typeof d.values !== "object"
    ) {
      localStorage.removeItem(key);
      return null;
    }
    if (Date.now() - d.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return {
      note: typeof d.note === "string" ? d.note : "",
      values: (d.values ?? {}) as VoteDraft["values"],
      notes: (d.notes ?? {}) as VoteDraft["notes"],
      startedAt: d.startedAt,
      savedAt: d.savedAt,
    };
  } catch {
    // Private mode, quota, or corrupt JSON. A draft is a nicety; never let
    // its absence break the comparison.
    return null;
  }
}

export function saveDraft(
  key: string,
  draft: Omit<VoteDraft, "savedAt">,
): void {
  try {
    // Nothing answered yet is nothing worth restoring, and writing it would
    // resurrect an empty draft over a fresh start.
    const empty =
      Object.keys(draft.values).length === 0 &&
      !draft.note.trim() &&
      Object.values(draft.notes).every((n) => !n?.trim());
    if (empty) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify({ ...draft, savedAt: Date.now() }));
  } catch {
    /* quota or private mode — proceed without a draft */
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

/**
 * Drop every expired draft. A participant makes six comparisons and each
 * key is cleared on submit, so this is housekeeping for abandoned ones
 * rather than a real pressure on quota — but an unbounded key space in a
 * browser that is never cleared is still a leak.
 */
export function pruneDrafts(): void {
  try {
    const now = Date.now();
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      try {
        const d = JSON.parse(localStorage.getItem(k) ?? "{}") as Partial<VoteDraft>;
        if (typeof d.savedAt !== "number" || now - d.savedAt > MAX_AGE_MS) stale.push(k);
      } catch {
        stale.push(k);
      }
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    /* noop */
  }
}
