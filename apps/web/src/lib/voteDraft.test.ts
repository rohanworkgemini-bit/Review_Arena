// @vitest-environment jsdom
//
// Only this file needs a DOM. The rest of the suite renders to static
// markup on purpose, so the environment is opted into per file rather
// than switched on globally.
import { beforeEach, describe, expect, it } from "vitest";
import { clearDraft, draftKey, loadDraft, pruneDrafts, saveDraft } from "./voteDraft";

const KEY = draftKey("study", "cmp1");
const mark = {
  id: "h1",
  block: 3,
  start: 10,
  end: 42,
  dimension: "CRITIQUE_CLARITY" as const,
};
const filled = {
  note: "A read the paper more carefully.",
  values: { CRITIQUE_CLARITY: -1 as const },
  notes: { CRITIQUE_CLARITY: "A's questions are actionable." },
  marksA: [mark],
  marksB: [],
  startedAt: Date.now(),
};
const blank = { note: "", values: {}, notes: {}, marksA: [], marksB: [], startedAt: Date.now() };

beforeEach(() => localStorage.clear());

describe("saveDraft / loadDraft", () => {
  it("round-trips a partially answered survey", () => {
    saveDraft(KEY, filled);
    const d = loadDraft(KEY);
    expect(d?.note).toBe(filled.note);
    expect(d?.values.CRITIQUE_CLARITY).toBe(-1);
    expect(d?.notes.CRITIQUE_CLARITY).toBe("A's questions are actionable.");
    expect(d?.startedAt).toBe(filled.startedAt);
  });

  it("preserves startedAt so a resumed vote is not timed as rushed", () => {
    const old = Date.now() - 5 * 60_000;
    saveDraft(KEY, { ...filled, startedAt: old });
    expect(loadDraft(KEY)?.startedAt).toBe(old);
  });

  it("writes nothing when the survey is untouched", () => {
    saveDraft(KEY, blank);
    expect(loadDraft(KEY)).toBeNull();
  });

  it("treats whitespace-only answers as untouched", () => {
    saveDraft(KEY, { ...blank, note: "   ", notes: { CRITIQUE_CLARITY: "  " } });
    expect(loadDraft(KEY)).toBeNull();
  });

  it("clears a previously saved draft when the rater empties it", () => {
    saveDraft(KEY, filled);
    saveDraft(KEY, { ...blank, startedAt: filled.startedAt });
    expect(loadDraft(KEY)).toBeNull();
  });

  it("returns null for an absent key", () => {
    expect(loadDraft(draftKey("study", "nope"))).toBeNull();
  });

  it("discards a draft older than a day rather than resurrecting it", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...filled, savedAt: Date.now() - 25 * 60 * 60 * 1000 }),
    );
    expect(loadDraft(KEY)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  // A half-restored survey is worse than a blank one: the rater would not
  // know which of their answers survived.
  it("discards corrupt or malformed drafts", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadDraft(KEY)).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ note: "x" }));
    expect(loadDraft(KEY)).toBeNull();
  });
});

describe("clearDraft", () => {
  it("removes the draft once the vote is recorded", () => {
    saveDraft(KEY, filled);
    clearDraft(KEY);
    expect(loadDraft(KEY)).toBeNull();
  });
});

describe("pruneDrafts", () => {
  it("sweeps expired drafts and leaves fresh ones", () => {
    const stale = draftKey("study", "old");
    localStorage.setItem(
      stale,
      JSON.stringify({ ...filled, savedAt: Date.now() - 48 * 60 * 60 * 1000 }),
    );
    saveDraft(KEY, filled);
    localStorage.setItem("unrelated-key", "keep me");

    pruneDrafts();

    expect(localStorage.getItem(stale)).toBeNull();
    expect(loadDraft(KEY)).not.toBeNull();
    expect(localStorage.getItem("unrelated-key")).toBe("keep me");
  });
});

describe("draftKey", () => {
  it("keeps arena and study scopes apart", () => {
    expect(draftKey("arena", "x")).not.toBe(draftKey("study", "x"));
  });
});

describe("highlight persistence", () => {
  it("brings tinted spans back", () => {
    saveDraft(KEY, filled);
    expect(loadDraft(KEY)?.marksA).toEqual([mark]);
    expect(loadDraft(KEY)?.marksB).toEqual([]);
  });

  it("saves markup even when no dimension is answered yet", () => {
    saveDraft(KEY, { ...blank, marksA: [mark] });
    expect(loadDraft(KEY)?.marksA).toHaveLength(1);
  });

  // A stored span with nonsense offsets would tint the wrong words, in a
  // reading aid the rater is trusting — so drop it rather than clamp it.
  it("drops malformed spans instead of repairing them", () => {
    saveDraft(KEY, {
      ...blank,
      marksA: [
        mark,
        { ...mark, id: "bad-range", start: 40, end: 10 },
        { ...mark, id: "bad-block", block: -1 },
        { ...mark, id: "bad-dim", dimension: "NOT_A_DIMENSION" as never },
      ],
    });
    expect(loadDraft(KEY)?.marksA).toEqual([mark]);
  });

  it("survives marks being absent from a draft of the current schema", () => {
    // Round-trip through saveDraft so the stored schema stays correct, then
    // strip the mark arrays the way a defensive write might have.
    saveDraft(KEY, filled);
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    delete stored.marksA;
    delete stored.marksB;
    localStorage.setItem(KEY, JSON.stringify(stored));
    expect(loadDraft(KEY)?.marksA).toEqual([]);
    expect(loadDraft(KEY)?.marksB).toEqual([]);
  });
});

describe("schema versioning", () => {
  // Block indices moved when headings stopped being blocks. Restoring a
  // draft written against the old numbering would tint different words
  // than the rater marked — so it is discarded, not migrated.
  it("discards a draft from an older renderer contract", () => {
    localStorage.setItem(KEY, JSON.stringify({ ...filled, schema: 1, savedAt: Date.now() }));
    expect(loadDraft(KEY)).toBeNull();
  });

  it("discards a draft with no schema at all", () => {
    localStorage.setItem(KEY, JSON.stringify({ ...filled, savedAt: Date.now() }));
    expect(loadDraft(KEY)).toBeNull();
  });

  it("prunes drafts left by an older contract", () => {
    localStorage.setItem(KEY, JSON.stringify({ ...filled, schema: 1, savedAt: Date.now() }));
    pruneDrafts();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
