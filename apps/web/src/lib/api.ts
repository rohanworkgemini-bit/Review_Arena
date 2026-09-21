import type {
  Conference,
  PairResponse,
  StructuredReview,
  RevealDetailResponse,
  SubmitVoteRequest,
  SubmitVoteResponse,
  LeaderboardResponse,
  UploadPaperResponse,
  VoteDimension,
  Winner,
} from "@reviewarena/shared-types";

// Thin fetch wrapper. TanStack Query handles caching, retries, status.
// We deliberately don't add a third axios-like abstraction layer here.

const BASE = "/api";

export class ApiError extends Error {
  status: number;
  code: string;
  /** Parsed JSON error body, when the server sent one. Lets callers use
   *  structured payloads on errors — e.g. the 409 duplicate-vote response
   *  carries the existing voteId + reveal so the UI can still navigate. */
  body: unknown;
  constructor(status: number, code: string, message: string, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let code = "";
    let detail = "";
    let body: unknown = null;
    try {
      body = await res.json();
      const b = body as { error?: string; message?: string };
      code = b.error ?? "";
      detail = b.message ?? "";
    } catch {
      /* response not JSON */
    }
    throw new ApiError(res.status, code, `${res.status} ${res.statusText}: ${detail}`, body);
  }
  return res.json() as Promise<T>;
}

/** Runtime switches the public pages need to render themselves. */
export type PublicConfig = {
  arenaEnabled: boolean;
  /** Non-null exactly when arenaEnabled is false. */
  arenaDisabledMessage: string | null;
};

export async function getPublicConfig(): Promise<PublicConfig> {
  const res = await fetch(`${BASE}/config`, { credentials: "include" });
  return jsonOrThrow<PublicConfig>(res);
}

export async function uploadPaper(
  file: File,
  title?: string,
  conference?: Conference,
): Promise<UploadPaperResponse> {
  const fd = new FormData();
  fd.append("file", file);
  if (title) fd.append("title", title);
  if (conference) fd.append("conference", conference);
  // Data-processing consent — the upload UI gates submission on the
  // checkbox, and the server rejects uploads without this field.
  fd.append("consent", "true");
  const res = await fetch(`${BASE}/papers`, {
    method: "POST",
    body: fd,
    credentials: "include",
  });
  return jsonOrThrow<UploadPaperResponse>(res);
}

// arXiv-link upload — alternative to the PDF path. Hits POST /papers/arxiv
// which parses via timf34's hosted arxiv2md.org service. Response shape
// matches uploadPaper() so the upload-page navigation stays path-agnostic.
export async function uploadArxiv(
  url: string,
  title?: string,
  conference?: Conference,
): Promise<UploadPaperResponse> {
  const res = await fetch(`${BASE}/papers/arxiv`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ url, title: title || undefined, conference, consent: true }),
  });
  return jsonOrThrow<UploadPaperResponse>(res);
}

export interface PaperStatus {
  id: string;
  title: string | null;
  status: string;
  pageCount: number | null;
  reviewCount: number;
  completedReviewCount: number;
  terminalReviewCount: number;
  expectedReviewCount: number;
  createdAt: string;
  // The chosen pair's review IDs + slugs. Browser uses these to open
  // SSE streams for token-level rendering. Empty until parsing finishes.
  reviewIds: Array<{ reviewId: string; slug: string }>;
}

export async function getPaperStatus(paperId: string): Promise<PaperStatus> {
  const res = await fetch(`${BASE}/papers/${encodeURIComponent(paperId)}`, {
    credentials: "include",
  });
  return jsonOrThrow<PaperStatus>(res);
}

export async function getPair(
  paperId: string,
  pairToken?: string,
): Promise<PairResponse> {
  // Sending pairToken asks the API to honor an in-flight round (refresh
  // recovery). The token is HMAC-signed against the session, so the server
  // still validates it before reusing the pair.
  const params = new URLSearchParams({ paperId });
  if (pairToken) params.set("pairToken", pairToken);
  const res = await fetch(`${BASE}/pair?${params.toString()}`, {
    credentials: "include",
  });
  return jsonOrThrow<PairResponse>(res);
}

export async function getReveal(voteId: string): Promise<RevealDetailResponse> {
  const res = await fetch(`${BASE}/reveal/${encodeURIComponent(voteId)}`, {
    credentials: "include",
  });
  return jsonOrThrow<RevealDetailResponse>(res);
}

export async function submitVote(body: SubmitVoteRequest): Promise<SubmitVoteResponse> {
  const res = await fetch(`${BASE}/votes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  return jsonOrThrow<SubmitVoteResponse>(res);
}

// The caller's anonymous session id. The cookie is httpOnly so JS can't
// read it directly; this round-trips through the API, which also ensures
// the session cookie gets set on first visit. Used to show participants
// the identifier they must quote for a data-deletion request.
export async function getSession(): Promise<{ sessionId: string }> {
  const res = await fetch(`${BASE}/session`, { credentials: "include" });
  return jsonOrThrow<{ sessionId: string }>(res);
}

export async function getLeaderboard(dimension?: string): Promise<LeaderboardResponse> {
  // Bradley-Terry is the only board the API serves; there is no method
  // parameter any more.
  const url = new URL(`${BASE}/leaderboard`, window.location.origin);
  if (dimension) url.searchParams.set("dimension", dimension);
  const res = await fetch(url.toString(), { credentials: "include" });
  return jsonOrThrow<LeaderboardResponse>(res);
}

// ─── Controlled study (/study/*) ────────────────────────────────────────────
// Types are local: the study API is participant-facing only and its shapes
// live in apps/api/src/routes/study.ts.

export interface StudyComparisonState {
  comparisonId: string;
  pairIndex: number;
  ready: boolean;
  failed: boolean;
  voted: boolean;
}

export interface StudyPaperState {
  paperIndex: number;
  paperId: string | null;
  status?: string;
  title?: string | null;
  reviewsCompleted?: number;
  reviewsFailed?: number;
  reviewsTotal?: number;
  comparisons?: StudyComparisonState[];
  votesCast?: number;
  done?: boolean;
}

export interface StudyState {
  participantId: string;
  papersPerParticipant: number;
  pairsPerPaper: number;
  papers: StudyPaperState[];
  totalVotes: number;
  studyDone: boolean;
}

export interface StudyPair {
  comparisonId: string;
  pairIndex: number;
  paperId: string;
  paperTitle: string | null;
  conference: Conference;
  alreadyVoted: boolean;
  reviewA: { reviewId: string; structured: StructuredReview | null; rawOutput: string | null };
  reviewB: { reviewId: string; structured: StructuredReview | null; rawOutput: string | null };
}

export interface StudyRevealComparison {
  pairIndex: number;
  systemA: { slug: string; name: string };
  systemB: { slug: string; name: string };
  winner: "A" | "B" | "TIE";
}

export async function studyState(code: string): Promise<StudyState> {
  const res = await fetch(`${BASE}/study/state?code=${encodeURIComponent(code)}`, {
    credentials: "include",
  });
  return jsonOrThrow<StudyState>(res);
}

export async function studyUploadPdf(
  code: string,
  file: File,
  title?: string,
  conference?: Conference,
): Promise<{ paperId: string; paperIndex: number }> {
  const form = new FormData();
  form.append("file", file);
  form.append("code", code);
  if (title) form.append("title", title);
  if (conference) form.append("conference", conference);
  const res = await fetch(`${BASE}/study/papers`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  return jsonOrThrow(res);
}

export async function studyUploadArxiv(
  code: string,
  url: string,
  title?: string,
  conference?: Conference,
): Promise<{ paperId: string; paperIndex: number }> {
  const res = await fetch(`${BASE}/study/papers/arxiv`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, url, title, conference }),
    credentials: "include",
  });
  return jsonOrThrow(res);
}

export async function studyPairFetch(code: string, comparisonId: string): Promise<StudyPair> {
  const res = await fetch(
    `${BASE}/study/pair?code=${encodeURIComponent(code)}&comparisonId=${encodeURIComponent(comparisonId)}`,
    { credentials: "include" },
  );
  return jsonOrThrow<StudyPair>(res);
}

export async function studyVote(body: {
  code: string;
  comparisonId: string;
  winner: "A" | "B" | "TIE";
  note?: string;
  decisionMs?: number;
  // All eight, same contract as the arena's submitVote — the server
  // rejects anything sparser.
  dimensions: {
    dimension: VoteDimension;
    winner: Winner;
    note?: string;
  }[];
}): Promise<{
  ok: boolean;
  votesOnPaper: number;
  paperDone: boolean;
  paperIndex: number;
  studyDone: boolean;
}> {
  const res = await fetch(`${BASE}/study/votes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  return jsonOrThrow(res);
}

export async function studyReveal(
  code: string,
  paperId: string,
): Promise<{ paperIndex: number; comparisons: StudyRevealComparison[] }> {
  const res = await fetch(
    `${BASE}/study/reveal?code=${encodeURIComponent(code)}&paperId=${encodeURIComponent(paperId)}`,
    { credentials: "include" },
  );
  return jsonOrThrow(res);
}

export async function studyRetry(code: string, paperId: string): Promise<{ ok: boolean; retried: number }> {
  const res = await fetch(`${BASE}/study/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, paperId }),
    credentials: "include",
  });
  return jsonOrThrow(res);
}
