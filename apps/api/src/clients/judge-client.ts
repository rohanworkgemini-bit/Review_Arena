import { request } from "undici";

export interface JudgeResult {
  overall_score: number;
  dimension_scores: Record<string, number>;
}

export type JudgePreference = "A" | "B" | "TIE";

// Pairwise verdict from /judge-pair: the judge compares both reviews of a
// paper in one request per pass (order-swapped double pass) and returns
// the same construct human raters give — A/B/TIE per dimension — plus
// per-review 1-10 scores from the same call. "A"/"B" refer to the
// review_a/review_b arguments of judgePair, not to the vote's blinded sides.
export interface PairJudgeResult {
  overall_preference: JudgePreference;
  dimension_preferences: Record<string, JudgePreference>;
  review_a: JudgeResult;
  review_b: JudgeResult;
  // 2 = swap-consistent verdict; 1 = one pass failed, no position-bias control.
  passes_used: number;
  raw_passes: unknown[];
}

// Keep in sync with DEFAULT_JUDGE_MODEL in services/review-gen/app/judge.py.
// Stored on every metric row's meta so the leaderboard / reveal page
// can surface which judge produced a given score.
export const DEFAULT_JUDGE_MODEL = "deepseek-v4-flash";

export class JudgeClient {
  private readonly apiKey: string;

  constructor(private readonly baseUrl: string, apiKey: string = "") {
    this.apiKey = apiKey;
  }

  async judge(reviewText: string, paperText: string, model = DEFAULT_JUDGE_MODEL): Promise<JudgeResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const { statusCode, body } = await request(`${this.baseUrl}/judge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ review_text: reviewText, paper_text: paperText, model }),
      // /judge is a BLOCKING endpoint: Python sends response headers only
      // after both judge passes over the full paper finish, so the headers
      // deadline must cover the whole judging run, not a socket handshake.
      // 30s here silently failed every real-sized paper (root-caused
      // 2026-09-04: tiny probes passed, full papers always aborted at 30s).
      // Two passes with per-call 180s deadlines + Python-side retries fit
      // inside 8 min; a wedged service is still bounded by both timeouts.
      headersTimeout: 8 * 60_000,
      bodyTimeout: 8 * 60_000,
    });
    const text = await body.text();
    if (statusCode >= 400) throw new Error(`judge ${statusCode}: ${text}`);
    return JSON.parse(text) as JudgeResult;
  }

  async judgePair(
    reviewA: string,
    reviewB: string,
    paperText: string,
    model = DEFAULT_JUDGE_MODEL,
  ): Promise<PairJudgeResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const { statusCode, body } = await request(`${this.baseUrl}/judge-pair`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        review_a: reviewA,
        review_b: reviewB,
        paper_text: paperText,
        model,
      }),
      // Blocking endpoint (see judge() above): headers arrive only after
      // both order-swapped passes finish, so both deadlines cover the run.
      headersTimeout: 8 * 60_000,
      bodyTimeout: 8 * 60_000,
    });
    const text = await body.text();
    if (statusCode >= 400) throw new Error(`judge-pair ${statusCode}: ${text}`);
    return JSON.parse(text) as PairJudgeResult;
  }
}
