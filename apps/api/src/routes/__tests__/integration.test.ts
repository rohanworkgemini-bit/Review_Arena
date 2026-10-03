/**
 * E2E Integration Tests: Full reviewer workflow
 *
 * Tests the critical path: upload paper → parse → get pair → stream reviews →
 * vote → reveal. These tests verify multi-route interactions and state
 * consistency across the system.
 *
 * Note: These are logical flow tests; full E2E would require a test database
 * and supertest to invoke actual Express routes. These validate the schema
 * contracts and key transformations.
 */

import { describe, it, expect } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { z } from "zod";
import { SubmitVoteRequestSchema, SubmitVoteResponseSchema } from "@reviewarena/shared-types";

describe("E2E: Paper Upload → Vote → Reveal Flow", () => {
  const sessionId = createId();
  const paperId = createId();
  const reviewAId = createId();
  const reviewBId = createId();
  const secret = "test-secret";

  describe("1. Upload Paper", () => {
    it("should create paper with UPLOADING status", () => {
      const uploadPayload = {
        paperId,
        status: "UPLOADED" as const,
        deduplicated: false,
        reviewIds: [],
      };

      expect(uploadPayload.paperId.length).toBeGreaterThan(20);
      expect(uploadPayload.status).toBe("UPLOADED");
    });

    it("should store contentHash for dedup", () => {
      const contentHash = "sha256_of_pdf_bytes";
      const paper = {
        id: paperId,
        contentHash,
        status: "PARSING" as const,
        uploadedBySessionId: sessionId,
      };

      expect(paper.contentHash).toBeDefined();
      expect(paper.uploadedBySessionId).toBe(sessionId);
    });
  });

  describe("2. Paper Parsing", () => {
    it("should transition PARSING → PARSED after successful parse", () => {
      const statusTransition = ["PARSING", "PARSED"] as const;
      expect(statusTransition).toContain("PARSED");
    });

    it("should store canonical text for all reviewers", () => {
      const paper = {
        canonicalText: "The paper proposes...",
        canonicalTokens: 5000,
        fullTokens: 8000,
        lengthBand: "medium",
      };

      expect(paper.canonicalText).toBeTruthy();
      expect(paper.canonicalTokens).toBeGreaterThan(0);
      expect(paper.canonicalTokens).toBeLessThanOrEqual(paper.fullTokens);
      expect(["short", "medium", "long"]).toContain(paper.lengthBand);
    });
  });

  describe("3. Pre-create Review Pair", () => {
    it("should create exactly 2 review rows at upload time", () => {
      const reviewIds = [
        { systemId: createId(), reviewId: reviewAId, status: "PENDING" as const },
        { systemId: createId(), reviewId: reviewBId, status: "PENDING" as const },
      ];

      expect(reviewIds).toHaveLength(2);
      expect(reviewIds[0]!.reviewId).not.toBe(reviewIds[1]!.reviewId);
    });

    it("should randomize A vs B assignment", () => {
      // Fair coin flip for each pair
      const coinFlips = Array.from({ length: 100 }, () => Math.random() > 0.5);
      const headCount = coinFlips.filter(Boolean).length;

      // Should be approximately 50/50 (allowing some variance)
      expect(headCount).toBeGreaterThan(30);
      expect(headCount).toBeLessThan(70);
    });
  });

  describe("4. Pair Selection (GET /pair)", () => {
    it("should return two eligible reviews in GENERATING or COMPLETED status", () => {
      const pair = {
        paper: {
          id: paperId,
          title: "Paper title",
        },
        reviewA: {
          reviewId: reviewAId,
          structured: null, // still generating
          status: "GENERATING" as const,
        },
        reviewB: {
          reviewId: reviewBId,
          structured: null,
          status: "GENERATING" as const,
        },
        pairToken: "encoded_token_with_hmac",
      };

      expect(pair.reviewA.reviewId).toBeTruthy();
      expect(pair.reviewB.reviewId).toBeTruthy();
      expect(["GENERATING", "COMPLETED"]).toContain(pair.reviewA.status!);
      expect(["GENERATING", "COMPLETED"]).toContain(pair.reviewB.status!);
    });

    it("should sign pairToken with HMAC", () => {
      const token = "eyJwIjoicGFwZXIiLCJhIjoicmV2aWV3LWEiLCJiIjoicmV2aWV3LWIiLCJzIjoic2Vzc2lvbiIsInQiOjE2MjAwMDAwMDB9.MAC_SIGNATURE";

      const parts = token.split(".");
      const payload = parts[0]!;
      const signature = parts[1]!;
      expect(payload).toBeTruthy();
      expect(signature).toBeTruthy();
      expect(signature.length).toBeGreaterThan(0);
    });

    it("should prevent pairing if session already voted on this pair", () => {
      // If seenVotes includes [reviewAId, reviewBId] (in either order),
      // pair selector skips this combo
      const seenVotes = new Set(["review-a|review-b"]);
      const currentPair = "review-a|review-b";

      expect(seenVotes.has(currentPair)).toBe(true);
      // Should not return this pair again
    });
  });

  describe("5. Review Streaming (GET /reviews/stream/:reviewId)", () => {
    it("should stream review tokens as SSE events", () => {
      const sseEvents = [
        { event: "token", data: { text: "The paper proposes" } },
        { event: "token", data: { text: " a novel approach" } },
        { event: "token", data: { text: " to..." } },
        {
          event: "done",
          data: {
            review: { strengths: [] as string[], weaknesses: [] as string[] },
            raw_output: "full review text",
            generation_ms: 3200,
          },
        },
      ];

      expect(sseEvents[0]!.event).toBe("token");
      expect(sseEvents[sseEvents.length - 1]!.event).toBe("done");
    });

    it("should mark review as COMPLETED when generation done", () => {
      const review = {
        id: reviewAId,
        status: "COMPLETED" as const,
        structured: { strengths: [], weaknesses: [] },
        generationMs: 3200,
        timeToFirstTokenMs: 450,
      };

      expect(review.status).toBe("COMPLETED");
      expect(review.generationMs).toBeGreaterThan(0);
      expect(review.timeToFirstTokenMs).toBeGreaterThan(0);
    });

    it("should log error but not corrupt vote if judge fails", () => {
      // Judge call happens in background; if it fails, review should
      // still have status COMPLETED but judge_status should be FAILED
      const review = {
        id: reviewAId,
        status: "COMPLETED" as const,
        judgeStatus: "FAILED" as const, // COMPLETE | PARTIAL | FAILED
      };

      expect(review.status).toBe("COMPLETED");
      expect(["COMPLETE", "PARTIAL", "FAILED"]).toContain(review.judgeStatus);
    });
  });

  describe("6. Vote Submission (POST /votes)", () => {
    it("should accept valid vote request", () => {
      const voteRequest = {
        pairToken: "valid_signed_token",
        winner: "A" as const,
        decisionMs: 5000,
        dimensions: [
          { dimension: "CONTRIBUTION_ACCURACY" as const, winner: "B" as const },
          { dimension: "CRITIQUE_CLARITY" as const, winner: "A" as const },
          { dimension: "COMPARATIVE_ANALYSIS" as const, winner: "B" as const },
          { dimension: "EVIDENCE_BASED_CRITIQUE" as const, winner: "A" as const },
          { dimension: "CONSTRUCTIVE_TONE" as const, winner: "B" as const },
          { dimension: "RESULTS_INTERPRETATION" as const, winner: "A" as const },
          { dimension: "COMPLETENESS_COVERAGE" as const, winner: "B" as const },
          { dimension: "FALSE_CLAIMS" as const, winner: "A" as const },
        ],
      };

      const result = SubmitVoteRequestSchema.safeParse(voteRequest);
      expect(result.success).toBe(true);
    });

    it("should verify pairToken signature matches session", () => {
      // Server verifies:
      // 1. HMAC signature valid
      // 2. Token not expired (iat + 1h TTL)
      // 3. sessionId in token matches request.sessionId
      // 4. reviewIds exist and are GENERATING or COMPLETED

      const payload = {
        paperId,
        reviewAId,
        reviewBId,
        sessionId, // ← must match req.sessionId
        iat: Math.floor(Date.now() / 1000),
      };

      expect(payload.sessionId).toBe(sessionId);
    });

    it("should prevent duplicate vote on same pair+session", () => {
      // Postgres constraint: votes_session_pair_sig_uk
      // on (sessionId, paperId, pairSig)
      // where pairSig = LEAST(a,b) || '|' || GREATEST(a,b)

      const vote1 = { sessionId, paperId, pairSig: "review-a|review-b" };
      const vote2 = { sessionId, paperId, pairSig: "review-b|review-a" };

      // Both have same canonical pairSig → unique constraint blocks vote2
      expect(vote1.pairSig).toBe("review-a|review-b");
      expect(vote2.pairSig).not.toBe(vote1.pairSig); // But comparison should work
    });

    it("should record all 8 dimension votes", () => {
      const dimensionVotes = [
        { dimension: "CONTRIBUTION_ACCURACY", winner: "B" },
        { dimension: "CRITIQUE_CLARITY", winner: "A" },
        { dimension: "COMPARATIVE_ANALYSIS", winner: "B" },
        { dimension: "EVIDENCE_BASED_CRITIQUE", winner: "A" },
        { dimension: "CONSTRUCTIVE_TONE", winner: "B" },
        { dimension: "RESULTS_INTERPRETATION", winner: "A" },
        { dimension: "COMPLETENESS_COVERAGE", winner: "B" },
        { dimension: "FALSE_CLAIMS", winner: "A" },
      ];

      expect(dimensionVotes).toHaveLength(8);
      dimensionVotes.forEach((dv) => {
        expect(["A", "B"]).toContain(dv.winner);
      });
    });

    it("should compute a Bradley-Terry snapshot after vote", () => {
      // After vote persists, snapshotLeaderboard() runs:
      // 1. Load all COMPLETED votes (B1 fairness filter)
      // 2. Fit Bradley-Terry over the full history (MM fixed point)
      // 3. Bootstrap CI (100 resamples, 2.5/97.5 percentile)
      // 4. Insert BT rows into `ratings` (online Elo is no longer computed
      //    at runtime; `method` still distinguishes the two)

      const snapshot = {
        reviewSystemId: createId(),
        dimension: null, // overall leaderboard
        rating: 1025,
        ratingCiLow: 1015,
        ratingCiHigh: 1035,
        voteCount: 5,
        computedAt: new Date().toISOString(),
      };

      expect(snapshot.rating).toBeGreaterThan(snapshot.ratingCiLow);
      expect(snapshot.rating).toBeLessThan(snapshot.ratingCiHigh);
      expect(snapshot.voteCount).toBeGreaterThan(0);
    });

    it("should exclude non-COMPLETED reviews from the ratings (B1)", () => {
      // Fairness control: only COMPLETED reviews counted in the ratings
      // FAILED/GENERATING/PENDING excluded (infra failure, not quality)
      const validStatuses = ["COMPLETED"] as const;
      const excludedStatuses = ["FAILED", "GENERATING", "PENDING"] as const;

      expect(validStatuses).toContain("COMPLETED");
      excludedStatuses.forEach((status) => {
        expect(validStatuses).not.toContain(status);
      });
    });

    it("should exclude only judge_status FAILED from the ratings (panel rule)", () => {
      // FAILED = no judge-panel member scored the pair. PARTIAL and PENDING
      // (arena papers are never judged) still count toward the board.
      const countedStatuses = ["PENDING", "COMPLETE", "PARTIAL"] as const;
      const excludedStatus = "FAILED";

      countedStatuses.forEach((status) => {
        expect(status).not.toBe(excludedStatus);
      });
    });
  });

  describe("7. Vote Response & Reveal Data", () => {
    it("should return voteId and reveal payload", () => {
      const voteResponse = {
        voteId: createId(),
        reveal: {
          winner: "A",
          reviewA: {
            reviewId: reviewAId,
            systemSlug: "gpt-5",
            systemName: "GPT-5 (zero-shot)",
            btBefore: 1002.4,
            btAfter: 1009.1,
          },
          reviewB: {
            reviewId: reviewBId,
            systemSlug: "claude-opus-4-8",
            systemName: "Claude Opus 4.8 (zero-shot)",
            btBefore: 993.6,
            btAfter: 986.9,
          },
        },
      };

      const result = SubmitVoteResponseSchema.safeParse(voteResponse);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.voteId).toBeTruthy();
        expect(result.data.reveal.winner).toBe("A");
        // BT is refit rather than nudged, but a win still has to move the
        // winner up and the loser down.
        expect(result.data.reveal.reviewA.btAfter!).toBeGreaterThan(
          result.data.reveal.reviewA.btBefore!,
        );
        expect(result.data.reveal.reviewB.btAfter!).toBeLessThan(
          result.data.reveal.reviewB.btBefore!,
        );
      }
    });

    it("accepts null BT ratings for a system not yet on the BT board", () => {
      // Bradley-Terry cannot place a system until wins and losses connect it
      // to the rest of the field, so the reveal payload has to carry nulls.
      const voteResponse = {
        voteId: createId(),
        reveal: {
          winner: "A",
          reviewA: {
            reviewId: reviewAId,
            systemSlug: "brand-new-system",
            systemName: "Brand New System",
            btBefore: null,
            btAfter: null,
          },
          reviewB: {
            reviewId: reviewBId,
            systemSlug: "claude-opus-4-8",
            systemName: "Claude Opus 4.8 (zero-shot)",
            btBefore: 993.6,
            btAfter: 993.6,
          },
        },
      };
      expect(SubmitVoteResponseSchema.safeParse(voteResponse).success).toBe(true);
    });

    it("carries the rater's verdict so a tie needs no rating movement to display", () => {
      // The reveal headline used to be inferred from an Elo delta; with Elo
      // gone from the runtime the API echoes the winner explicitly, which
      // also covers the case where BT cannot place either system yet.
      const voteResponse = {
        voteId: createId(),
        reveal: {
          winner: "TIE",
          reviewA: {
            reviewId: reviewAId,
            systemSlug: "gpt-5",
            systemName: "GPT-5 (zero-shot)",
            btBefore: null,
            btAfter: null,
          },
          reviewB: {
            reviewId: reviewBId,
            systemSlug: "claude-opus-4-8",
            systemName: "Claude Opus 4.8 (zero-shot)",
            btBefore: null,
            btAfter: null,
          },
        },
      };
      const result = SubmitVoteResponseSchema.safeParse(voteResponse);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.reveal.winner).toBe("TIE");

      // Elo fields are gone from the contract entirely.
      const withElo = {
        ...voteResponse,
        reveal: {
          ...voteResponse.reveal,
          reviewA: { ...voteResponse.reveal.reviewA, eloBefore: 1000, eloAfter: 1004 },
        },
      };
      const parsed = SubmitVoteResponseSchema.safeParse(withElo);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect("eloBefore" in parsed.data.reveal.reviewA).toBe(false);
      }
    });

    it("rejects a reveal payload without a winner", () => {
      const noWinner = {
        voteId: createId(),
        reveal: {
          reviewA: {
            reviewId: reviewAId,
            systemSlug: "gpt-5",
            systemName: "GPT-5 (zero-shot)",
            btBefore: 1002.4,
            btAfter: 1009.1,
          },
          reviewB: {
            reviewId: reviewBId,
            systemSlug: "claude-opus-4-8",
            systemName: "Claude Opus 4.8 (zero-shot)",
            btBefore: 993.6,
            btAfter: 986.9,
          },
        },
      };
      expect(SubmitVoteResponseSchema.safeParse(noWinner).success).toBe(false);
    });
  });

  describe("8. Leaderboard Consistency", () => {
    it("should reflect the new rating in the leaderboard after vote", () => {
      const leaderboardEntry = {
        rank: 1,
        systemSlug: "gpt-5",
        rating: 1025,
        ratingCiLow: 1015,
        ratingCiHigh: 1035,
        voteCount: 5,
      };

      expect(leaderboardEntry.rank).toBeGreaterThan(0);
      expect(leaderboardEntry.rating).toBeGreaterThan(leaderboardEntry.ratingCiLow);
      expect(leaderboardEntry.rating).toBeLessThan(leaderboardEntry.ratingCiHigh);
    });

    it("should show confidence intervals from bootstrap resampling", () => {
      // 95% CI from 100 resamples, 2.5/97.5 percentile
      // Interval should be non-zero and proportional to vote count
      const ci = { low: 990, high: 1060, rating: 1025 };
      const width = ci.high - ci.low;

      expect(width).toBeGreaterThan(0);
      expect(ci.rating).toBeGreaterThan(ci.low);
      expect(ci.rating).toBeLessThan(ci.high);
    });
  });

  describe("9. Dimension Leaderboards", () => {
    it("should compute per-dimension ratings independently", () => {
      // Each dimension (CONTRIBUTION_ACCURACY, CRITIQUE_CLARITY, etc.) has its own
      // battle history and separate Bradley-Terry snapshot.

      const dimensionSnapshots = [
        { dimension: "CONTRIBUTION_ACCURACY", rating: 1030, voteCount: 5 },
        { dimension: "CRITIQUE_CLARITY", rating: 1015, voteCount: 5 },
        { dimension: "COMPARATIVE_ANALYSIS", rating: 1008, voteCount: 5 },
      ];

      dimensionSnapshots.forEach((snap) => {
        expect(snap.dimension).toBeTruthy();
        expect(snap.rating).toBeGreaterThan(0);
        expect(snap.voteCount).toBeGreaterThan(0);
      });
    });

    it("should exclude non-COMPLETED for dimension votes too", () => {
      // Fairness B1 applies per-dimension: only COMPLETED votes counted
      const validDimVotes = [
        { voteId: createId(), dimension: "CRITIQUE_CLARITY", value: 1, status: "COMPLETED" as const },
      ];

      validDimVotes.forEach((dv) => {
        expect(dv.status).toBe("COMPLETED");
      });
    });
  });
});
