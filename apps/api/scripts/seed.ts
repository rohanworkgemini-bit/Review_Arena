// Seed review_systems so the demo has something to compare on day one.
// Run: pnpm --filter @reviewarena/api db:seed
//
// Live lineup — 6 frontier commercial reviewers:
//     - GPT-5            (OpenAI, top tier)
//     - GPT-5-mini       (OpenAI, small)
//     - Gemini 3 Pro     (Google, top tier)
//     - Gemini 2.5 Flash (Google, small)
//     - Claude Opus 4.8  (Anthropic, native SDK with adaptive thinking)
//     - DeepSeek V3.2    (deepseek-chat via DeepSeek's OpenAI-compat API)
//
// Scope: the thesis benchmarks frontier commercial LLMs only. The
// open-weight specialist reviewers (DeepReviewer, OpenReviewer,
// CycleReviewer, SEA) required self-hosted GPUs (Modal/vLLM) and are out
// of scope; their adapters and GPU serving code have been removed.
//
// Older in-process "port" adapters, pre-GPT-5 frontier baselines
// (gpt-4o, claude-sonnet-3.7-via-OpenRouter, etc.) and the retired
// specialists are kept in the DB with enabled=false so historical votes /
// reviews / Elo snapshots remain intact for the thesis analysis.

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// scripts/seed.ts → repo-root .env is 4 dirs up (scripts → api → apps → /).
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { reviewSystems } from "../src/db/schema.js";

// Slugs of retired adapters. Disabled (not deleted) so historical
// reviews / votes / Elo snapshots remain in the DB for thesis analysis.
const RETIRED_SLUGS = [
  "gpt-4o-mini",            // pre-GPT-5 zero-shot baseline
  "gpt-4o",                 // pre-GPT-5 frontier baseline, replaced by gpt-5
  "gemini-1.5-flash",        // pre-Gemini-2.5 zero-shot baseline
  "claude-sonnet",          // replaced by claude-opus-4-8 via native Anthropic SDK
  "deepseek-v3",            // renamed to deepseek-v3-2 when we adopted per-system adapters
  "ai-scientist-gpt5",       // our port of Sakana's reviewer
  "tree-review-gpt5",         // our port of Chang et al.'s tree-of-questions
  "deepreviewer-14b",         // our port placeholder
  // Open-weight specialists — out of scope (needed self-hosted GPUs).
  // Rows are disabled, never deleted: their historical reviews, votes and
  // Elo snapshots stay queryable for the thesis analysis.
  "deepreviewer-7b",          // WestlakeNLP/DeepReviewer-7B (Modal vLLM)
  "openreviewer-8b",          // maxidl/Llama-OpenReviewer-8B (Modal vLLM)
  "cyclereviewer-8b",         // WestlakeNLP/CycleReviewer-ML-Llama-3.1-8B
  "sea-e",                    // ECNU-SEA/SEA-E
];

async function main() {
  // Step 1 — retire the legacy adapters.
  for (const slug of RETIRED_SLUGS) {
    const existing = await db.query.reviewSystems.findFirst({
      where: eq(reviewSystems.slug, slug),
    });
    if (existing?.enabled) {
      await db
        .update(reviewSystems)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(reviewSystems.id, existing.id));
      console.log(`Disabled retired system: ${slug}`);
    }
  }

  // Step 2 — upsert the 6 live frontier systems.
  const systems: Array<{
    slug: string;
    name: string;
    description: string;
    adapterKey: string;
    config: Record<string, unknown>;
    enabled?: boolean;
  }> = [
    // ─── Live: 6 frontier commercial reviewers (per QSL plan) ─────────
    // Two OpenAI (GPT-5 top + GPT-5-mini), two Google (Gemini 3 Pro top
    // + Gemini 2.5 Flash), one Anthropic (Opus 4.8), one DeepSeek.
    {
      slug: "gpt-5",
      name: "GPT-5 (zero-shot)",
      description:
        "OpenAI GPT-5 (top tier, not -mini) with our zero-shot reviewer prompt. " +
        "Reasoning-class model; uses adaptive thinking by default.",
      adapterKey: "gpt-5",
      config: { model: "gpt-5", use_max_completion_tokens: true },
      enabled: !!process.env.OPENAI_API_KEY,
    },
    {
      slug: "gpt-5-mini",
      name: "GPT-5-mini (zero-shot)",
      description: "OpenAI GPT-5-mini with our zero-shot reviewer prompt.",
      adapterKey: "gpt-5-mini",
      config: { model: "gpt-5-mini", use_max_completion_tokens: true },
      enabled: !!process.env.OPENAI_API_KEY,
    },
    {
      slug: "gemini-3-pro",
      name: "Gemini 3 Pro (zero-shot)",
      description:
        "Google Gemini 3 Pro (top tier) with our zero-shot reviewer prompt. " +
        "Frontier multi-modal model from the Gemini 3 family. " +
        "Currently pinned to 'gemini-3.1-pro-preview' — Google deprecated " +
        "'gemini-3-pro-preview' before the study began.",
      adapterKey: "gemini-3-pro",
      // gemini-3-pro-preview is dead (404). gemini-3.1-pro-preview is the
      // current top-tier Gemini 3 model and IS working. We PIN the preview
      // version so the entire study uses the same model snapshot — switching
      // mid-study would invalidate apples-to-apples comparison.
      // Verify currently-callable IDs with:
      //   for m in "gemini-3.1-pro-preview" "gemini-pro-latest"; do \
      //     curl -sS -o /dev/null -w "$m → %{http_code}\n" \
      //       -X POST "https://generativelanguage.googleapis.com/v1beta/models/$m:generateContent?key=$GEMINI_API_KEY" \
      //       -H "content-type: application/json" \
      //       -d '{"contents":[{"parts":[{"text":"ping"}]}]}'; \
      //   done
      config: { model: "gemini-3.1-pro-preview", temperature: 0.2 },
      enabled: !!process.env.GEMINI_API_KEY,
    },
    {
      slug: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash (zero-shot)",
      description: "Google Gemini 2.5 Flash with our zero-shot reviewer prompt.",
      adapterKey: "gemini-2.5-flash",
      config: { model: "gemini-2.5-flash", temperature: 0.2 },
      enabled: !!process.env.GEMINI_API_KEY,
    },
    {
      slug: "claude-opus-4-8",
      name: "Claude Opus 4.8 (zero-shot)",
      description:
        "Anthropic Claude Opus 4.8 via native Anthropic SDK. Adaptive thinking " +
        "(effort=high) — auto-tuned reasoning depth for peer-review judgment.",
      adapterKey: "claude",
      config: { model: "claude-opus-4-8", thinking: true },
      enabled: !!process.env.ANTHROPIC_API_KEY,
    },
    // ─── DeepSeek (its own dedicated adapter; gpt-4o + claude-sonnet
    // retired — see RETIRED_SLUGS above) ───────────────────────────────
    {
      slug: "deepseek-v3-2",
      name: "DeepSeek V3.2 (zero-shot)",
      description:
        "DeepSeek V3.2 (deepseek-chat) zero-shot reviewer via DeepSeek's native " +
        "OpenAI-compatible endpoint. Strong, low-cost frontier baseline.",
      adapterKey: "deepseek-v3-2",
      config: {
        model: "deepseek-chat",  // DeepSeek aliases this to the current top model (V3.2 as of 2026-06)
        temperature: 0.2,
      },
      enabled: !!process.env.DEEPSEEK_API_KEY,
    },
  ];

  for (const sys of systems) {
    const existing = await db.query.reviewSystems.findFirst({
      where: eq(reviewSystems.slug, sys.slug),
    });
    if (existing) {
      await db
        .update(reviewSystems)
        .set({
          name: sys.name,
          description: sys.description,
          adapterKey: sys.adapterKey,
          config: sys.config,
          enabled: sys.enabled ?? true,
          updatedAt: new Date(),
        })
        .where(eq(reviewSystems.id, existing.id));
      console.log(`Updated: ${sys.slug}`);
    } else {
      await db.insert(reviewSystems).values({
        slug: sys.slug,
        name: sys.name,
        description: sys.description,
        adapterKey: sys.adapterKey,
        config: sys.config,
        enabled: sys.enabled ?? true,
      });
      console.log(`Inserted: ${sys.slug}`);
    }
  }

  const all = await db.query.reviewSystems.findMany();
  const enabled = all.filter((s) => s.enabled);
  console.log(
    `\nSeed complete. ${all.length} systems registered, ${enabled.length} enabled.`,
  );
  console.log(`Enabled: ${enabled.map((s) => s.slug).join(", ")}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
