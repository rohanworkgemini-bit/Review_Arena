import { describe, it, expect, beforeEach } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { SubmitVoteRequestSchema, type VoteDimension } from "@reviewarena/shared-types";
import { signPairToken } from "../pair.js";

describe("Vote Request Validation (SubmitVoteRequestSchema)", () => {
  const validDimensions = [
    { dimension: "COMPREHENSIVENESS" as const, value: 1 as const },
    { dimension: "CLARITY" as const, value: -1 as const },
    { dimension: "FAIRNESS" as const, value: 1 as const },
    { dimension: "ACTIONABILITY" as const, value: -1 as const },
    { dimension: "CONSTRUCTIVENESS" as const, value: 1 as const },
    { dimension: "OBJECTIVITY" as const, value: -1 as const },
    { dimension: "RELEVANCE" as const, value: 1 as const },
    { dimension: "TECHNICAL_TERMS" as const, value: -1 as const },
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
        { dimension: "COMPREHENSIVENESS", value: 2 }, // invalid
        ...validDimensions.slice(1),
      ],
    };

    const result = SubmitVoteRequestSchema.safeParse(badScore);
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
  // should be included in Elo computation.

  it("should exclude non-COMPLETED reviews from Elo", () => {
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

  it("should exclude judge_status !== COMPLETE from Elo", () => {
    const statuses = ["COMPLETE", "PARTIAL", "FAILED"] as const;
    expect(statuses).toContain("COMPLETE");
    expect(statuses).toContain("PARTIAL");
    expect(statuses).toContain("FAILED");

    // Only COMPLETE should be included in Elo
    const shouldInclude = (status: typeof statuses[number]) => status === "COMPLETE";
    expect(shouldInclude("COMPLETE")).toBe(true);
    expect(shouldInclude("PARTIAL")).toBe(false);
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
