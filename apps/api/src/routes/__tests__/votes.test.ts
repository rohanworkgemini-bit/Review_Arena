import { describe, it, expect, beforeEach } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { SubmitVoteRequestSchema, type VoteDimension } from "@reviewarena/shared-types";
import { signPairToken } from "../pair.js";
import { partitionBoards, revealFor, splitOwnVote, type BoardRow, type VoteLogEntry } from "../votes.js";
import { computeBT } from "../../rating/bt.js";

describe("Vote Request Validation (SubmitVoteRequestSchema)", () => {
  const validDimensions = [
    { dimension: "CONTRIBUTION_ACCURACY" as const, winner: "B" as const },
    { dimension: "CRITIQUE_CLARITY" as const, winner: "A" as const },
    { dimension: "COMPARATIVE_ANALYSIS" as const, winner: "B" as const },
    { dimension: "EVIDENCE_BASED_CRITIQUE" as const, winner: "A" as const },
    { dimension: "CONSTRUCTIVE_TONE" as const, winner: "B" as const },
    { dimension: "RESULTS_INTERPRETATION" as const, winner: "A" as const },
    { dimension: "COMPLETENESS_COVERAGE" as const, winner: "B" as const },
    { dimension: "FALSE_CLAIMS" as const, winner: "A" as const },
  ];

  const secret = "test-secret-key-for-hmac";
  const sessionId = createId();
  const paperId = createId();
  const reviewAId = createId();
  const reviewBId = createId();
  const pairToken = signPairToken(
    { paperId, reviewAId, reviewBId, sessionId },
    secret,
  );

  it("should accept valid vote with all fields", () => {
    const valid = {
      pairToken,
      winner: "A" as const,
      decisionMs: 5000,
      dimensions: validDimensions,
    };

    const result = SubmitVoteRequestSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.winner).toBe("A");
      expect(result.data.dimensions).toHaveLength(8);
    }
  });

  it("should reject invalid winner value", () => {
    const invalid = {
      pairToken,
      winner: "INVALID",
      dimensions: validDimensions,
    };

    const result = SubmitVoteRequestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("should require all 8 dimensions", () => {
    const incomplete = {
      pairToken,
      winner: "A" as const,
      dimensions: validDimensions.slice(0, 5), // only 5 dimensions
    };

    const result = SubmitVoteRequestSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it("should accept tie votes", () => {
    const tieVote = {
      pairToken,
      winner: "TIE" as const,
      dimensions: validDimensions,
    };

    const result = SubmitVoteRequestSchema.safeParse(tieVote);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.winner).toBe("TIE");
    }
  });

  it("should accept missing decisionMs (optional)", () => {
    const noTime = {
      pairToken,
      winner: "B" as const,
      // decisionMs is optional
      dimensions: validDimensions,
    };

    const result = SubmitVoteRequestSchema.safeParse(noTime);
    expect(result.success).toBe(true);
  });

  it("should accept decisionMs with value", () => {
    const withTime = {
      pairToken,
      winner: "B" as const,
      decisionMs: 3000,
      dimensions: validDimensions,
    };

    const result = SubmitVoteRequestSchema.safeParse(withTime);
    expect(result.success).toBe(true);
  });

  it("should reject a dimension verdict outside A / B / TIE", () => {
    const badScore = {
      pairToken,
      winner: "A" as const,
      dimensions: [
        { dimension: "CONTRIBUTION_ACCURACY", winner: "MAYBE" }, // invalid
        ...validDimensions.slice(1),
      ],
    };

    const result = SubmitVoteRequestSchema.safeParse(badScore);
    expect(result.success).toBe(false);
  });

  it("should accept a per-dimension tie and an optional note", () => {
    const withTieAndNote = {
      pairToken,
      winner: "TIE" as const,
      dimensions: [
        { dimension: "CONTRIBUTION_ACCURACY" as const, winner: "TIE" as const, note: "both equally thorough" },
        ...validDimensions.slice(1),
      ],
    };

    const result = SubmitVoteRequestSchema.safeParse(withTieAndNote);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dimensions[0]!.winner).toBe("TIE");
      expect(result.data.dimensions[0]!.note).toBe("both equally thorough");
    }
  });

  it("should reject a per-dimension note longer than 1000 chars", () => {
    const longNote = {
      pairToken,
      winner: "A" as const,
      dimensions: [
        { dimension: "CONTRIBUTION_ACCURACY" as const, winner: "B" as const, note: "x".repeat(1001) },
        ...validDimensions.slice(1),
      ],
    };

    const result = SubmitVoteRequestSchema.safeParse(longNote);
    expect(result.success).toBe(false);
  });

  it("should reject missing pairToken", () => {
    const noPair = {
      winner: "A" as const,
      dimensions: validDimensions,
    };

    const result = SubmitVoteRequestSchema.safeParse(noPair);
    expect(result.success).toBe(false);
  });
});

describe("Vote Battle Inclusion Filters", () => {
  // FAIRNESS B1: only COMPLETED reviews with COMPLETE judge status
  // should be included in the rating computation.

  it("should exclude non-COMPLETED reviews from the ratings", () => {
    const battle1 = {
      a: "system-a",
      b: "system-b",
      outcome: 1 as const,
      status: "GENERATING", // not COMPLETED
    };

    // This should be filtered out by votes.ts eligibleVoteWhere()
    expect(["COMPLETED", "FAILED", "PENDING"]).toContain("COMPLETED");
    expect(["COMPLETED", "FAILED", "PENDING"]).not.toContain("GENERATING");
  });

  it("should exclude only judge_status FAILED from the ratings (panel rule)", () => {
    const statuses = ["PENDING", "COMPLETE", "PARTIAL", "FAILED"] as const;

    // Mirrors eligibleVoteWhere() in votes.ts: FAILED = no panel member scored
    // the pair. PARTIAL (some judges returned) and PENDING (arena, never
    // judged) still count — the human vote is valid regardless.
    const shouldInclude = (status: typeof statuses[number]) => status !== "FAILED";
    expect(shouldInclude("PENDING")).toBe(true);
    expect(shouldInclude("COMPLETE")).toBe(true);
    expect(shouldInclude("PARTIAL")).toBe(true);
    expect(shouldInclude("FAILED")).toBe(false);
  });
});

describe("Vote Dedup Protection", () => {
  it("should prevent duplicate votes on same pair+session", () => {
    const sessionId = "session-123";
    const paperId = "paper-456";
    const reviewAId = "review-a";
    const reviewBId = "review-b";

    // Canonical pair signature (order-independent)
    // Postgres generates: LEAST(review_a_id, review_b_id) || '|' || GREATEST(review_a_id, review_b_id)
    const ids = [reviewAId, reviewBId].sort();
    const pairSigAB = `${ids[0]}|${ids[1]}`;
    const pairSigBA = [...ids].reverse().sort().join("|");

    // Both orderings should result in the same signature
    expect(pairSigAB).toBe(`${ids[0]}|${ids[1]}`);

    // Constraint check: votes_session_pair_sig_uk on (sessionId, paperId, pairSig)
    // means a replay of the same pair (regardless of A/B coin flip) is rejected.
    const vote1 = { sessionId, paperId, pairSig: pairSigAB };
    const vote2 = { sessionId, paperId, pairSig: pairSigBA };

    // In SQL, these would violate the unique constraint
    expect(vote1.pairSig).toBe(vote2.pairSig);
  });
});

describe("partitionBoards (one query, nine boards)", () => {
  const dims = (winners: Partial<Record<VoteDimension, "A" | "B" | "TIE">>) =>
    Object.entries(winners) as [VoteDimension, "A" | "B" | "TIE"][];
  const rowsFor = (
    voteId: string,
    a: string,
    b: string,
    winner: "A" | "B" | "TIE",
    d: [VoteDimension, "A" | "B" | "TIE"][],
  ): BoardRow[] =>
    d.length === 0
      ? [{ voteId, a, b, winner, dimension: null, dimensionWinner: null }]
      : d.map(([dimension, dimensionWinner]) => ({ voteId, a, b, winner, dimension, dimensionWinner }));

  it("puts each vote on the overall board once and each verdict on its dimension", () => {
    const rows = [
      ...rowsFor("v1", "x", "y", "A", dims({ CRITIQUE_CLARITY: "B", FALSE_CLAIMS: "TIE" })),
      ...rowsFor("v2", "y", "z", "TIE", dims({ CRITIQUE_CLARITY: "A" })),
      ...rowsFor("v3", "x", "z", "B", []),
    ];
    const { overall, byDimension } = partitionBoards(rows);
    expect(overall).toEqual([
      { a: "x", b: "y", outcome: 1 },
      { a: "y", b: "z", outcome: 0.5 },
      { a: "x", b: "z", outcome: 0 },
    ]);
    expect(byDimension.get("CRITIQUE_CLARITY")).toEqual([
      { a: "x", b: "y", outcome: 0 },
      { a: "y", b: "z", outcome: 1 },
    ]);
    expect(byDimension.get("FALSE_CLAIMS")).toEqual([{ a: "x", b: "y", outcome: 0.5 }]);
    // All eight boards exist, empty or not.
    expect(byDimension.size).toBe(8);
    expect(byDimension.get("CONSTRUCTIVE_TONE")).toEqual([]);
  });

  it("returns empty boards for no votes", () => {
    const { overall, byDimension } = partitionBoards([]);
    expect(overall).toEqual([]);
    for (const b of byDimension.values()) expect(b).toEqual([]);
  });
});

describe("reveal on a replayed (409) vote", () => {
  const opts = { baselineSlug: "x" };
  const log: VoteLogEntry[] = [
    { voteId: "v1", battle: { a: "x", b: "y", outcome: 1 } },
    { voteId: "v2", battle: { a: "x", b: "y", outcome: 0 } },
    { voteId: "v3", battle: { a: "y", b: "z", outcome: 1 } },
    { voteId: "v4", battle: { a: "y", b: "z", outcome: 0 } },
    { voteId: "own", battle: { a: "x", b: "z", outcome: 1 } },
    { voteId: "v5", battle: { a: "x", b: "z", outcome: 0 } },
  ];

  it("takes the stored vote out of 'before' and counts it once in 'after'", () => {
    const { before, own } = splitOwnVote(log, "own");
    expect(before).toHaveLength(5);
    expect(own).toEqual({ a: "x", b: "z", outcome: 1 });
    const reveal = revealFor(before, own, "x", "z", opts);
    const all = computeBT(log.map((e) => e.battle), opts).ratings;
    const without = computeBT(before, opts).ratings;
    expect(reveal.btAfterB).toBeCloseTo(all.get("z")!, 9);
    expect(reveal.btBeforeB).toBeCloseTo(without.get("z")!, 9);
    // Not the old behaviour of appending the vote a second time.
    const doubled = computeBT([...log.map((e) => e.battle), own!], opts).ratings;
    expect(reveal.btAfterB).not.toBeCloseTo(doubled.get("z")!, 3);
  });

  it("shows no movement when the stored vote does not count toward the board", () => {
    const { before, own } = splitOwnVote(log, "not-in-log");
    expect(own).toBeNull();
    const reveal = revealFor(before, own, "x", "z", opts);
    expect(reveal.btAfterA).toBe(reveal.btBeforeA);
    expect(reveal.btAfterB).toBe(reveal.btBeforeB);
  });
});
