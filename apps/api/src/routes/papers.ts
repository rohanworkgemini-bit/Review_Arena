import { Router, type Response } from "express";
import multer from "multer";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { reviewSystems } from "../db/schema.js";
import { db } from "../db/client.js";
import { papers, reviews } from "../db/schema.js";
import type { ReviewGenClient } from "../clients/review-gen-client.js";
import type { JudgeClient } from "../clients/judge-client.js";
import type { Orchestrator } from "../pipeline/orchestrator.js";
import { selectUploadPair } from "../pair/select-upload-pair.js";
import { logger } from "../logger.js";
import type { Config } from "../config.js";
import { requireAdmin } from "../plugins/admin-auth.js";
import {
  lengthBandFor,
  normalizeArxivId,
  recordUpload,
  UPLOADS_PER_WINDOW,
} from "./papers-helpers.js";
import {
  UploadPaperResponseSchema,
  PaperDetailResponseSchema,
} from "./schemas.js";
import { ConferenceSchema } from "@reviewarena/shared-types";
import { ARENA_DISABLED_MESSAGE, isArenaEnabled } from "../settings.js";

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Postgres JSONB columns and TEXT columns reject `\u0000` (NUL byte) —
 * inserting one throws `unsupported Unicode escape sequence`. Chandra's
 * OCR output occasionally contains NUL when a PDF embeds binary blobs
 * (rasterized figures, font subsets). Strip them defensively before any
 * DB write. Pure NUL has no meaning in our markdown / metadata anyway.
 */
export function stripNullBytes<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\x00/g, "") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(stripNullBytes) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = stripNullBytes(v);
    }
    return out as T;
  }
  return value;
}

// In-memory upload buffer. We never persist the PDF to disk — it's hashed
// for dedup, shipped to Marker for parsing, and dropped. The parsed
// structure (sections, refs, abstract) lives in papers.parsedStructure
// jsonb; that's all downstream consumers need.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

export interface PapersDeps {
  reviewGen: ReviewGenClient;
  judge: JudgeClient;
  orchestrator: Orchestrator;
}

export function papersRouter(config: Config, deps: PapersDeps): Router {
  const router = Router();
  const { reviewGen, judge, orchestrator } = deps;

  // The study window closes the arena (settings.ts isArenaEnabled). Checked
  // before the rate limiter so a refused upload does not also burn one of
  // the session's ten slots, and before multer has done anything with the
  // body beyond buffering it.
  const arenaClosed = async (res: Response): Promise<boolean> => {
    if (await isArenaEnabled()) return false;
    res.status(503).json({
      error: "ArenaDisabled",
      message: ARENA_DISABLED_MESSAGE,
    });
    return true;
  };

  router.post("/papers", upload.single("file"), async (req, res, next) => {
    try {
      if (await arenaClosed(res)) return;
      if (!recordUpload(req.sessionId)) {
        logger.warn({ sessionId: req.sessionId }, "upload_rate_limit_exceeded");
        res.status(429).json({
          error: "TooManyRequests",
          message: `At most ${UPLOADS_PER_WINDOW} uploads per minute per session.`,
        });
        return;
      }
      if (!req.file) {
        logger.warn({ sessionId: req.sessionId }, "upload_missing_file");
        res.status(400).json({ error: "BadRequest", message: "Multipart field `file` required." });
        return;
      }
      if (req.file.mimetype !== "application/pdf") {
        logger.warn({ sessionId: req.sessionId, mimetype: req.file.mimetype }, "upload_wrong_mimetype");
        res.status(400).json({ error: "BadRequest", message: "Only application/pdf accepted." });
        return;
      }

      // Data-processing consent (see web /consent). Multipart fields are
      // strings, so the checkbox arrives as "true". Enforced server-side
      // so a non-UI client can't submit papers into the commercial-API
      // pipeline without the notice being accepted.
      if (req.body.consent !== "true") {
        logger.warn({ sessionId: req.sessionId }, "upload_missing_consent");
        res.status(400).json({
          error: "ConsentRequired",
          message:
            "Uploading requires accepting the data-processing notice (see /consent).",
        });
        return;
      }

      const userTitle = typeof req.body.title === "string" ? req.body.title : null;
      // Venue whose review form the generated reviews follow. Validated
      // against the shared enum; malformed values fall back to iclr
      // rather than 400 — the scale choice must never lose an upload.
      const confParse = ConferenceSchema.safeParse(req.body.conference);
      const conference = confParse.success ? confParse.data : "iclr";
      const pdfBuffer = req.file.buffer;
      const filename = req.file.originalname || "paper.pdf";
      const hash = createHash("sha256").update(pdfBuffer).digest("hex");

      // No dedup. Every upload — even of the same PDF — creates a fresh
      // paper row + a fresh review pair. The user wants iteration: change
      // section selection, re-upload, get new reviews without dedup
      // short-circuits or stale completed rows polluting the picker.
      // contentHash is kept (non-unique) for analytics / "how many times
      // has paper X been reviewed".

      const [created] = await db
        .insert(papers)
        .values({
          contentHash: hash,
          userTitle,
          status: "PARSING",
          uploadedBySessionId: req.sessionId,
          consentAcceptedAt: new Date(),
          conference,
        })
        .returning();
      const paper = created!;

      void runPipeline(paper.id, pdfBuffer, filename).catch((err) => {
        req.log?.error?.({ err, paperId: paper.id }, "pipeline crashed");
      });

      const uploadPayload = { paperId: paper.id, status: "PARSING", deduplicated: false };
      const validated = UploadPaperResponseSchema.parse(uploadPayload);
      res.status(201).json(validated);
    } catch (e) {
      next(e);
    }
  });

  // arXiv URL/ID upload path — bypasses Marker, parses via arxiv2md.
  // Body: { url: string, title?: string, systemSlugs?: string[] }
  router.post("/papers/arxiv", async (req, res, next) => {
    try {
      if (await arenaClosed(res)) return;
      if (!recordUpload(req.sessionId)) {
        res.status(429).json({
          error: "TooManyRequests",
          message: `At most ${UPLOADS_PER_WINDOW} uploads per minute per session.`,
        });
        return;
      }
      // Data-processing consent — JSON body, so a real boolean here.
      if (req.body?.consent !== true) {
        logger.warn({ sessionId: req.sessionId }, "upload_missing_consent");
        res.status(400).json({
          error: "ConsentRequired",
          message:
            "Uploading requires accepting the data-processing notice (see /consent).",
        });
        return;
      }
      const raw = typeof req.body?.url === "string" ? req.body.url : "";
      const arxivId = normalizeArxivId(raw);
      if (!arxivId) {
        res.status(400).json({
          error: "BadRequest",
          message: "`url` must be an arXiv URL or ID (e.g. 2312.00752 or https://arxiv.org/abs/2312.00752).",
        });
        return;
      }
      const userTitle = typeof req.body.title === "string" ? req.body.title : null;
      const confParse = ConferenceSchema.safeParse(req.body.conference);
      const conference = confParse.success ? confParse.data : "iclr";

      // No dedup — every arxiv upload creates a fresh paper row + review
      // pair, matching the PDF route. Use a session-scoped hash so the
      // contentHash column is still populated (useful for analytics) but
      // collisions are negligible across uploads.
      const hash = createHash("sha256")
        .update(`arxiv2md:${arxivId}:${req.sessionId ?? ""}:${Date.now()}`)
        .digest("hex");

      const [created] = await db
        .insert(papers)
        .values({
          contentHash: hash,
          userTitle,
          status: "PARSING",
          uploadedBySessionId: req.sessionId,
          consentAcceptedAt: new Date(),
          conference,
        })
        .returning();
      const paper = created!;
      void runArxivPipeline(paper.id, arxivId).catch((err) => {
        req.log?.error?.({ err, paperId: paper.id }, "pipeline crashed");
      });
      const uploadPayload = { paperId: paper.id, status: "PARSING", deduplicated: false };
      const validated = UploadPaperResponseSchema.parse(uploadPayload);
      res.status(201).json(validated);
    } catch (e) {
      next(e);
    }
  });

  // Enabled review systems for the /admin playground dropdown. Light
  // projection — slug, name, description.
  router.get("/review-systems", async (_req, res, next) => {
    try {
      const rows = await db.query.reviewSystems.findMany({
        where: eq(reviewSystems.enabled, true),
        columns: { slug: true, name: true, description: true },
      });
      res.json({ systems: rows });
    } catch (e) {
      next(e);
    }
  });

  // /dev "Reviewer Playground" — parse + generate in one shot for a
  // chosen system, return the review (non-streaming). Doesn't touch the
  // papers/reviews tables — pure throwaway call for testing systems.
  // ADMIN-ONLY: gated by Bearer token (requireAdmin). Billable.
  // Body: multipart with `file` (PDF) + `systemSlug`, OR JSON
  // {url: arxivUrl, systemSlug}.
  router.post(
    "/reviews/playground",
    requireAdmin(config.ADMIN_TOKEN),
    upload.single("file"),
    async (req, res, next) => {
      try {
        if (!recordUpload(req.sessionId)) {
          res.status(429).json({
            error: "TooManyRequests",
            message: `At most ${UPLOADS_PER_WINDOW} uploads per minute per session.`,
          });
          return;
        }
        const systemSlug =
          (typeof req.body.systemSlug === "string" ? req.body.systemSlug : "").trim();
        if (!systemSlug) {
          res.status(400).json({ error: "BadRequest", message: "systemSlug required" });
          return;
        }
        const system = await db.query.reviewSystems.findFirst({
          where: eq(reviewSystems.slug, systemSlug),
        });
        if (!system || !system.enabled) {
          res.status(404).json({
            error: "NotFound",
            message: `system '${systemSlug}' not found or disabled`,
          });
          return;
        }

        // Two input paths: PDF multipart OR arxiv URL in JSON-ish body.
        let parsed;
        if (req.file) {
          if (req.file.mimetype !== "application/pdf") {
            res.status(400).json({ error: "BadRequest", message: "Only application/pdf accepted." });
            return;
          }
          parsed = await reviewGen.parsePdf(req.file.buffer, req.file.originalname || "paper.pdf");
        } else if (typeof req.body.url === "string" && req.body.url.trim()) {
          const arxivId = normalizeArxivId(req.body.url.trim());
          if (!arxivId) {
            res.status(400).json({
              error: "BadRequest",
              message: "url must be a valid arXiv URL/ID",
            });
            return;
          }
          parsed = await reviewGen.parseArxiv(arxivId);
        } else {
          res.status(400).json({
            error: "BadRequest",
            message: "Provide either a `file` (PDF) or a `url` (arXiv).",
          });
          return;
        }

        const result = await reviewGen.generate(system.adapterKey, parsed, system.config ?? {});
        res.json({
          system: { slug: system.slug, name: system.name, adapterKey: system.adapterKey },
          paper: {
            title: parsed.title,
            pageCount: parsed.pageCount,
            source: parsed.source,
            canonicalTokens: parsed.canonicalTokens ?? null,
          },
          // Raw model input — exactly what was fed to the model as the user
          // message content. Each adapter prepends its own system prompt
          // (not surfaced here yet) but the user-message payload is identical
          // across systems: the canonical text stamped at parse time.
          canonicalText: parsed.canonicalText ?? null,
          review: result.review,
          rawOutput: result.rawOutput,
          generationMs: result.generationMs,
          metrics: result.metrics ?? null,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  router.get("/papers/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      const paper = await db.query.papers.findFirst({ where: eq(papers.id, id) });
      if (!paper) {
        res.status(404).json({ error: "NotFound", message: `paper ${id}` });
        return;
      }
      // Counts for the upload-page polling UI. `terminalReviewCount` is the
      // only safe "are we done generating" signal — `reviewCount` ticks up
      // as soon as the orchestrator inserts GENERATING rows (within ms of
      // upload), so it's useless for "ready to navigate to /compare".
      const [completedRow, terminalRow, totalRow, expectedRow] = await Promise.all([
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(reviews)
          .where(and(eq(reviews.paperId, id), eq(reviews.status, "COMPLETED"))),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(reviews)
          .where(
            and(
              eq(reviews.paperId, id),
              inArray(reviews.status, ["COMPLETED", "FAILED"]),
            ),
          ),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(reviews)
          .where(eq(reviews.paperId, id)),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(reviewSystems)
          .where(eq(reviewSystems.enabled, true)),
      ]);

      // The chosen pair's review IDs + slugs. Browser uses these to open
      // SSE streams (/reviews/stream/:reviewId) for token-level rendering.
      // Empty array until precreateReviews has run (i.e. status=PARSED).
      const pairRows = await db
        .select({
          reviewId: reviews.id,
          slug: reviewSystems.slug,
        })
        .from(reviews)
        .innerJoin(reviewSystems, eq(reviews.reviewSystemId, reviewSystems.id))
        .where(eq(reviews.paperId, id));

      // With the upload-time pair selector, expected = 2 for normal
      // Vote-Mode uploads (we only generate the pair). Fall back to
      // total enabled systems for legacy papers that pre-date the
      // streaming flow (their reviewIds row count differs).
      const expectedForPair = pairRows.length || expectedRow[0]?.c || 0;

      const payload = {
        id: paper.id,
        title: paper.userTitle ?? paper.extractedTitle,
        status: paper.status,
        pageCount: paper.pageCount,
        reviewCount: totalRow[0]?.c ?? 0,
        completedReviewCount: completedRow[0]?.c ?? 0,
        terminalReviewCount: terminalRow[0]?.c ?? 0,
        expectedReviewCount: expectedForPair,
        createdAt: paper.createdAt.toISOString(),
        reviewIds: pairRows,
      };
      const validated = PaperDetailResponseSchema.parse(payload);
      res.json(validated);
    } catch (e) {
      next(e);
    }
  });

  async function runPipeline(
    paperId: string,
    pdfBuffer: Buffer,
    filename: string,
  ): Promise<void> {
    try {
      // Chandra (Datalab-hosted) is the only PDF parser. No fallback —
      // if Chandra is unreachable or the PDF is image-only / non-academic,
      // the upload fails loudly (PARSE_FAILED) so the user knows their
      // paper wasn't actually processed.
      const parsed = stripNullBytes(await reviewGen.parsePdf(pdfBuffer, filename));
      const [updated] = await db
        .update(papers)
        .set({
          status: "PARSED",
          extractedTitle: parsed.title,
          abstract: parsed.abstract,
          authors: parsed.authors,
          pageCount: parsed.pageCount,
          parsedStructure: parsed as unknown as object,
          // FAIRNESS A1/C1 — store the canonical input + length band once.
          canonicalText: parsed.canonicalText ?? null,
          canonicalTokens: parsed.canonicalTokens ?? null,
          fullTokens: parsed.fullTokens ?? null,
          lengthBand: lengthBandFor(parsed.fullTokens ?? null),
          updatedAt: new Date(),
        })
        .where(eq(papers.id, paperId))
        .returning();
      // LMArena-style: pick exactly 2 systems with the uniform pair
      // selector and precreate review rows. The browser opens SSE
      // streams to /reviews/stream/:reviewId which trigger the model
      // calls and forward tokens live.
      const pairSlugs = await resolvePairSlugs(paperId);
      await orchestrator.precreateReviews(updated!, pairSlugs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, paperId }, "PDF pipeline failed");
      await db
        .update(papers)
        .set({ status: "PARSE_FAILED", errorMessage: message, updatedAt: new Date() })
        .where(eq(papers.id, paperId));
    }
  }

  // arXiv-ID upload path. Sends the URL to the Python service which
  // calls arxiv2md.org and returns a ParsedPaper in the same shape.
  // On failure, marks the paper PARSE_FAILED — same contract as the
  // PDF/Chandra path.
  async function runArxivPipeline(
    paperId: string,
    arxivId: string,
  ): Promise<void> {
    try {
      const parsed = stripNullBytes(await reviewGen.parseArxiv(arxivId));
      const [updated] = await db
        .update(papers)
        .set({
          status: "PARSED",
          extractedTitle: parsed.title,
          abstract: parsed.abstract,
          authors: parsed.authors,
          pageCount: parsed.pageCount,
          parsedStructure: parsed as unknown as object,
          // FAIRNESS A1/C1 — store the canonical input + length band once.
          canonicalText: parsed.canonicalText ?? null,
          canonicalTokens: parsed.canonicalTokens ?? null,
          fullTokens: parsed.fullTokens ?? null,
          lengthBand: lengthBandFor(parsed.fullTokens ?? null),
          updatedAt: new Date(),
        })
        .where(eq(papers.id, paperId))
        .returning();
      const pairSlugs = await resolvePairSlugs(paperId);
      await orchestrator.precreateReviews(updated!, pairSlugs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, paperId, arxivId }, "arXiv pipeline failed");
      await db
        .update(papers)
        .set({ status: "PARSE_FAILED", errorMessage: message, updatedAt: new Date() })
        .where(eq(papers.id, paperId));
    }
  }

  // Pick exactly 2 systems, uniformly at random over eligible pairs — we
  // only generate those 2, so an arena paper costs 2 review calls rather
  // than one per enabled system (2 of 6 today), and that does not change
  // as the pool grows. Study papers are the exception: they generate all
  // six, because the rotation needs three disjoint pairs from one paper.
  async function resolvePairSlugs(paperId: string): Promise<readonly string[]> {
    const pair = await selectUploadPair();
    if (!pair) {
      // Fewer than 2 enabled systems — let the orchestrator fan out to
      // whatever it finds (likely 0 or 1) so the failure surfaces
      // honestly as "no reviews generated".
      logger.warn(
        { paperId },
        "selectUploadPair returned null; orchestrator will use all enabled systems as fallback",
      );
      return [];
    }
    return [pair.slugA, pair.slugB];
  }

  return router;
}

