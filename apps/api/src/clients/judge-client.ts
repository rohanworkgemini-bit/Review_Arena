import { request } from "undici";

export interface JudgeResult {
  overall_score: number;
  dimension_scores: Record<string, number>;
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
      // Two judge passes with per-call 180s deadlines on the Python side
      // fit comfortably; without these, a wedged service holds this socket
      // (and its caller) at undici defaults, quietly stacking retries.
      headersTimeout: 30_000,
      bodyTimeout: 8 * 60_000,
    });
    const text = await body.text();
    if (statusCode >= 400) throw new Error(`judge ${statusCode}: ${text}`);
    return JSON.parse(text) as JudgeResult;
  }
}
