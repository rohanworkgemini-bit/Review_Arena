import { useEffect, useState } from "react";
import { getSession } from "./api";

// Reads the caller's anonymous session id (via GET /session — the cookie
// itself is httpOnly and unreadable from JS). Module-level cache + a
// single in-flight promise dedupe the request across every component that
// mounts this hook, so the whole app fetches it at most once. Failures are
// swallowed: the UI just shows nothing rather than erroring.
let cached: string | null = null;
let inflight: Promise<string> | null = null;

export function useSessionId(): string | null {
  const [sid, setSid] = useState<string | null>(cached);

  useEffect(() => {
    if (cached) return;
    let active = true;
    inflight ??= getSession().then((r) => {
      cached = r.sessionId;
      return r.sessionId;
    });
    inflight
      .then((id) => {
        if (active) setSid(id);
      })
      .catch(() => {
        inflight = null; // allow a later retry
      });
    return () => {
      active = false;
    };
  }, []);

  return sid;
}
