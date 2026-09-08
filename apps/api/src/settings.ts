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

/** Test seam — drops the memoised values so a change is seen immediately. */
export function clearSettingsCache(): void {
  cache.clear();
}
