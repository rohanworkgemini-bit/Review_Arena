import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { appSettings } from "./db/schema.js";

/**
 * Operational switches the study runner flips between sessions.
 *
 * These live in the database rather than the environment so a change takes
 * effect immediately, from the admin page, without a redeploy or an SSH
 * session mid-study. Anything that is genuinely configuration — connection
 * strings, API keys, ports — stays in .env where it belongs.
 */

export const JUDGE_ENABLED = "judge_enabled";
export const JUDGE_MODELS = "judge_models";

// The judge panel is read on every review completion, so an uncached read
// would put a query on the hot path for a value that changes a handful of
// times a month. A few seconds of staleness is harmless: the worst case is
// one more pair judged just after the switch was thrown, or one fewer just
// after it was thrown back.
const TTL_MS = 5_000;
const cache = new Map<string, { value: unknown; at: number }>();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  try {
    const row = await db.query.appSettings.findFirst({
      where: eq(appSettings.key, key),
    });
    const value = row === undefined ? fallback : (row.value as T);
    cache.set(key, { value, at: Date.now() });
    return value;
  } catch {
    // A settings read must never be what takes the pipeline down. Falling
    // back keeps the documented default behaviour rather than guessing.
    return fallback;
  }
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });
  cache.set(key, { value, at: Date.now() });
}

/**
 * Is the LLM judge panel running?
 *
 * One study paper costs 36 live provider calls — six judges, two
 * order-swapped passes, three rotation pairs — which is slow and billable
 * when what you are testing is the upload flow or the voting UI. Turning it
 * off skips judging entirely: reviews stay judge_status=PENDING, exactly as
 * arena papers do, so nothing is written that has to be cleaned up and
 * scripts/rescore-missing.ts backfills every skipped pair once it is back on.
 *
 * JUDGE_ENABLED=false in the environment forces it off regardless of the
 * stored setting — an operator kill switch that the admin UI cannot undo,
 * for the case where a provider outage is costing money.
 *
 * MUST be on for the real study: a pair with no verdicts contributes
 * nothing to RQ2.
 */
export async function isJudgeEnabled(): Promise<boolean> {
  if (String(process.env.JUDGE_ENABLED ?? "").toLowerCase() === "false") return false;
  return getSetting<boolean>(JUDGE_ENABLED, true);
}

/**
 * Which systems sit on the judge panel for ARENA papers.
 *
 * `null` (the default, and what an absent setting means) is "every system
 * on the preregistered panel" — the same six the study uses. An empty
 * array is "none": arena pairs are then left unjudged, exactly as they
 * were before arena judging existed. Anything else is the chosen subset,
 * and unknown or disabled slugs are dropped when the panel is loaded.
 *
 * This setting deliberately does NOT apply to study papers. The study's
 * panel is preregistered at six members, and a run with a partial panel
 * would produce RQ2 data that cannot be compared with the rest — an
 * unrecoverable loss, since the reviews cannot be re-judged after the
 * participant has gone. Restricting the panel is therefore a lever for
 * arena cost, not a lever on the experiment.
 */
export async function getJudgeModels(): Promise<string[] | null> {
  const raw = await getSetting<unknown>(JUDGE_MODELS, null);
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  return raw.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/**
 * Remove a setting so the code-level default applies again.
 *
 * `app_settings.value` is NOT NULL, so "no value" cannot be represented by
 * storing null — the row has to go. Callers that treat absence as a
 * meaningful state (getJudgeModels: absent = the whole panel) use this
 * rather than setSetting(key, null).
 */
export async function clearSetting(key: string): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, key));
  cache.delete(key);
}

/** Test seam — drops the memoised values so a change is seen immediately. */
export function clearSettingsCache(): void {
  cache.clear();
}
