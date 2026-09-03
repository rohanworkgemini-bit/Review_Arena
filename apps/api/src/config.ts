import { z } from "zod";

// Production-grade env validation. All secrets are required with sane
// minimum lengths so misconfigured deployments fail fast at startup.
const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  API_PORT: z.coerce.number().int().default(8000),

  // Bearer token for admin endpoints (/admin/*). 32+ chars random.
  ADMIN_TOKEN: z.string().min(32),

  // HMAC key for pair tokens. SEPARATE from ADMIN_TOKEN so rotating
  // the admin password does not invalidate in-flight pairs, and so
  // leaking the admin token does not let an attacker forge votes.
  PAIR_TOKEN_SECRET: z.string().min(32),

  // CORS whitelist. The browser app's origin. Comma-separated for
  // multiple environments (e.g. "http://localhost:5173,https://reviewarena.example").
  WEB_ORIGIN: z.string().min(1).default("http://localhost:5173"),

  REVIEW_GEN_URL: z.string().url().default("http://localhost:8001"),
  // Bearer key forwarded on every outbound call to the review-gen Python
  // service. Must match the REVIEW_GEN_API_KEY env var on the Python
  // side. Optional — when empty, the Python service runs in open mode
  // (dev only; it logs a startup warning). REQUIRE a value in
  // production, otherwise any internet caller can spend your LLM
  // budget by hitting /generate directly.
  REVIEW_GEN_API_KEY: z.string().default(""),

  // Slug pinned to 1000 on the Bradley-Terry board. BT ratings are only
  // identified up to an additive constant, so one system has to fix the
  // origin — FastChat pins mixtral-8x7b to 1114. Pick a system with heavy
  // battle volume and then leave it alone: changing it renumbers every
  // rating on the board. Retiring the system is fine, since disabled systems
  // keep their battle history (that is exactly why FastChat's anchor is an
  // old model). Boards where the baseline has not battled mean-centre
  // instead, and record `anchor = 'MEAN'` on the snapshot row.
  RATING_BASELINE_SLUG: z.string().default("gpt-5.2"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
}).superRefine((cfg, ctx) => {
  // Open mode on the Python service means anyone who can reach it can spend
  // the LLM budget. Tolerable on localhost; never in production.
  if (cfg.NODE_ENV === "production" && cfg.REVIEW_GEN_API_KEY.length < 16) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["REVIEW_GEN_API_KEY"],
      message: "REVIEW_GEN_API_KEY (>=16 chars) is required when NODE_ENV=production",
    });
  }
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

/** Split WEB_ORIGIN ("a,b,c") into a list for the CORS middleware. */
export function webOriginList(config: Config): string[] {
  return config.WEB_ORIGIN.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
