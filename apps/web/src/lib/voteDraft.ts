import { VOTE_DIMENSIONS, type VoteDimension, type Winner } from "@reviewarena/shared-types";
import type { Highlight } from "./highlight";

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
  /** Renderer contract this draft's highlight offsets were taken against. */
  schema: number;
  /** Overall free-text rationale. */
  note: string;
  /** Per-dimension verdict, same encoding as the overall one. */
  values: Partial<Record<VoteDimension, Winner>>;
  /** Per-dimension free text. */
  notes: Partial<Record<VoteDimension, string>>;
  /** Tinted spans, per panel. Restorable because the offsets address the
   *  rendered text of a review that does not change between reloads: a
   *  study comparison is fetched once and cached, and the arena holds its
   *  pair token, so the same markdown produces the same blocks. */
  marksA: Highlight[];
  marksB: Highlight[];
  /** When the rater first opened this comparison, as epoch ms. */
  startedAt: number;
  /** When this draft was last written, as epoch ms. */
  savedAt: number;
}

const DIMENSIONS = new Set<string>(VOTE_DIMENSIONS);

/**
 * Keep only spans that still describe a span. A stored highlight whose
 * offsets are nonsense would tint the wrong words — silently, and in a
 * reading aid the rater is trusting — so anything malformed is dropped
 * rather than clamped into place.
 */
function sanitizeMarks(v: unknown): Highlight[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (h): h is Highlight =>
      !!h &&
      typeof h === "object" &&
      typeof (h as Highlight).id === "string" &&
      Number.isInteger((h as Highlight).block) &&
      (h as Highlight).block >= 0 &&
      Number.isInteger((h as Highlight).start) &&
      Number.isInteger((h as Highlight).end) &&
      (h as Highlight).start >= 0 &&
      (h as Highlight).end > (h as Highlight).start &&
      DIMENSIONS.has((h as Highlight).dimension),
  );
}

const PREFIX = "ra-draft:";

// Highlight offsets address block indices produced by the markdown
// renderer, so a change to how blocks are counted silently re-points every
// stored span at different words. Bumping this discards drafts written by
// an older build instead of restoring markup onto the wrong sentences.
//
//   1 — initial
//   2 — headings became section boundaries rather than blocks
const SCHEMA = 2;

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
    if (Date.now() - d.savedAt > MAX_AGE_MS || d.schema !== SCHEMA) {
      localStorage.removeItem(key);
      return null;
    }
    return {
      schema: SCHEMA,
      note: typeof d.note === "string" ? d.note : "",
      values: (d.values ?? {}) as VoteDraft["values"],
      notes: (d.notes ?? {}) as VoteDraft["notes"],
      marksA: sanitizeMarks(d.marksA),
      marksB: sanitizeMarks(d.marksB),
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
  draft: Omit<VoteDraft, "savedAt" | "schema">,
): void {
  try {
    // Nothing answered yet is nothing worth restoring, and writing it would
    // resurrect an empty draft over a fresh start. Tinted spans count as
    // work in progress: a rater who marked up both reviews and reloaded
    // before answering anything should still get their markup back.
    const empty =
      Object.keys(draft.values).length === 0 &&
      !draft.note.trim() &&
      Object.values(draft.notes).every((n) => !n?.trim()) &&
      draft.marksA.length === 0 &&
      draft.marksB.length === 0;
    if (empty) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(
      key,
      JSON.stringify({ ...draft, schema: SCHEMA, savedAt: Date.now() }),
    );
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
        if (typeof d.savedAt !== "number" || now - d.savedAt > MAX_AGE_MS || d.schema !== SCHEMA)
          stale.push(k);
      } catch {
        stale.push(k);
      }
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    /* noop */
  }
}
