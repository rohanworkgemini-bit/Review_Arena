import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

// Pool + drizzle are constructed lazily on first access. ES module hoisting
// means consumers' top-level `loadEnv(...)` statements run AFTER this file's
// imports complete — so if we built the Pool eagerly, `DATABASE_URL` would
// still be undefined and we'd silently connect to localhost.
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _pool: Pool | null = null;

function build() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Ensure the project-root .env is loaded before importing db.",
    );
  }
  // Cap connections so a request spike (or a leak) can't exhaust
  // Postgres's max_connections (100 by default).
  //
  // 50, not 20: the controlled study puts 20 participants on the app at
  // once, and each one is more than a single connection. While reviews
  // generate, every study client polls /study/state on a timer, and the
  // sweeper + the snapshot worker draw from the same pool. At max=20 the
  // pool was exhausted well before 20 concurrent participants, and an
  // exhausted pool does not queue politely — connectionTimeoutMillis
  // makes the request throw after 5s. 50 leaves Postgres's default 100
  // half free for psql, the scripts and the tunnel.
  const poolMax = Number(process.env.DB_POOL_MAX ?? 50);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number.isFinite(poolMax) && poolMax > 0 ? Math.floor(poolMax) : 50,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // An idle client losing its socket (Postgres restart, network blip)
  // emits 'error' on the pool. With no listener, Node treats that as an
  // uncaught exception and kills the process — turning a database hiccup
  // into a full API outage.
  pool.on("error", (err) => {
    console.error("[db] idle pool client error (recovering):", err.message);
  });
  _pool = pool;
  return drizzle(pool, { schema });
}

// Proxy: every property/method access on `db` triggers lazy construction.
// Same call sites as before (`db.query.papers.findMany(...)`); the trick is
// invisible to callers.
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    if (!_db) _db = build();
    return Reflect.get(_db, prop);
  },
});

/** Graceful-shutdown hook: drain and close the pg pool. */
export async function closeDbPool(): Promise<void> {
  if (_pool) {
    await _pool.end().catch(() => {/* already closing */});
    _pool = null;
    _db = null;
  }
}

export type DB = typeof db;
export { schema };
