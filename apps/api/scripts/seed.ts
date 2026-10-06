// Seed review_systems so the demo has something to compare on day one.
// Run: pnpm --filter @reviewarena/api db:seed
//
// Live lineup — the controlled study's six systems, one mid-tier model
// per provider (2026-09):
//     - Claude Sonnet 5        (Anthropic, native SDK)
//     - DeepSeek V4 Flash      (DeepSeek OpenAI-compat API)
//     - Gemini 3.8 Flash       (Google, native SDK)
//     - GLM-5.2                (Z.ai OpenAI-compat API)
//     - GPT-5.6 Terra          (OpenAI)
//     - Mistral Medium 3.5     (Mistral OpenAI-compat API)
//
// The same six systems form the LLM judge panel: every study pair is
// judged by all six (self-judgements flagged, reported with and without
// in the analysis). There is no separate judge-only vendor.
//
// Every `model` string below was verified callable against the
// provider's live model-list endpoint. Mistral's does not match its
// display name on purpose — see the comment on that row.
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
  // Hard-deleted 2026-09 (scripts/retire-system.ts) when DeepSeek V4 Flash
  // took its lineup slot; listed so a restored backup can't re-enable it.
  "kimi-k3",
  // 2026-09 six-system study cut: lineup reduced to one system per
  // provider to match the controlled study design. Rows deleted from the
  // live dev DB (it held no votes); these entries only matter if an old
  // backup is ever restored.
  "gpt-5.2",
  "gpt-5.4-mini",
  "claude-opus-4-8",
  "gemini-3.1-pro",
  "gemini-3.6-flash",
  "deepseek-v4-pro",
  "mistral-large-3",
  // Superseded by the 2026-07 lineup refresh (5 providers x 2 tiers).
  "gpt-5.5-pro",            // → gpt-5.4-mini. 50k TPM (10x below every other
                            // OpenAI model), 100-150s buffered TTFT, and
                            // $30/$180 per 1M = 74% of total lineup cost.
  // Disabled, NOT removed: the adapter stays registered so the row and
  // its reviews/Elo history remain usable and re-enabling is one line.
  "gpt-5.5",                // → gpt-5.2 ($5/$30 vs $1.75/$14 per 1M)
  "claude-opus-5",          // → claude-opus-4-8 (identical pricing;
                            // a model choice, not a cost one)
  "gpt-5",                  // → gpt-5.2
  "gpt-5-mini",             // → gpt-5.4-mini
  "gemini-3-pro",           // → gemini-3.1-pro
  "gemini-2.5-flash",       // → gemini-3.6-flash
  "deepseek-v3-2",          // → deepseek-v4-flash
  // Earlier baselines.
  "gpt-4o-mini",            // pre-GPT-5 zero-shot baseline
  "gpt-4o",                 // pre-GPT-5 frontier baseline
  "gemini-1.5-flash",        // pre-Gemini-2.5 zero-shot baseline
  "claude-sonnet",          // pre-Opus-5 Anthropic baseline
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

  // Step 2 — upsert the 10 live frontier systems.
  const systems: Array<{
    slug: string;
    name: string;
    description: string;
    adapterKey: string;
    config: Record<string, unknown>;
    enabled?: boolean;
  }> = [
    // ─── The controlled study's six systems (2026-09 lineup cut) ───────
    // One per provider. Each also sits on the judge panel — the Node
    // pipeline calls services/review-gen/app/judge.py once per system
    // for every study pair, naming config.model as the judge.
    {
      slug: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      description:
        "Google Gemini 3.8 Flash (current generation) with our zero-shot " +
        "reviewer prompt.",
      adapterKey: "gemini-3.8-flash",
      config: { model: "gemini-3.8-flash", temperature: 0.2 },
      enabled: !!process.env.GEMINI_API_KEY,
    },
    {
      slug: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      description:
        "OpenAI GPT-5.6 Terra (balanced tier of the 5.6 family) with our " +
        "zero-shot reviewer prompt.",
      adapterKey: "gpt-5.6-terra",
      config: { model: "gpt-5.6-terra" },
      enabled: !!process.env.OPENAI_API_KEY,
    },
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      description:
        "Anthropic Claude Sonnet 5 (mid tier) via the native Anthropic SDK, " +
        "adaptive thinking enabled.",
      adapterKey: "claude-sonnet-5",
      config: { model: "claude-sonnet-5", thinking: true },
      enabled: !!process.env.ANTHROPIC_API_KEY,
    },
    {
      slug: "mistral-medium-3.5",
      name: "Mistral Medium 3.5",
      description:
        "Mistral Medium 3.5 (mid tier) zero-shot reviewer via Mistral's " +
        "OpenAI-compatible endpoint.",
      adapterKey: "mistral-medium-3.5",
      // "mistral-medium-3.5" is callable, but it is an ALIAS that currently
      // resolves to the dated "mistral-medium-2604". Pinning the dated id
      // so a silent upgrade mid-study can't invalidate the comparison.
      config: { model: "mistral-medium-2604", temperature: 0.2 },
      enabled: !!process.env.MISTRAL_API_KEY,
    },
    {
      slug: "glm-5.2",
      name: "GLM-5.2",
      description:
        "Zhipu GLM-5.2 (744B MoE, open-weight) zero-shot reviewer via " +
        "Z.ai's OpenAI-compatible endpoint.",
      adapterKey: "glm-5.2",
      config: { model: "glm-5.2", temperature: 0.2 },
      enabled: !!process.env.ZAI_API_KEY,
    },
    {
      slug: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      description:
        "DeepSeek V4 Flash (mid tier) zero-shot reviewer via DeepSeek's " +
        "OpenAI-compatible endpoint.",
      adapterKey: "deepseek-v4-flash",
      config: { model: "deepseek-v4-flash", temperature: 0.2 },
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
