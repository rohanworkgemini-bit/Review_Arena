import { useCallback, useEffect, useRef, useState } from "react";
import type { StructuredReview } from "@reviewarena/shared-types";

/**
 * Subscribe to an SSE stream of review tokens from
 * /api/reviews/stream/:reviewId. Accumulates text chunks, surfaces a
 * final structured review on done, error message on failure.
 *
 * Disconnect handling:
 *   - 'done' → close, mark done=true, no auto-reconnect.
 *   - 'error' with payload → surface message, mark error, close.
 *   - 'error' without payload and readyState CLOSED (non-200 response,
 *     e.g. 403/404) → terminal immediately; the browser won't reconnect.
 *   - 'error' without payload (transport hiccup) → tolerate up to
 *     STALL_MS of silence, then surface as a stall error so the UI can
 *     offer a retry instead of spinning forever.
 *   - The hook exposes a `retry` function the UI calls to rebuild the
 *     EventSource from scratch after an error.
 *
 * Disabled when reviewId is undefined (e.g. before the pair is known).
 */
export interface ReviewStreamState {
  text: string;
  done: boolean;
  structured: StructuredReview | null;
  error: string | null;
  /** Trigger a fresh EventSource for the same reviewId. No-op if streaming. */
  retry: () => void;
}

// Silence tolerated before we declare a stream stalled.
//
// Raised 90s → 300s for the 2026-07 lineup. Measured TTFT on a ~10k-word
// paper: mistral-large-3 0.7s, claude-opus-5 2.1s, gpt-5.5 2.5s — but
// gpt-5.5-pro 61s, because the "pro" reasoning tier runs on the Responses
// API and buffers the ENTIRE review into a single delta after thinking.
// On a full-length submission that comfortably passes 90s, so the old
// value would have failed a healthy stream and shown participants a
// "stalled" error mid-battle.
const STALL_MS = 300_000;

const INITIAL = {
  text: "",
  done: false,
  structured: null as StructuredReview | null,
  error: null as string | null,
};

export function useReviewStream(
  reviewId: string | undefined,
): ReviewStreamState {
  const [state, setState] = useState(INITIAL);
  // Bumping this re-runs the effect → new EventSource. Decoupled from
  // reviewId so the parent doesn't have to remount the panel.
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  // Latest stall-watchdog timer; cleared on each token / unmount.
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Consecutive transport-level failures with zero tokens received.
  // EventSource reconnects forever on its own; before the first token
  // that means a dead backend, and 100 tabs silently re-hitting it every
  // few seconds for 5 minutes is a retry storm that fights recovery.
  const bareErrors = useRef(0);
  const gotTokens = useRef(false);

  useEffect(() => {
    if (!reviewId) {
      setState(INITIAL);
      return;
    }
    setState(INITIAL);
    bareErrors.current = 0;
    gotTokens.current = false;

    const es = new EventSource(`/api/reviews/stream/${reviewId}`, {
      withCredentials: true,
    });

    const armStall = () => {
      if (stallTimer.current) clearTimeout(stallTimer.current);
      stallTimer.current = setTimeout(() => {
        setState((prev) => ({
          ...prev,
          error: prev.error ?? "Stream stalled — no tokens for 5 minutes",
        }));
        es.close();
      }, STALL_MS);
    };
    armStall();

    es.addEventListener("token", (e) => {
      armStall();
      bareErrors.current = 0;
      gotTokens.current = true;
      try {
        const payload = JSON.parse((e as MessageEvent).data) as { text?: string };
        if (payload.text) {
          setState((prev) => ({ ...prev, text: prev.text + payload.text }));
        }
      } catch {
        /* malformed JSON — skip */
      }
    });

    es.addEventListener("done", (e) => {
      if (stallTimer.current) clearTimeout(stallTimer.current);
      try {
        const payload = JSON.parse((e as MessageEvent).data) as {
          review?: StructuredReview;
          raw_output?: string;
        };
        setState((prev) => ({
          text: payload.raw_output ?? prev.text,
          done: true,
          structured: payload.review ?? null,
          error: null,
        }));
      } catch {
        setState((prev) => ({ ...prev, done: true }));
      }
      es.close();
    });

    es.addEventListener("error", (e) => {
      // Server-side errors carry a JSON payload with a message. Transport
      // hiccups are bare events (the EventSource may auto-reconnect on
      // its own; the stall watchdog catches the "stuck reconnecting"
      // case).
      let msg: string | null = null;
      try {
        const payload = JSON.parse((e as MessageEvent).data ?? "{}") as {
          message?: string;
        };
        msg = payload.message ?? null;
      } catch {
        /* transport-level error event — bare, no JSON */
      }
      if (msg) {
        if (stallTimer.current) clearTimeout(stallTimer.current);
        setState((prev) => ({ ...prev, error: msg }));
        es.close();
        return;
      }
      // CLOSED after a bare error means the browser gave up for good (non-200
      // response such as 403/404, or a wrong content type) — it will not
      // reconnect, so waiting for more errors or the watchdog is pointless.
      if (es.readyState === EventSource.CLOSED) {
        if (stallTimer.current) clearTimeout(stallTimer.current);
        setState((prev) => ({
          ...prev,
          error:
            prev.error ??
            "Couldn't open the review stream. Use Retry, or reload the page.",
        }));
        es.close();
        return;
      }
      // Bare transport error. Before any token has arrived, a handful in
      // a row means the backend is down — surface it instead of leaving
      // the user on "waiting for first token…" for the 5-minute watchdog.
      // Mid-stream, the stall watchdog stays in charge (models pause).
      bareErrors.current += 1;
      if (!gotTokens.current && bareErrors.current >= 5) {
        if (stallTimer.current) clearTimeout(stallTimer.current);
        setState((prev) => ({
          ...prev,
          error:
            prev.error ??
            "Can't reach the server — it may be restarting. Use Retry in a moment.",
        }));
        es.close();
      }
    });

    return () => {
      if (stallTimer.current) clearTimeout(stallTimer.current);
      es.close();
    };
  }, [reviewId, retryNonce]);

  return { ...state, retry };
}
