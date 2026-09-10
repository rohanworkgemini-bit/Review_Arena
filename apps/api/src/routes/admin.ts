import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { normalizeArxivId } from "./papers-helpers.js";
import {
  CreateReviewSystemRequestSchema,
  VOTE_DIMENSIONS,
} from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import { papers, reviews, reviewSystems, votes } from "../db/schema.js";
import { requireAdmin } from "../plugins/admin-auth.js";
import type { JudgeClient } from "../clients/judge-client.js";
import { scorePaper } from "../pipeline/score-paper.js";
import type { ReviewGenClient } from "../clients/review-gen-client.js";
import type { Orchestrator } from "../pipeline/orchestrator.js";
import type { ParsedPaper } from "@reviewarena/shared-types";
import { logger } from "../logger.js";
import type { Config } from "../config.js";
import {
  JUDGE_ENABLED,
  JUDGE_MODELS,
  clearSetting,
  getJudgeModels,
  isJudgeEnabled,
  setSetting,
} from "../settings.js";
import { arenaPanelSlugs } from "../pipeline/score-paper.js";
import { STUDY_SLUGS } from "../study/rotation.js";
import {
  AdminReviewSystemsListResponseSchema,
  ReviewSystemSchema,
  AdminRegenResponseSchema,
  AdminScoreResponseSchema,
  AdminExportResponseSchema,
} from "./schemas.js";

const UpdateReviewSystemSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    config: z.record(z.unknown()).optional(),
  })
  .strict();

export interface AdminDeps {
  reviewGen: ReviewGenClient;
  judge: JudgeClient;
  orchestrator: Orchestrator;
}

// Same in-memory multipart handling as the public upload route — the PDF
// is forwarded to review-gen and never written to disk.
const ADMIN_MAX_PDF_BYTES = 10 * 1024 * 1024;
const adminUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ADMIN_MAX_PDF_BYTES },
});

export function adminRouter(config: Config, deps: AdminDeps): Router {
  const router = Router();
  const guard = requireAdmin(config.ADMIN_TOKEN);

  const UpdateSettingsRequestSchema = z.object({
    judgeEnabled: z.boolean().optional(),
    // Which systems judge ARENA pairs. null restores "the whole panel";
    // [] means no arena judging. Study papers always use the full
    // preregistered panel regardless (settings.ts getJudgeModels).
    judgeModels: z.array(z.string().min(1)).nullable().optional(),
  });
  const { judge, orchestrator: orch, reviewGen } = deps;

  // All admin routes require the bearer token.
  router.use("/admin", guard);

  // ─── Review systems ────────────────────────────────────────────────

  router.get("/admin/review-systems", async (_req, res, next) => {
    try {
      const rows = await db.query.reviewSystems.findMany({
        orderBy: asc(reviewSystems.createdAt),
      });
      const payload = rows.map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        description: s.description,
        adapterKey: s.adapterKey,
        enabled: s.enabled,
        createdAt: s.createdAt.toISOString(),
      }));
      const validated = AdminReviewSystemsListResponseSchema.parse(payload);
      res.json(validated);
    } catch (e) {
      next(e);
    }
  });

  router.post("/admin/review-systems", async (req, res, next) => {
    try {
      const parse = CreateReviewSystemRequestSchema.safeParse(req.body);
      if (!parse.success) {
        res.status(400).json({
          error: "BadRequest",
          details: parse.error.flatten(),
        });
        return;
      }
      const body = parse.data;
      const [created] = await db
        .insert(reviewSystems)
        .values({
          slug: body.slug,
          name: body.name,
          description: body.description,
          adapterKey: body.adapterKey,
          config: body.config,
        })
        .returning();
      const c = created!;
      const payload = {
        id: c.id,
        slug: c.slug,
        name: c.name,
        description: c.description,
        adapterKey: c.adapterKey,
        enabled: c.enabled,
        createdAt: c.createdAt.toISOString(),
      };
      const validated = ReviewSystemSchema.parse(payload);
      res.status(201).json(validated);
    } catch (e) {
      next(e);
    }
  });

  router.patch("/admin/review-systems/:id", async (req, res, next) => {
    try {
      const parse = UpdateReviewSystemSchema.safeParse(req.body);
      if (!parse.success) {
        res.status(400).json({ error: "BadRequest", details: parse.error.flatten() });
        return;
      }
      const [updated] = await db
        .update(reviewSystems)
        .set({ ...parse.data, updatedAt: new Date() })
        .where(eq(reviewSystems.id, req.params.id))
        .returning();
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  // One-click enable/disable. Convenience wrapper over PATCH for the admin
  // UI's toggle button — saves the client a body construction.
  router.post("/admin/review-systems/:id/toggle", async (req, res, next) => {
    try {
      const existing = await db.query.reviewSystems.findFirst({
        where: eq(reviewSystems.id, req.params.id),
      });
      if (!existing) {
        res.status(404).json({ error: "NotFound", message: req.params.id });
        return;
      }
      const [updated] = await db
        .update(reviewSystems)
        .set({ enabled: !existing.enabled, updatedAt: new Date() })
        .where(eq(reviewSystems.id, req.params.id))
        .returning();
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  // Delete is allowed only when no Reviews reference this system — Reviews
  // have no ON DELETE CASCADE on `review_system_id` by design (we keep
  // historical votes traceable). Use disable instead of delete for systems
  // that already produced reviews.
  router.delete("/admin/review-systems/:id", async (req, res, next) => {
    try {
      const inUse = await db.query.reviews.findFirst({
        where: eq(reviews.reviewSystemId, req.params.id),
        columns: { id: true },
      });
      if (inUse) {
        res.status(409).json({
          error: "Conflict",
          message:
            "System has existing reviews; disable it instead so historical votes remain valid.",
        });
        return;
      }
      const [deleted] = await db
        .delete(reviewSystems)
        .where(eq(reviewSystems.id, req.params.id))
        .returning({ id: reviewSystems.id });
      if (!deleted) {
        res.status(404).json({ error: "NotFound", message: req.params.id });
        return;
      }
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // ─── Vote inspection ───────────────────────────────────────────────

  // ─── Runtime settings ───────────────────────────────────────────────
  // Two switches: whether the judge panel runs, and which sampler the open
  // arena uses to pair systems. Kept here rather than in .env so they can
  // be thrown between sessions without a redeploy.

  const readSettings = async () => ({
    judgeEnabled: await isJudgeEnabled(),
    // True when the environment forces it off, in which case the UI
    // switch cannot turn it back on and should say so rather than
    // appearing broken.
    judgeLockedOff:
      String(process.env.JUDGE_ENABLED ?? "").toLowerCase() === "false",
    // The resolved arena panel (what will actually judge), plus the raw
    // setting so the UI can distinguish "all, by default" from "all six,
    // explicitly chosen".
    judgeModels: await getJudgeModels(),
    arenaJudgeSlugs: await arenaPanelSlugs(),
    panelSlugs: [...STUDY_SLUGS],
  });

  router.get("/admin/settings", guard, async (_req, res, next) => {
    try {
      res.json(await readSettings());
    } catch (err) {
      next(err);
    }
  });

  router.patch("/admin/settings", guard, async (req, res, next) => {
    try {
      const body = UpdateSettingsRequestSchema.parse(req.body);
      if (body.judgeEnabled !== undefined) {
        await setSetting(JUDGE_ENABLED, body.judgeEnabled);
        logger.warn(
          { judgeEnabled: body.judgeEnabled },
          "admin_judge_toggle",
        );
      }
      if (body.judgeModels !== undefined) {
        // null means "no explicit choice", which is an absent row rather
        // than a stored null — app_settings.value is NOT NULL.
        if (body.judgeModels === null) await clearSetting(JUDGE_MODELS);
        else await setSetting(JUDGE_MODELS, body.judgeModels);
        logger.warn({ judgeModels: body.judgeModels }, "admin_judge_models");
      }
      res.json(await readSettings());
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/votes", async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 200), 1000);
      const rows = await db.query.votes.findMany({
        orderBy: desc(votes.createdAt),
        limit,
        with: {
          reviewA: { with: { reviewSystem: true } },
          reviewB: { with: { reviewSystem: true } },
          dimensions: true,
        },
      });
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  // ─── Parse passthrough ─────────────────────────────────────────────

  // The admin Parse tab used to call review-gen directly from the browser
  // via the /py-api Vercel rewrite. That only ever worked in local dev,
  // where the Vite proxy injects X-API-Key: a Vercel rewrite is a plain
  // proxy and cannot add headers, so in production review-gen answered
  // 401 "invalid or missing X-API-Key" for every request. The shared
  // secret must not be shipped to the browser to fix that, so these two
  // routes proxy through the API, which already holds it server-side.
  // Both are bearer-guarded by the router-level `guard` above and neither
  // touches the DB — same contract the tab documents.

  router.post(
    "/admin/parse",
    adminUpload.single("file"),
    async (req, res, next) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: "BadRequest", message: "No `file` provided." });
          return;
        }
        if (req.file.mimetype !== "application/pdf") {
          res
            .status(400)
            .json({ error: "BadRequest", message: "Only application/pdf accepted." });
          return;
        }
        const parsed = await reviewGen.parsePdf(
          req.file.buffer,
          req.file.originalname || "paper.pdf",
        );
        res.json(parsed);
      } catch (e) {
        next(e);
      }
    },
  );

  router.post("/admin/parse-arxiv", async (req, res, next) => {
    try {
      const raw = typeof req.body?.url === "string" ? req.body.url.trim() : "";
      if (!raw) {
        res
          .status(400)
          .json({ error: "BadRequest", message: "Provide `url` (arXiv URL or bare ID)." });
        return;
      }
      const arxivId = normalizeArxivId(raw);
      if (!arxivId) {
        res
          .status(400)
          .json({ error: "BadRequest", message: "url must be a valid arXiv URL/ID" });
        return;
      }
      const parsed = await reviewGen.parseArxiv(arxivId);
      res.json(parsed);
    } catch (e) {
      next(e);
    }
  });

  // ─── Regenerate stuck reviews ──────────────────────────────────────

  // Deletes any non-COMPLETED reviews for the paper and re-runs the
  // generation pipeline. Recovers from API restarts that orphaned
  // GENERATING rows mid-flight.
  router.post("/admin/papers/:id/regenerate", async (req, res, next) => {
    try {
      const paper = await db.query.papers.findFirst({
        where: eq(papers.id, req.params.id),
      });
      if (!paper) {
        res.status(404).json({ error: "NotFound", message: req.params.id });
        return;
      }
      if (!paper.parsedStructure) {
        res.status(400).json({
          error: "NotParsed",
          message: "Paper hasn't been parsed yet — re-upload it.",
        });
        return;
      }
      // Drop everything except COMPLETED so we don't re-run successful
      // generations and incur the cost.
      const deleted = await db
        .delete(reviews)
        .where(and(eq(reviews.paperId, paper.id), ne(reviews.status, "COMPLETED")))
        .returning({ id: reviews.id });
      // Fire-and-forget so the response returns immediately.
      void orch
        .generateAllReviews(paper, paper.parsedStructure as unknown as ParsedPaper)
        .catch((err) => req.log?.error?.({ err }, "regenerate crashed"));
      const payload = {
        ok: true,
        paperId: paper.id,
        dropped: deleted.length,
        message: "Generation re-dispatched. Poll GET /papers/:id for progress.",
      };
      const validated = AdminRegenResponseSchema.parse(payload);
      res.json(validated);
    } catch (e) {
      next(e);
    }
  });

  // ─── Score paper (Checkpoint 7 backfill trigger) ───────────────────

  router.post("/admin/papers/:id/score", async (req, res, next) => {
    try {
      // ?force=1 re-runs every panel member; default re-runs only the
      // members that have no verdict yet (cheap after a PARTIAL).
      await scorePaper(req.params.id, judge, req.query.force === "1");
      const payload = { ok: true, paperId: req.params.id };
      const validated = AdminScoreResponseSchema.parse(payload);
      res.json(validated);
    } catch (e) {
      next(e);
    }
  });

  // ─── Exports for thesis analysis ───────────────────────────────────

  router.get("/admin/export.json", async (_req, res, next) => {
    try {
      const [systems, paperRows, voteRows, metricRows, verdictRows, snapshotRows] =
        await Promise.all([
          db.query.reviewSystems.findMany(),
          db.query.papers.findMany({ with: { reviews: true } }),
          db.query.votes.findMany({ with: { dimensions: true } }),
          db.query.metricScores.findMany(),
          db.query.judgeVerdicts.findMany(),
          db.query.ratings.findMany(),
        ]);
      const payload = {
        exportedAt: new Date().toISOString(),
        systems,
        papers: paperRows,
        votes: voteRows,
        metrics: metricRows,
        verdicts: verdictRows,
        snapshots: snapshotRows,
      };
      const validated = AdminExportResponseSchema.parse(payload);
      res
        .setHeader("content-disposition", `attachment; filename=reviewarena-export-${Date.now()}.json`)
        .json(validated);
    } catch (e) {
      next(e);
    }
  });

  router.get("/admin/export.csv", async (_req, res, next) => {
    try {
      // Long format: one row per vote with dimension ratings flattened.
      const voteRows = await db.query.votes.findMany({
        orderBy: asc(votes.createdAt),
        with: {
          reviewA: { with: { reviewSystem: true } },
          reviewB: { with: { reviewSystem: true } },
          dimensions: true,
        },
      });
      const header = [
        "vote_id",
        "created_at",
        "session_id",
        "paper_id",
        "system_a",
        "system_b",
        "winner",
        "decision_ms",
        ...VOTE_DIMENSIONS.map((d) => `dim_${d.toLowerCase()}`),
      ].join(",");
      const rows = voteRows.map((v) => {
        // Emits "A" / "B" / "TIE", matching the `winner` column beside it.
        // These columns were signed integers before 2026-09-10; an export
        // taken from an older build is not directly comparable.
        const dimMap = new Map(v.dimensions.map((d) => [d.dimension, d.winner]));
        return [
          v.id,
          v.createdAt.toISOString(),
          v.sessionId,
          v.paperId,
          v.reviewA.reviewSystem.slug,
          v.reviewB.reviewSystem.slug,
          v.winner,
          v.decisionMs ?? "",
          ...VOTE_DIMENSIONS.map((d) => dimMap.get(d) ?? ""),
        ].join(",");
      });
      res
        .setHeader("content-type", "text/csv")
        .setHeader("content-disposition", `attachment; filename=reviewarena-votes-${Date.now()}.csv`)
        .send([header, ...rows].join("\n"));
    } catch (e) {
      next(e);
    }
  });

  return router;
}
