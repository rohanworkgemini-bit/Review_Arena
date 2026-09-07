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

// There is no default judge model: the judge is a panel of the six study
// systems (see pipeline/judge-panel.ts), and every call names its member's
// backing model id explicitly. Python routes on that id.
export class JudgeClient {
  private readonly apiKey: string;

  constructor(private readonly baseUrl: string, apiKey: string = "") {
    this.apiKey = apiKey;
  }

  async judge(reviewText: string, paperText: string, model: string): Promise<JudgeResult> {
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
    model: string,
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
    if (statusCode >= 400) throw new Error(`judge-pair ${model} ${statusCode}: ${text}`);
    return JSON.parse(text) as PairJudgeResult;
  }
}
