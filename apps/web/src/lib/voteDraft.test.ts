// @vitest-environment jsdom
//
// Only this file needs a DOM. The rest of the suite renders to static
// markup on purpose, so the environment is opted into per file rather
// than switched on globally.
import { beforeEach, describe, expect, it } from "vitest";
import { clearDraft, draftKey, loadDraft, pruneDrafts, saveDraft } from "./voteDraft";

const KEY = draftKey("study", "cmp1");
const filled = {
  note: "A read the paper more carefully.",
  values: { CRITIQUE_CLARITY: -1 as const },
  notes: { CRITIQUE_CLARITY: "A's questions are actionable." },
  startedAt: Date.now(),
};

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
    saveDraft(KEY, { note: "", values: {}, notes: {}, startedAt: Date.now() });
    expect(loadDraft(KEY)).toBeNull();
  });

  it("treats whitespace-only answers as untouched", () => {
    saveDraft(KEY, {
      note: "   ",
      values: {},
      notes: { CRITIQUE_CLARITY: "  " },
      startedAt: Date.now(),
    });
    expect(loadDraft(KEY)).toBeNull();
  });

  it("clears a previously saved draft when the rater empties it", () => {
    saveDraft(KEY, filled);
    saveDraft(KEY, { note: "", values: {}, notes: {}, startedAt: filled.startedAt });
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
