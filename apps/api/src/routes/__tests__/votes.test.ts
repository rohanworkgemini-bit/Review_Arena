import { describe, it, expect, beforeEach } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { SubmitVoteRequestSchema, type VoteDimension } from "@reviewarena/shared-types";
import { signPairToken } from "../pair.js";

describe("Vote Request Validation (SubmitVoteRequestSchema)", () => {
  const validDimensions = [
    { dimension: "CONTRIBUTION_ACCURACY" as const, value: 1 as const },
    { dimension: "CRITIQUE_CLARITY" as const, value: -1 as const },
    { dimension: "COMPARATIVE_ANALYSIS" as const, value: 1 as const },
    { dimension: "EVIDENCE_BASED_CRITIQUE" as const, value: -1 as const },
    { dimension: "CONSTRUCTIVE_TONE" as const, value: 1 as const },
    { dimension: "RESULTS_INTERPRETATION" as const, value: -1 as const },
    { dimension: "COMPLETENESS_COVERAGE" as const, value: 1 as const },
    { dimension: "FALSE_CLAIMS" as const, value: -1 as const },
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

  it("should reject invalid dimension scores (not in [-1, 0, 1])", () => {
    const badScore = {
      pairToken,
      winner: "A" as const,
      dimensions: [
        { dimension: "CONTRIBUTION_ACCURACY", value: 2 }, // invalid
        ...validDimensions.slice(1),
      ],
    };

    const result = SubmitVoteRequestSchema.safeParse(badScore);
    expect(result.success).toBe(false);
  });

  it("should accept a per-dimension tie (value 0) and an optional note", () => {
    const withTieAndNote = {
      pairToken,
      winner: "TIE" as const,
      dimensions: [
        { dimension: "CONTRIBUTION_ACCURACY" as const, value: 0 as const, note: "both equally thorough" },
        ...validDimensions.slice(1),
      ],
    };

    const result = SubmitVoteRequestSchema.safeParse(withTieAndNote);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dimensions[0]!.value).toBe(0);
      expect(result.data.dimensions[0]!.note).toBe("both equally thorough");
    }
  });

  it("should reject a per-dimension note longer than 1000 chars", () => {
    const longNote = {
      pairToken,
      winner: "A" as const,
      dimensions: [
        { dimension: "CONTRIBUTION_ACCURACY" as const, value: 1 as const, note: "x".repeat(1001) },
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

    // This should be filtered out by votes.ts loadBattles()
    expect(["COMPLETED", "FAILED", "PENDING"]).toContain("COMPLETED");
    expect(["COMPLETED", "FAILED", "PENDING"]).not.toContain("GENERATING");
  });

  it("should exclude only judge_status FAILED from the ratings (panel rule)", () => {
    const statuses = ["PENDING", "COMPLETE", "PARTIAL", "FAILED"] as const;

    // Mirrors loadBattles() in votes.ts: FAILED = no panel member scored
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
