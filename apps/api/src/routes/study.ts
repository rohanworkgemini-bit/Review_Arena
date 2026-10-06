/**
 * Controlled-study routes (/study/*).
 *
 * The arena's uniform sampler is replaced by the preregistered design in
 * src/study/rotation.ts: 2 papers × 3 disjoint pairs per participant, with
 * each paper's rotation drawn round-robin over the whole study so the 15
 * system pairs stay evenly measured (exactly 8 times each at 20
 * participants). Participants are an open pool of anonymous codes — no
 * numbered slots, no schedule fixed to an identity — and authenticate with
 * a secret code (capability token, no PII).
 *
 * Flow per paper: upload → ALL six systems generate server-side → the
 * rotation's three comparisons unlock as their reviews complete → three
 * votes on the SAME eight dimensions the arena uses → per-paper reveal
 * (identities only — no ratings, no judge output, so later votes aren't
 * anchored on scores).
 *
 * Voting is deliberately identical to the arena (all eight dimensions
 * required, one `dimension_votes` row each). The rotation's deterministic
 * pairing is the *only* intended difference between the two modes, so
 * study data drops straight into the same per-dimension BT analysis.
 *
 * Study votes are tagged mode=STUDY but COUNT TOWARD THE LIVE LEADERBOARD
 * exactly like arena votes — eligibleVoteWhere (routes/votes.ts) filters on
 * review/judge status, qualityFlagged and test participants, never on mode. The tag is
 * for offline analysis (mean-centred BT + participant-level cluster
 * bootstrap), not for excluding them from the board.
 *
 * Participants still don't see standings mid-session: the study flow has
 * no leaderboard nav, and the link is unlocked only on the final reveal,
 * after their last vote is recorded. Note this is a per-session guard, not
 * a global one — a later participant's board does include earlier
 * participants' votes.
 */
import { Router } from "express";
import multer from "multer";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  dimensionVotes,
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
import { DECISION_TIME_FLOOR_MS, scheduleSnapshotRecompute } from "./votes.js";
import { renderPaperText } from "../pipeline/score-paper.js";
import { lengthBandFor, normalizeArxivId } from "./papers-helpers.js";
import { stripNullBytes } from "./papers.js";
import { logger } from "../logger.js";
import type { Config } from "../config.js";
import {
  ConferenceSchema,
  SubmitVoteRequestSchema,
  VOTE_DIMENSIONS,
  WinnerSchema,
  type ParsedPaper,
} from "@reviewarena/shared-types";
import type { Request, Response } from "express";
import {
  PAIRS_PER_PAPER,
  PAPERS_PER_PARTICIPANT,
  STUDY_SLUGS,
  nextRotationId,
  pairsForRotation,
} from "../study/rotation.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/**
 * Per-dimension picks for a study vote: literally the arena's
 * SubmitVoteRequestSchema `dimensions` field — all eight, no duplicates,
 * winner "A" / "B" / "TIE" in the same encoding as the overall verdict.
 * Enforced server-side for the same reason the arena does it: a non-UI
 * client must not be able to write sparse rows that would skew the
 * per-dimension boards. Reused rather than copied so the two modes cannot
 * drift apart.
 */
const StudyDimensionsSchema = SubmitVoteRequestSchema.shape.dimensions;

/** Arena default venue when none / an invalid one is sent — matches
 *  routes/papers.ts and the Python service ("general"). */
const DEFAULT_CONFERENCE = "general" as const;

/**
 * Postgres advisory-lock key serialising study paper creation (paper index
 * + rotation draw + insert). Any constant int8 that no other lock uses;
 * 0x57D7 = "STuDy" mnemonic, distinct from votes.ts' ELO_WRITER_LOCK.
 */
const STUDY_UPLOAD_LOCK = 0x57d7;

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Brute-force guard on participant-code lookups. Codes are capability
 * tokens and every code-taking endpoint answers 404 vs 200, so without a
 * cap the (small) code space can be enumerated. Only FAILED lookups count;
 * once an IP exceeds the cap it gets 429 for any code it has not already
 * verified in this window, so a participant who is mid-session on a shared
 * (lab NAT) IP keeps working while new guesses are refused. In-memory and
 * per process — fine for the single API container; relies on
 * `trust proxy` (server.ts) so req.ip is the real client.
 */
export class FailedLookupLimiter {
  private buckets = new Map<
    string,
    { failures: number; windowStart: number; verified: Set<string> }
  >();

  constructor(
    private readonly maxFailures = 30,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private bucket(key: string) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { failures: 0, windowStart: t, verified: new Set() };
      this.buckets.set(key, b);
    } else if (t - b.windowStart >= this.windowMs) {
      // New window: failures reset; codes this IP already proved stay valid.
      b.failures = 0;
      b.windowStart = t;
    }
    if (this.buckets.size > 10_000) this.prune(t);
    return b;
  }

  private prune(t: number) {
    for (const [k, b] of this.buckets) {
      if (t - b.windowStart >= this.windowMs) this.buckets.delete(k);
    }
  }

  /** True if this key may look up `code` right now. */
  allowed(key: string, code: string): boolean {
    const b = this.bucket(key);
    return b.failures < this.maxFailures || b.verified.has(code);
  }

  recordFailure(key: string): void {
    this.bucket(key).failures++;
  }

  recordSuccess(key: string, code: string): void {
    const b = this.bucket(key);
    if (b.verified.size < 100) b.verified.add(code);
  }
}

const codeLookupLimiter = new FailedLookupLimiter();

export function studyRouter(
  config: Config,
  reviewGen: ReviewGenClient,
  judge?: JudgeClient,
): Router {
  const router = Router();

  // ── participant lookup ────────────────────────────────────────────────
  /**
   * Resolve the participant for `code`, or send the error response and
   * return null: 404 for an unknown code, 429 once this IP has too many
   * failed lookups (see FailedLookupLimiter).
   */
  async function participantFor(req: Request, res: Response, code: unknown) {
    const ip = req.ip ?? "unknown";
    const codeStr = typeof code === "string" ? code : "";
    if (!codeLookupLimiter.allowed(ip, codeStr)) {
      logger.warn({ ip }, "study_code_lookup_rate_limited");
      res.status(429).json({
        error: "TooManyRequests",
        message: "Too many unknown participant codes. Please wait a few minutes and try again.",
      });
      return null;
    }
    const participant =
      codeStr.length >= 6
        ? ((await db.query.participants.findFirst({
            where: eq(participants.code, codeStr),
          })) ?? null)
        : null;
    if (!participant) {
      codeLookupLimiter.recordFailure(ip);
      res.status(404).json({ error: "UnknownCode", message: "Unknown participant code." });
      return null;
    }
    codeLookupLimiter.recordSuccess(ip, codeStr);
    return participant;
  }

  /** Latest non-parse-failed paper per paperIndex for a participant. */
  async function papersFor(participantId: string, executor: DbExecutor = db) {
    const rows = await executor.query.papers.findMany({
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

  /**
   * How many study papers each rotation is currently carrying. Parse
   * failures are excluded so a dead upload does not consume a rotation —
   * the participant's retry gets the same one back. Dry-run (is_test)
   * participants' papers are excluded too: they still draw a rotation for
   * themselves, but must not consume slots and unbalance real pair
   * coverage.
   */
  async function rotationUsage(executor: DbExecutor = db): Promise<Map<number, number>> {
    const rows = await executor.execute(sql`
      select pa.rotation_id, count(*)::int as n
      from papers pa
      join participants pt on pt.id = pa.participant_id
      where pa.rotation_id is not null
        and pa.status <> 'PARSE_FAILED'
        and not pt.is_test
      group by pa.rotation_id`);
    const usage = new Map<number, number>();
    for (const r of rows.rows as unknown as { rotation_id: number; n: number }[]) {
      usage.set(Number(r.rotation_id), Number(r.n));
    }
    return usage;
  }

  // ── GET /study/state ─────────────────────────────────────────────────
  router.get("/study/state", async (req, res, next) => {
    try {
      const participant = await participantFor(req, res, req.query.code);
      if (!participant) return;
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

    // Index pick + rotation draw + insert run under one study-wide advisory
    // lock (same pattern as votes.ts' ELO_WRITER_LOCK). Without it a
    // double-submit could insert two papers with the same paperIndex (12
    // billable reviews instead of 6), and two participants uploading at
    // once could both read the same usage and draw the same least-used
    // rotation. The critical section is a few small queries, so the lock
    // is held only for milliseconds.
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${STUDY_UPLOAD_LOCK})`);

      const byIndex = await papersFor(participantId, tx);
      let paperIndex = 1;
      for (let i = 1; i <= PAPERS_PER_PARTICIPANT; i++) {
        const existing = byIndex.get(i);
        if (!existing || existing.status === "PARSE_FAILED") {
          paperIndex = i;
          break;
        }
        const comps = await tx.query.studyComparisons.findMany({
          where: eq(studyComparisons.paperId, existing.id),
        });
        const voted = comps.filter((c) => c.voteId != null).length;
        if (i === PAPERS_PER_PARTICIPANT && voted === PAIRS_PER_PAPER) {
          throw Object.assign(new Error("all study papers already uploaded"), {
            statusCode: 409,
          });
        }
        if (voted < PAIRS_PER_PAPER) {
          // The same document re-submitted while this paper is still open
          // (double-click, client retry after a dropped response) is
          // idempotent: hand back the paper already in flight instead of
          // erroring or starting a second set of generations.
          if (voted === 0 && existing.contentHash === contentHash) {
            return { paper: existing, created: false };
          }
          throw Object.assign(
            new Error(`finish the ${PAIRS_PER_PAPER} comparisons on paper ${i} first`),
            { statusCode: 409 },
          );
        }
        paperIndex = i + 1;
      }

      // The rotation is drawn here rather than read off a pre-assigned
      // participant slot: least-used rotation across the whole study, minus
      // whatever this participant's other paper already holds. See
      // nextRotationId() for why that still lands on even pair coverage.
      const rotationId = nextRotationId(
        await rotationUsage(tx),
        [...byIndex.values()]
          .filter((p) => p.status !== "PARSE_FAILED" && p.rotationId != null)
          .map((p) => p.rotationId!),
      );

      const [paper] = await tx
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
      return { paper: paper!, created: true };
    });
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
      const participant = await participantFor(req, res, req.body.code);
      if (!participant) return;
      const file = req.file;
      if (!file || file.mimetype !== "application/pdf") {
        res.status(400).json({ error: "BadRequest", message: "A PDF file is required." });
        return;
      }
      const contentHash = createHash("sha256").update(file.buffer).digest("hex");
      const conference = ConferenceSchema.catch(DEFAULT_CONFERENCE).parse(req.body.conference);
      const { paper, created } = await beginStudyPaper(
        participant.id,
        contentHash,
        typeof req.body.title === "string" ? req.body.title : undefined,
        conference,
      );
      if (created) {
        void runStudyPipeline(paper.id, () =>
          reviewGen.parsePdf(file.buffer, file.originalname),
        );
      }
      res.status(202).json({ paperId: paper.id, paperIndex: paper.paperIndex });
    } catch (e) {
      handleStudyError(e, res, next);
    }
  });

  router.post("/study/papers/arxiv", async (req, res, next) => {
    try {
      const participant = await participantFor(req, res, req.body.code);
      if (!participant) return;
      const arxivId = normalizeArxivId(String(req.body.url ?? ""));
      if (!arxivId) {
        res.status(400).json({ error: "BadRequest", message: "Not a recognizable arXiv URL or ID." });
        return;
      }
      const contentHash = createHash("sha256").update(`arxiv:${arxivId}`).digest("hex");
      const conference = ConferenceSchema.catch(DEFAULT_CONFERENCE).parse(req.body.conference);
      const { paper, created } = await beginStudyPaper(
        participant.id,
        contentHash,
        typeof req.body.title === "string" ? req.body.title : undefined,
        conference,
      );
      if (created) void runStudyPipeline(paper.id, () => reviewGen.parseArxiv(arxivId));
      res.status(202).json({ paperId: paper.id, paperIndex: paper.paperIndex });
    } catch (e) {
      handleStudyError(e, res, next);
    }
  });

  // Re-dispatch FAILED generations into their existing rows, so the
  // rotation's comparisons (which reference those review ids) survive.
  router.post("/study/retry", async (req, res, next) => {
    try {
      const participant = await participantFor(req, res, req.body.code);
      if (!participant) return;
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
      const participant = await participantFor(req, res, req.query.code);
      if (!participant) return;
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

  // ── POST /study/votes — overall verdict + all eight dimensions ───────
  router.post("/study/votes", async (req, res, next) => {
    try {
      const participant = await participantFor(req, res, req.body.code);
      if (!participant) return;
      const comparisonId = String(req.body.comparisonId ?? "");
      const parsedWinner = WinnerSchema.safeParse(req.body.winner);
      if (!parsedWinner.success) {
        res.status(400).json({ error: "BadRequest", message: "winner must be A, B or TIE." });
        return;
      }
      const winner = parsedWinner.data;
      const parsedDimensions = StudyDimensionsSchema.safeParse(req.body.dimensions);
      if (!parsedDimensions.success) {
        res.status(400).json({
          error: "BadRequest",
          message:
            parsedDimensions.error.issues[0]?.message ??
            `All ${VOTE_DIMENSIONS.length} voting dimensions must be provided.`,
        });
        return;
      }
      const dimensions = parsedDimensions.data;
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
      const decisionMs =
        req.body.decisionMs != null && Number.isFinite(decisionMsRaw) && decisionMsRaw >= 0
          ? Math.min(Math.round(decisionMsRaw), 60 * 60_000)
          : null;
      // Same <3s rule as arena votes (routes/votes.ts); a missing time is
      // not flagged there either. Flagged rows are recorded but dropped
      // from every board by eligibleVoteWhere.
      const qualityFlagged = (decisionMs ?? Infinity) < DECISION_TIME_FLOOR_MS;
      if (qualityFlagged) {
        logger.info(
          { decisionMs, participantId: participant.id, sessionId: req.sessionId },
          "study_vote_flagged: decision time below floor",
        );
      }
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
            decisionMs,
            qualityFlagged,
            mode: "STUDY",
            participantId: participant.id,
          })
          .returning({ id: votes.id });
        // Same shape the arena writes (routes/votes.ts) — the schema above
        // guarantees all eight are present, so study rows are never sparse.
        await tx.insert(dimensionVotes).values(
          dimensions.map((d) => ({
            voteId: v!.id,
            dimension: d.dimension,
            winner: d.winner,
            note: d.note?.trim() ? d.note.trim() : null,
          })),
        );
        const linked = await tx
          .update(studyComparisons)
          .set({ voteId: v!.id })
          .where(and(eq(studyComparisons.id, comp.id), isNull(studyComparisons.voteId)))
          .returning({ id: studyComparisons.id });
        // Double-submit race: someone else linked a vote first — abort ours.
        if (linked.length === 0) throw Object.assign(new Error("already voted"), { statusCode: 409 });
        return v!;
      });

      // Study votes count toward the live boards exactly like arena votes,
      // so they must trigger the same recompute. Without this the snapshot
      // tables only ever advance on an ARENA vote, and a study-only run
      // leaves the leaderboard frozen at whatever the last arena vote saw.
      scheduleSnapshotRecompute(vote.id, config.RATING_BASELINE_SLUG);

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
      const participant = await participantFor(req, res, req.query.code);
      if (!participant) return;
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

