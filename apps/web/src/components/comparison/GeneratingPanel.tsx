import { useEffect, useState } from "react";
import { ReviewSkeleton } from "@/components/comparison/ReviewSkeleton";

/**
 * The pre-streaming state: shown while we wait for /pair to land the
 * chosen reviewIds. Surfaces a "warming up" hint once 30 s have passed
 * so users know cold-start is normal, not a hang. Marker + Modal vLLM
 * can take 60-90 s on a fresh container.
 */
export function GeneratingPanel({
  completed,
  expected,
  parseFailed,
}: {
  completed: number;
  expected: number;
  parseFailed: boolean;
}) {
  const pct = expected > 0 ? Math.min(100, (completed / expected) * 100) : 0;

  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (parseFailed) return;
    const startedAt = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [parseFailed]);
  const showWarmupHint = elapsedMs > 30_000 && expected === 0;

  return (
    <div className="border border-rule2 bg-card">
      <div className="border-b border-rule px-4 py-4">
        {parseFailed ? (
          <div className="text-sm text-red">
            PDF parsing failed. Try a text-based PDF (not a scan).
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
                Parsing paper &amp; selecting pair…
              </div>
              <div className="font-mono text-xs text-graphite">
                {expected > 0
                  ? `pair of ${expected}`
                  : `${Math.floor(elapsedMs / 1000)}s`}
              </div>
            </div>
            <div className="relative mt-3 h-[7px] w-full border border-rule bg-paper2">
              <div
                className="absolute bottom-0 left-0 top-0 animate-pulse bg-red"
                style={{ width: pct > 0 ? `${pct}%` : "20%" }}
              />
            </div>
            <p className="mt-3 text-xs text-graphite">
              Two review systems are picked at random. Once the pair is
              ready, both reviews stream into the columns below
              token-by-token.
            </p>
            {showWarmupHint && (
              <p className="mt-2 font-mono text-xs text-graphite">
                First upload of the session — Marker is warming up its GPU
                container. This typically takes 60–90 seconds, then later
                uploads complete in 30–45s.
              </p>
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1px_1fr]">
        <ReviewSkeleton label="Review A" />
        <div className="hidden bg-rule lg:block" aria-hidden />
        <div className="h-px bg-rule lg:hidden" aria-hidden />
        <ReviewSkeleton label="Review B" />
      </div>
    </div>
  );
}
