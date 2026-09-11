// Pre-session preflight. Run this before every study session, and before
// the first participant ever arrives.
//
// The failure this exists to prevent: discovering mid-session that a key
// expired, a system seeded disabled, or the schema was never pushed. A
// participant's slot cannot be re-run — they have already seen the papers
// and formed opinions — so every check here is something that is cheap to
// verify beforehand and expensive to discover afterwards.
//
// Run:
//   pnpm --filter @reviewarena/api preflight          # offline checks
//   pnpm --filter @reviewarena/api preflight --live   # + auth-check every provider
//
// Exit code is 0 only when nothing FAILED. Warnings do not block: they are
// things you should look at, not things that will break a session.

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import { sql } from "drizzle-orm";
import { db, closeDbPool } from "../src/db/client.js";
import { STUDY_SLUGS } from "../src/study/rotation.js";
import { isJudgeEnabled } from "../src/settings.js";

const LIVE = process.argv.includes("--live");

// ─── Result plumbing ───────────────────────────────────────────────────────

type Level = "ok" | "warn" | "fail";
interface Result {
  level: Level;
  what: string;
  detail: string;
  /** What to actually do about it. Omitted when level is "ok". */
  fix?: string;
}

const results: Result[] = [];
const ok = (what: string, detail: string) =>
  results.push({ level: "ok", what, detail });
const warn = (what: string, detail: string, fix?: string) =>
  results.push({ level: "warn", what, detail, fix });
const fail = (what: string, detail: string, fix?: string) =>
  results.push({ level: "fail", what, detail, fix });

/** Never let one check's exception abort the rest — a preflight that dies
 *  halfway is worse than useless, because it hides everything after it. */
async function check(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    fail(what, e instanceof Error ? e.message : String(e));
  }
}

// ─── Provider auth checks ──────────────────────────────────────────────────
// Each provider exposes a list-models endpoint that costs nothing and needs
// no tokens. It answers exactly the question that matters: is this key still
// valid right now? A key that was fine last week can be revoked, rotated or
// out of credit today, and nothing else in the stack notices until a
// participant is watching a review fail to generate.

interface ProviderProbe {
  slug: string;
  env: string;
  url: string;
  headers: (key: string) => Record<string, string>;
}

const PROBES: ProviderProbe[] = [
  {
    slug: "claude-sonnet-5",
    env: "ANTHROPIC_API_KEY",
    url: "https://api.anthropic.com/v1/models?limit=1",
    headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
  },
  {
    slug: "gpt-5.6-terra",
    env: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1/models",
    headers: (k) => ({ authorization: `Bearer ${k}` }),
  },
  {
    slug: "gemini-3.8-flash",
    env: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    headers: (k) => ({ "x-goog-api-key": k }),
  },
  {
    slug: "deepseek-v4-flash",
    env: "DEEPSEEK_API_KEY",
    url: "https://api.deepseek.com/v1/models",
    headers: (k) => ({ authorization: `Bearer ${k}` }),
  },
  {
    slug: "mistral-medium-3.5",
    env: "MISTRAL_API_KEY",
    url: "https://api.mistral.ai/v1/models",
    headers: (k) => ({ authorization: `Bearer ${k}` }),
  },
  {
    slug: "glm-5.2",
    env: "ZAI_API_KEY",
    url: "https://api.z.ai/api/paas/v4/models",
    headers: (k) => ({ authorization: `Bearer ${k}` }),
  },
];

async function probeProvider(p: ProviderProbe): Promise<void> {
  const key = process.env[p.env];
  if (!key) return; // absence is reported by the env check, not here.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(p.url, { headers: p.headers(key), signal: ctl.signal });
    if (res.ok) {
      ok(`key ${p.slug}`, "authenticated");
    } else if (res.status === 401 || res.status === 403) {
      fail(
        `key ${p.slug}`,
        `${p.env} rejected (HTTP ${res.status})`,
        "Key is expired, revoked or wrong. Replace it in .env before the session.",
      );
    } else if (res.status === 429) {
      warn(`key ${p.slug}`, "rate-limited right now (key itself is valid)");
    } else {
      warn(`key ${p.slug}`, `unexpected HTTP ${res.status} — could not confirm`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(
      `key ${p.slug}`,
      ctl.signal.aborted ? "timed out after 15s" : `unreachable: ${msg}`,
      "Could be your network rather than the provider. Retry before assuming the key is bad.",
    );
  } finally {
    clearTimeout(timer);
  }
}

// ─── Checks ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Database reachable.
  let dbUp = false;
  await check("database", async () => {
    await db.execute(sql`select 1`);
    dbUp = true;
    ok("database", "reachable");
  });

  if (dbUp) {
    // 2. Schema is current. Checks the two columns most recently added —
    //    if these are missing, db:push was never run against this database
    //    and judging will fail on the first insert.
    await check("schema", async () => {
      const cols = await db.execute(sql`
        select table_name, column_name from information_schema.columns
        where (table_name = 'metric_scores' and column_name = 'judge_model')
           or (table_name = 'judge_verdicts' and column_name = 'judge_model')`);
      const n = cols.rows.length;
      if (n === 2) ok("schema", "judge_model present on both judge tables");
      else
        fail(
          "schema",
          `expected 2 judge_model columns, found ${n}`,
          "Run: pnpm --filter @reviewarena/api db:push",
        );
    });

    // 3. Exactly the six study systems, all enabled.
    await check("review systems", async () => {
      const rows = await db.query.reviewSystems.findMany();
      const enabled = rows.filter((r) => r.enabled).map((r) => r.slug).sort();
      const expected = [...STUDY_SLUGS].sort();
      const missing = expected.filter((s) => !enabled.includes(s));
      const extra = enabled.filter((s) => !expected.includes(s));

      if (missing.length === 0 && extra.length === 0) {
        ok("review systems", `all ${expected.length} study systems enabled`);
      } else {
        if (missing.length)
          fail(
            "review systems",
            `not enabled: ${missing.join(", ")}`,
            "A system seeds disabled when its API key is absent. Check .env, then re-run db:seed.",
          );
        if (extra.length)
          warn(
            "review systems",
            `enabled but not in the study lineup: ${extra.join(", ")}`,
            "These can be paired in the arena but never in the study. Disable them if that is not intended.",
          );
      }
    });

    // 4. Participant codes minted. The pool is open — there is no target
    //    count to hit — so this only catches an empty table, and nudges if
    //    there are fewer codes than a session is likely to need.
    await check("participants", async () => {
      const rows = await db.query.participants.findMany();
      if (rows.length === 0)
        fail(
          "participants",
          "none minted",
          "Run: pnpm --filter @reviewarena/api exec tsx scripts/seed-participants.ts",
        );
      else if (rows.length < 5)
        warn(
          "participants",
          `only ${rows.length} code(s) minted`,
          "Mint more before the session: seed-participants.ts --count N.",
        );
      else ok("participants", `${rows.length} codes ready`);
    });

    // 5. Work stuck in a non-terminal state. The sweeper should clear these
    //    on its own; anything older than the cutoff means it is not running.
    await check("stuck work", async () => {
      const stuck = await db.execute(sql`
        select
          count(*) filter (
            where status = 'GENERATING' and updated_at < now() - interval '30 minutes'
          )::int as gen,
          count(*) filter (
            where judge_status = 'RUNNING' and updated_at < now() - interval '90 minutes'
          )::int as judge
        from reviews`);
      const row = stuck.rows[0] as { gen: number; judge: number };
      if (!row.gen && !row.judge) ok("stuck work", "nothing stalled");
      else
        warn(
          "stuck work",
          `${row.gen} generating, ${row.judge} judging, past cutoff`,
          "The sweeper reclaims these. If the count is not falling, the API process is not running.",
        );
    });

    // 6. The judge panel switch. A warning rather than a failure — pausing
    //    it is a legitimate thing to do while testing — but a loud one: a
    //    session run with judging off yields human votes that RQ2 can never
    //    be answered from, and the omission is invisible in the UI.
    await check("judge panel", async () => {
      const enabled = await isJudgeEnabled();
      if (enabled) ok("judge panel", "enabled");
      else
        warn(
          "judge panel",
          "PAUSED — study pairs will not be judged",
          "Fine while testing. Re-enable in Admin → Settings before any real session, then run rescore-missing.ts to backfill.",
        );
    });

    // 7. Leftover data under a participant code. A smoke test run through
    //    /study lands on a real participant's record and silently becomes
    //    part of their data — this is the check that catches it.
    await check("participant data", async () => {
      const rows = await db.execute(sql`
        select p.id, count(distinct pa.id)::int as papers
        from participants p
        join papers pa on pa.participant_id = p.id
        group by p.id order by p.id`);
      if (rows.rows.length === 0) {
        ok("participant data", "no participant has uploaded yet — clean slate");
      } else {
        const list = rows.rows
          .map((r) => `${(r as { id: string }).id}:${(r as { papers: number }).papers}`)
          .join(" ");
        warn(
          "participant data",
          `${rows.rows.length} participant(s) already hold papers — ${list}`,
          "Expected mid-study. Before the FIRST participant it means test data is attributed to a real code — clear it.",
        );
      }
    });
  }

  // 7. Required environment.
  await check("environment", async () => {
    const required = [
      "DATABASE_URL",
      "ADMIN_TOKEN",
      "PAIR_TOKEN_SECRET",
      "REVIEW_GEN_URL",
      "REVIEW_GEN_API_KEY",
      "CHANDRA_API_KEY",
      ...PROBES.map((p) => p.env),
    ];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length === 0) ok("environment", `all ${required.length} variables set`);
    else
      fail(
        "environment",
        `missing: ${missing.join(", ")}`,
        "Without a provider key that system cannot generate; without CHANDRA_API_KEY no PDF parses at all.",
      );

    // Not required, but its presence means the lineup swap was never
    // finished in this environment.
    if (process.env.MOONSHOT_API_KEY)
      warn(
        "environment",
        "MOONSHOT_API_KEY is still set",
        "Kimi K3 was removed from the lineup. The key is unused — delete the line.",
      );
  });

  // 8. review-gen reachable. Every model call and every parse goes through
  //    it, so if it is down nothing works and the UI only says "generation
  //    failed".
  await check("review-gen", async () => {
    const base = process.env.REVIEW_GEN_URL;
    if (!base) return; // already reported by the environment check.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/health`, { signal: ctl.signal });
      if (res.ok) ok("review-gen", `healthy at ${base}`);
      else fail("review-gen", `HTTP ${res.status} from ${base}/health`);
    } catch {
      fail(
        "review-gen",
        `unreachable at ${base}`,
        "Start it: REVIEWARENA_ENV=development pnpm dev:review-gen",
      );
    } finally {
      clearTimeout(timer);
    }
  });

  // 9. Provider keys, live. Opt-in because it makes six outbound calls.
  if (LIVE) await Promise.all(PROBES.map((p) => check(`key ${p.slug}`, () => probeProvider(p))));

  // ─── Report ──────────────────────────────────────────────────────────────

  const mark = { ok: "  ok  ", warn: " WARN ", fail: " FAIL " } as const;
  console.log("");
  for (const r of results) {
    console.log(`[${mark[r.level]}] ${r.what.padEnd(22)} ${r.detail}`);
    if (r.fix) console.log(`${" ".repeat(33)}→ ${r.fix}`);
  }

  const failed = results.filter((r) => r.level === "fail").length;
  const warned = results.filter((r) => r.level === "warn").length;
  console.log("");
  if (failed) {
    console.log(`${failed} FAILED, ${warned} warning(s). Do not start a session.`);
  } else if (warned) {
    console.log(`No failures, ${warned} warning(s). Read them, then you are clear to run.`);
  } else {
    console.log("All checks passed.");
  }
  if (!LIVE) {
    console.log("Provider keys were not verified — re-run with --live to auth-check all six.");
  }

  await closeDbPool();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
