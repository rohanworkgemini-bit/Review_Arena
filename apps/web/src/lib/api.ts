import type {
  Conference,
  PairResponse,
  RevealDetailResponse,
  SubmitVoteRequest,
  SubmitVoteResponse,
  LeaderboardResponse,
  UploadPaperResponse,
} from "@reviewarena/shared-types";

// Thin fetch wrapper. TanStack Query handles caching, retries, status.
// We deliberately don't add a third axios-like abstraction layer here.

const BASE = "/api";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let code = "";
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      code = body.error ?? "";
      detail = body.message ?? "";
    } catch {
      /* response not JSON */
    }
    throw new ApiError(res.status, code, `${res.status} ${res.statusText}: ${detail}`);
  }
  return res.json() as Promise<T>;
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
  const url = new URL(`${BASE}/leaderboard`, window.location.origin);
  if (dimension) url.searchParams.set("dimension", dimension);
  const res = await fetch(url.toString(), { credentials: "include" });
  return jsonOrThrow<LeaderboardResponse>(res);
}
