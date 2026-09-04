/**
 * Controlled-study routes (/study/*).
 *
 * The arena's adaptive sampler is replaced by the preregistered design in
 * src/study/rotation.ts: 20 participants × 2 papers × 3 disjoint pairs,
 * every one of the 15 system pairs measured exactly 8 times. Participants
 * authenticate with a pre-assigned secret code (capability token, no PII).
 *
 * Flow per paper: upload → ALL six systems generate server-side → the
 * rotation's three comparisons unlock as their reviews complete → three
 * single-axis votes → per-paper reveal (identities only — no ratings, no
 * judge output, so later votes aren't anchored on scores).
 *
 * Study votes are mode=STUDY: excluded from live leaderboard snapshots
 * (a public board mid-study would leak standings back to participants);
 * analysed offline with mean-centred BT + participant-level cluster
 * bootstrap.
 */
import { Router } from "express";
import multer from "multer";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  papers,
  participants,
  reviews,
  reviewSystems,
  studyComparisons,
  votes,
} from "../db/schema.js";
import type { ReviewGenClient } from "../clients/review-gen-client.js";
import type { JudgeClient } from "../clients/judge-client.js";
import { generateIntoReview } from "../pipeline/orchestrator.js";
import { renderPaperText } from "../pipeline/score-paper.js";
import { lengthBandFor, normalizeArxivId } from "./papers-helpers.js";
import { stripNullBytes } from "./papers.js";
import { logger } from "../logger.js";
import type { Config } from "../config.js";
import { ConferenceSchema, type ParsedPaper } from "@reviewarena/shared-types";
import {
  PAIRS_PER_PAPER,
  PAPERS_PER_PARTICIPANT,
  STUDY_SLUGS,
  pairsForRotation,
  rotationsForParticipant,
} from "../study/rotation.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

export function studyRouter(
  _config: Config,
  reviewGen: ReviewGenClient,
  judge?: JudgeClient,
): Router {
  const router = Router();

  // ── participant lookup ────────────────────────────────────────────────
  async function participantFor(code: unknown) {
    if (typeof code !== "string" || code.length < 6) return null;
    return (
      (await db.query.participants.findFirst({
        where: eq(participants.code, code),
      })) ?? null
    );
  }

  /** Latest non-parse-failed paper per paperIndex for a participant. */
  async function papersFor(participantId: string) {
    const rows = await db.query.papers.findMany({
      where: eq(papers.participantId, participantId),
      orderBy: [asc(papers.paperIndex), desc(papers.createdAt)],
    });
    const byIndex = new Map<number, typeof rows[number]>();
    for (const p of rows) {
      // rows are newest-last per index? orderBy asc(index), desc(createdAt):
      // first row seen per index is the newest — keep it unless it
      // PARSE_FAILED and an older one succeeded (re-upload replaces).
      if (!byIndex.has(p.paperIndex!)) byIndex.set(p.paperIndex!, p);
    }
    return byIndex;
  }

  // ── GET /study/state ─────────────────────────────────────────────────
  router.get("/study/state", async (req, res, next) => {
    try {
      const participant = await participantFor(req.query.code);
      if (!participant) {
        res.status(404).json({ error: "UnknownCode", message: "Unknown participant code." });
        return;
      }
      const byIndex = await papersFor(participant.id);

      const paperStates = [];
      let totalVotes = 0;
      for (let index = 1; index <= PAPERS_PER_PARTICIPANT; index++) {
        const paper = byIndex.get(index);
        if (!paper) {
          paperStates.push({ paperIndex: index, paperId: null });
          continue;
        }
        const revRows = await db.query.reviews.findMany({
          where: eq(reviews.paperId, paper.id),
          columns: { id: true, status: true },
        });
        const statusOf = new Map(revRows.map((r) => [r.id, r.status]));
        const comps = await db.query.studyComparisons.findMany({
          where: eq(studyComparisons.paperId, paper.id),
          orderBy: asc(studyComparisons.pairIndex),
        });
        const comparisons = comps.map((c) => ({
          comparisonId: c.id,
          pairIndex: c.pairIndex,
          ready:
            statusOf.get(c.reviewAId) === "COMPLETED" &&
            statusOf.get(c.reviewBId) === "COMPLETED",
          failed:
            statusOf.get(c.reviewAId) === "FAILED" ||
            statusOf.get(c.reviewBId) === "FAILED",
          voted: c.voteId != null,
        }));
        const voted = comparisons.filter((c) => c.voted).length;
        totalVotes += voted;
        paperStates.push({
          paperIndex: index,
          paperId: paper.id,
          status: paper.status,
          title: paper.userTitle ?? paper.extractedTitle ?? null,
          reviewsCompleted: revRows.filter((r) => r.status === "COMPLETED").length,
          reviewsFailed: revRows.filter((r) => r.status === "FAILED").length,
          reviewsTotal: revRows.length,
          comparisons,
          votesCast: voted,
          done: voted === PAIRS_PER_PAPER,
        });
      }

      res.json({
        participantId: participant.id,
        papersPerParticipant: PAPERS_PER_PARTICIPANT,
        pairsPerPaper: PAIRS_PER_PAPER,
        papers: paperStates,
        totalVotes,
        studyDone: totalVotes === PAPERS_PER_PARTICIPANT * PAIRS_PER_PAPER,
      });
    } catch (e) {
      next(e);
    }
  });

  // ── uploads ──────────────────────────────────────────────────────────
  async function beginStudyPaper(
    participantId: string,
    contentHash: string,
    userTitle: string | undefined,
    conference: string,
  ) {
    // All six systems must be enabled or the design is unfillable —
    // refuse loudly rather than silently generating a subset.
    const enabled = await db.query.reviewSystems.findMany({
      where: eq(reviewSystems.enabled, true),
      columns: { slug: true },
    });
    const enabledSlugs = new Set(enabled.map((s) => s.slug));
    const missing = STUDY_SLUGS.filter((s) => !enabledSlugs.has(s));
    if (missing.length > 0) {
      throw Object.assign(
        new Error(`study needs all six systems enabled; missing: ${missing.join(", ")}`),
        { statusCode: 409 },
      );
    }

    const byIndex = await papersFor(participantId);
    let paperIndex = 1;
    for (let i = 1; i <= PAPERS_PER_PARTICIPANT; i++) {
      const existing = byIndex.get(i);
      if (!existing || existing.status === "PARSE_FAILED") {
        paperIndex = i;
        break;
      }
      const comps = await db.query.studyComparisons.findMany({
        where: eq(studyComparisons.paperId, existing.id),
      });
      const voted = comps.filter((c) => c.voteId != null).length;
      if (i === PAPERS_PER_PARTICIPANT && voted === PAIRS_PER_PAPER) {
        throw Object.assign(new Error("all study papers already uploaded"), {
          statusCode: 409,
        });
      }
      if (voted < PAIRS_PER_PAPER) {
        throw Object.assign(
          new Error(`finish the ${PAIRS_PER_PAPER} comparisons on paper ${i} first`),
          { statusCode: 409 },
        );
      }
      paperIndex = i + 1;
    }

    const participantIndex = Number(participantId.replace(/^P/i, ""));
    const rotationId = rotationsForParticipant(participantIndex)[paperIndex - 1]!;

    const [paper] = await db
      .insert(papers)
      .values({
        contentHash,
        userTitle: userTitle || null,
        status: "PARSING",
        // The participant picks the venue exactly as on the arena upload
        // page; all six generated reviews follow that venue's form.
        conference,
        participantId,
        paperIndex,
        rotationId,
      })
      .returning();
    return paper!;
  }

  /** Parse → precreate 6 reviews → fix the 3 rotation comparisons → generate. */
  async function runStudyPipeline(
    paperId: string,
    parse: () => Promise<ParsedPaper>,
  ): Promise<void> {
    try {
      const parsed = stripNullBytes(await parse());
      const [updated] = await db
        .update(papers)
        .set({
          status: "PARSED",
          extractedTitle: parsed.title,
          abstract: parsed.abstract,
          authors: parsed.authors,
          pageCount: parsed.pageCount,
          parsedStructure: parsed as unknown as object,
          canonicalText: parsed.canonicalText ?? null,
          canonicalTokens: parsed.canonicalTokens ?? null,
          fullTokens: parsed.fullTokens ?? null,
          lengthBand: lengthBandFor(parsed.fullTokens ?? null),
          updatedAt: new Date(),
        })
        .where(eq(papers.id, paperId))
        .returning();
      const paper = updated!;

      const systems = await db.query.reviewSystems.findMany({
        where: inArray(reviewSystems.slug, [...STUDY_SLUGS]),
      });
      const bySlug = new Map(systems.map((s) => [s.slug, s]));

      // Precreate the six rows first so the rotation's comparisons can be
      // pinned (with their blinding coin flips) before generation starts.
      const reviewIdBySlug = new Map<string, string>();
      for (const slug of STUDY_SLUGS) {
        const [row] = await db
          .insert(reviews)
          .values({
            paperId: paper.id,
            reviewSystemId: bySlug.get(slug)!.id,
            status: "GENERATING",
            judgeStatus: "PENDING",
          })
          .returning({ id: reviews.id });
        reviewIdBySlug.set(slug, row!.id);
      }

      const rotationPairs = pairsForRotation(paper.rotationId!);
      for (let i = 0; i < rotationPairs.length; i++) {
        const [slugX, slugY] = rotationPairs[i]!;
        const flip = Math.random() < 0.5;
        await db.insert(studyComparisons).values({
          paperId: paper.id,
          pairIndex: i + 1,
          reviewAId: reviewIdBySlug.get(flip ? slugX : slugY)!,
          reviewBId: reviewIdBySlug.get(flip ? slugY : slugX)!,
        });
      }

      const paperText = judge ? renderPaperText(parsed) : undefined;
      await Promise.all(
        STUDY_SLUGS.map((slug) =>
          generateIntoReview(
            reviewIdBySlug.get(slug)!,
            paper,
            parsed,
            bySlug.get(slug)!,
            reviewGen,
            judge,
            paperText,
          ),
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, paperId }, "study pipeline failed");
      await db
        .update(papers)
        .set({ status: "PARSE_FAILED", errorMessage: message, updatedAt: new Date() })
        .where(eq(papers.id, paperId));
    }
  }

  router.post("/study/papers", upload.single("file"), async (req, res, next) => {
    try {
      const participant = await participantFor(req.body.code);
      if (!participant) {
        res.status(404).json({ error: "UnknownCode", message: "Unknown participant code." });
        return;
      }
      const file = req.file;
      if (!file || file.mimetype !== "application/pdf") {
        res.status(400).json({ error: "BadRequest", message: "A PDF file is required." });
        return;
      }
      const contentHash = createHash("sha256").update(file.buffer).digest("hex");
      const conference = ConferenceSchema.catch("iclr").parse(req.body.conference);
      const paper = await beginStudyPaper(
        participant.id,
        contentHash,
        typeof req.body.title === "string" ? req.body.title : undefined,
        conference,
      );
      void runStudyPipeline(paper.id, () =>
        reviewGen.parsePdf(file.buffer, file.originalname),
      );
      res.status(202).json({ paperId: paper.id, paperIndex: paper.paperIndex });
    } catch (e) {
      handleStudyError(e, res, next);
    }
  });

  router.post("/study/papers/arxiv", async (req, res, next) => {
    try {
      const participant = await participantFor(req.body.code);
      if (!participant) {
        res.status(404).json({ error: "UnknownCode", message: "Unknown participant code." });
        return;
      }
      const arxivId = normalizeArxivId(String(req.body.url ?? ""));
      if (!arxivId) {
        res.status(400).json({ error: "BadRequest", message: "Not a recognizable arXiv URL or ID." });
        return;
      }
      const contentHash = createHash("sha256").update(`arxiv:${arxivId}`).digest("hex");
      const conference = ConferenceSchema.catch("iclr").parse(req.body.conference);
      const paper = await beginStudyPaper(
        participant.id,
        contentHash,
        typeof req.body.title === "string" ? req.body.title : undefined,
        conference,
      );
      void runStudyPipeline(paper.id, () => reviewGen.parseArxiv(arxivId));
      res.status(202).json({ paperId: paper.id, paperIndex: paper.paperIndex });
    } catch (e) {
      handleStudyError(e, res, next);
    }
  });

  // Re-dispatch FAILED generations into their existing rows, so the
  // rotation's comparisons (which reference those review ids) survive.
  router.post("/study/retry", async (req, res, next) => {
    try {
      const participant = await participantFor(req.body.code);
      if (!participant) {
        res.status(404).json({ error: "UnknownCode", message: "Unknown participant code." });
        return;
      }
      const paperId = String(req.body.paperId ?? "");
      const paper = await db.query.papers.findFirst({
        where: and(eq(papers.id, paperId), eq(papers.participantId, participant.id)),
      });
      if (!paper?.parsedStructure) {
        res.status(404).json({ error: "NotFound", message: "No such study paper." });
        return;
      }
      const failed = await db.query.reviews.findMany({
        where: and(eq(reviews.paperId, paper.id), eq(reviews.status, "FAILED")),
        with: { reviewSystem: true },
      });
      if (failed.length === 0) {
        res.json({ ok: true, retried: 0 });
        return;
      }
      await db
        .update(reviews)
        .set({ status: "GENERATING", judgeStatus: "PENDING", errorMessage: null, updatedAt: new Date() })
        .where(inArray(reviews.id, failed.map((r) => r.id)));
      const parsed = paper.parsedStructure as unknown as ParsedPaper;
      const paperText = judge ? renderPaperText(parsed) : undefined;
      for (const row of failed) {
        void generateIntoReview(
          row.id, paper, parsed, row.reviewSystem, reviewGen, judge, paperText,
        );
      }
      res.json({ ok: true, retried: failed.length });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /study/pair — one comparison's two blinded reviews ───────────
  router.get("/study/pair", async (req, res, next) => {
    try {
      const participant = await participantFor(req.query.code);
      if (!participant) {
        res.status(404).json({ error: "UnknownCode", message: "Unknown participant code." });
        return;
      }
      const comparisonId = String(req.query.comparisonId ?? "");
      const comp = await db.query.studyComparisons.findFirst({
        where: eq(studyComparisons.id, comparisonId),
      });
      const paper = comp
        ? await db.query.papers.findFirst({
            where: and(eq(papers.id, comp.paperId), eq(papers.participantId, participant.id)),
          })
        : null;
      if (!comp || !paper) {
        res.status(404).json({ error: "NotFound", message: "No such comparison." });
        return;
      }
      const pairReviews = await db.query.reviews.findMany({
        where: inArray(reviews.id, [comp.reviewAId, comp.reviewBId]),
      });
      const byId = new Map(pairReviews.map((r) => [r.id, r]));
      const a = byId.get(comp.reviewAId);
      const b = byId.get(comp.reviewBId);
      if (a?.status !== "COMPLETED" || b?.status !== "COMPLETED") {
        res.status(409).json({ error: "NotReady", message: "Reviews still generating." });
        return;
      }
      res.json({
        comparisonId: comp.id,
        pairIndex: comp.pairIndex,
        paperId: paper.id,
        paperTitle: paper.userTitle ?? paper.extractedTitle ?? null,
        conference: paper.conference,
        alreadyVoted: comp.voteId != null,
        reviewA: { reviewId: a.id, structured: a.structured, rawOutput: a.rawOutput ?? null },
        reviewB: { reviewId: b.id, structured: b.structured, rawOutput: b.rawOutput ?? null },
      });
    } catch (e) {
      next(e);
    }
  });

  // ── POST /study/votes — single-axis ──────────────────────────────────
  router.post("/study/votes", async (req, res, next) => {
    try {
      const participant = await participantFor(req.body.code);
      if (!participant) {
        res.status(404).json({ error: "UnknownCode", message: "Unknown participant code." });
        return;
      }
      const comparisonId = String(req.body.comparisonId ?? "");
      const winner = req.body.winner;
      if (winner !== "A" && winner !== "B" && winner !== "TIE") {
        res.status(400).json({ error: "BadRequest", message: "winner must be A, B or TIE." });
        return;
      }
      const comp = await db.query.studyComparisons.findFirst({
        where: eq(studyComparisons.id, comparisonId),
      });
      const paper = comp
        ? await db.query.papers.findFirst({
            where: and(eq(papers.id, comp.paperId), eq(papers.participantId, participant.id)),
          })
        : null;
      if (!comp || !paper) {
        res.status(404).json({ error: "NotFound", message: "No such comparison." });
        return;
      }
      if (comp.voteId != null) {
        res.status(409).json({ error: "AlreadyVoted", message: "This comparison is already voted." });
        return;
      }

      const decisionMsRaw = Number(req.body.decisionMs);
      const vote = await db.transaction(async (tx) => {
        const [v] = await tx
          .insert(votes)
          .values({
            paperId: paper.id,
            reviewAId: comp.reviewAId,
            reviewBId: comp.reviewBId,
            winner,
            note:
              typeof req.body.note === "string" && req.body.note.trim()
                ? req.body.note.slice(0, 1000)
                : null,
            sessionId: req.sessionId,
            decisionMs:
              Number.isFinite(decisionMsRaw) && decisionMsRaw >= 0
                ? Math.min(Math.round(decisionMsRaw), 60 * 60_000)
                : null,
            mode: "STUDY",
            participantId: participant.id,
          })
          .returning({ id: votes.id });
        const linked = await tx
          .update(studyComparisons)
          .set({ voteId: v!.id })
          .where(and(eq(studyComparisons.id, comp.id), isNull(studyComparisons.voteId)))
          .returning({ id: studyComparisons.id });
        // Double-submit race: someone else linked a vote first — abort ours.
        if (linked.length === 0) throw Object.assign(new Error("already voted"), { statusCode: 409 });
        return v!;
      });

      const comps = await db.query.studyComparisons.findMany({
        where: eq(studyComparisons.paperId, paper.id),
      });
      const votesOnPaper = comps.filter((c) => c.voteId != null).length;
      res.json({
        ok: true,
        voteId: vote.id,
        votesOnPaper,
        paperDone: votesOnPaper === PAIRS_PER_PAPER,
        paperIndex: paper.paperIndex,
        studyDone:
          paper.paperIndex === PAPERS_PER_PARTICIPANT && votesOnPaper === PAIRS_PER_PAPER,
      });
    } catch (e) {
      handleStudyError(e, res, next);
    }
  });

  // ── GET /study/reveal — identities, only after the paper's 3 votes ───
  router.get("/study/reveal", async (req, res, next) => {
    try {
      const participant = await participantFor(req.query.code);
      if (!participant) {
        res.status(404).json({ error: "UnknownCode", message: "Unknown participant code." });
        return;
      }
      const paperId = String(req.query.paperId ?? "");
      const paper = await db.query.papers.findFirst({
        where: and(eq(papers.id, paperId), eq(papers.participantId, participant.id)),
      });
      if (!paper) {
        res.status(404).json({ error: "NotFound", message: "No such study paper." });
        return;
      }
      const comps = await db.query.studyComparisons.findMany({
        where: eq(studyComparisons.paperId, paper.id),
        orderBy: asc(studyComparisons.pairIndex),
      });
      if (comps.some((c) => c.voteId == null)) {
        res.status(403).json({
          error: "NotYetRevealed",
          message: "Finish all three comparisons on this paper first.",
        });
        return;
      }
      const reviewIds = comps.flatMap((c) => [c.reviewAId, c.reviewBId]);
      const revRows = await db.query.reviews.findMany({
        where: inArray(reviews.id, reviewIds),
        with: { reviewSystem: true },
      });
      const voteRows = await db.query.votes.findMany({
        where: inArray(votes.id, comps.map((c) => c.voteId!)),
      });
      const systemOf = new Map(revRows.map((r) => [r.id, r.reviewSystem]));
      const voteOf = new Map(voteRows.map((v) => [v.id, v]));
      res.json({
        paperIndex: paper.paperIndex,
        comparisons: comps.map((c) => ({
          pairIndex: c.pairIndex,
          systemA: {
            slug: systemOf.get(c.reviewAId)!.slug,
            name: systemOf.get(c.reviewAId)!.name,
          },
          systemB: {
            slug: systemOf.get(c.reviewBId)!.slug,
            name: systemOf.get(c.reviewBId)!.name,
          },
          winner: voteOf.get(c.voteId!)!.winner,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

function handleStudyError(
  e: unknown,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  const status = (e as { statusCode?: number })?.statusCode;
  if (status && status >= 400 && status < 500 && e instanceof Error) {
    res.status(status).json({ error: "StudyConflict", message: e.message });
    return;
  }
  next(e);
}

