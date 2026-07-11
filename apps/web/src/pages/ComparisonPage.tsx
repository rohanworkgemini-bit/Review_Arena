import { useMemo, useState } from "react";
import { useSearchParams, useNavigate, Navigate } from "react-router-dom";
import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { ApiError, getPair, getPaperStatus, submitVote } from "@/lib/api";
import { useReviewStream } from "@/hooks/useReviewStream";
import {
  DimensionProgress,
  DimensionRow,
  GeneratingPanel,
  StreamingReviewPanel,
} from "@/components/comparison";
import {
  VOTE_DIMENSIONS,
  DIMENSION_LABELS,
  DIMENSION_DESCRIPTIONS,
  CONFERENCE_NAMES,
  type VoteDimension,
  type PairResponse,
  type StructuredReview,
} from "@reviewarena/shared-types";

// DEV-ONLY visual fallback. Lets us hit /compare?paperId=... with no
// real data and see the layout (column widths, sticky vote bar, scoring
// dimensions). In production we never render this — the page either
// shows the real pair, the GeneratingPanel, or redirects to /upload.
const PLACEHOLDER_REVIEW_A: StructuredReview = {
  summary: "The paper proposes a method for X using Y. Experiments on Z show improvements over baselines.",
  strengths: [
    "Clear problem formulation tied to a real downstream task.",
    "Ablations cover the key design decisions.",
  ],
  weaknesses: [
    "Results on Z are statistically marginal (no confidence intervals reported).",
    "Comparison to prior work A and B is missing.",
  ],
  questions: [
    "How sensitive is the method to the choice of hyperparameter λ?",
    "Have the authors considered domain shift to dataset Q?",
  ],
  soundness: 3,
  presentation: 4,
  contribution: 3,
  overallRating: 6,
  confidence: 4,
};

const PLACEHOLDER_REVIEW_B: StructuredReview = {
  summary: "Authors tackle X with a Y-based approach and report gains over baseline B.",
  strengths: ["The empirical setup is reproducible."],
  weaknesses: [
    "The motivation is underspecified — why is this problem worth solving?",
    "Related work omits several core references.",
    "Figures 2 and 4 are difficult to read at the printed scale.",
  ],
  questions: ["Could the method be applied without supervised labels on Z?"],
  soundness: 2,
  presentation: 2,
  contribution: 2,
  overallRating: 4,
  confidence: 3,
};

const PLACEHOLDER_PAIR: PairResponse = {
  paper: { id: "placeholder", title: "On the Utility of LLMs for Code Review" },
  reviewA: { reviewId: "rev-a", structured: PLACEHOLDER_REVIEW_A },
  reviewB: { reviewId: "rev-b", structured: PLACEHOLDER_REVIEW_B },
  pairToken: "placeholder",
};

export function ComparisonPage() {
  const [params] = useSearchParams();
  const paperId = params.get("paperId") ?? "";
  const navigate = useNavigate();

  // /compare is only reachable via an upload — no standalone nav entry.
  // If someone lands here without a paperId, send them to /upload.
  useEffect(() => {
    if (!paperId) navigate("/upload", { replace: true });
  }, [paperId, navigate]);

  const startedAt = useMemo(() => Date.now(), [paperId]);
  const [dimensionValues, setDimensionValues] = useState<Partial<Record<VoteDimension, number>>>({});
  // Optional free-text rationale per dimension, keyed the same way.
  const [dimensionNotes, setDimensionNotes] = useState<Partial<Record<VoteDimension, string>>>({});
  // Optional free-text rationale for the overall verdict.
  const [overallNote, setOverallNote] = useState("");
  // Per-dimension picks are REQUIRED — open by default so the rater
  // sees right away that 8 picks are needed before they can submit.
  const [refineOpen, setRefineOpen] = useState(true);

  // Resume the in-flight round on reload. The pair is held stable from the
  // moment it's picked until the user votes — refreshing should never
  // re-roll. We persist the pairToken in sessionStorage keyed by
  // paperId and send it back on the next /pair call; the server honors it
  // if the HMAC + session match. Cleared in voteMutation.onSuccess so the
  // next round (next paper / explicit "next comparison") picks fresh.
  const PAIR_STORAGE_KEY = `pair-token:${paperId}`;
  const pairQuery = useQuery({
    queryKey: ["pair", paperId],
    queryFn: () => {
      const stored =
        typeof window !== "undefined"
          ? window.sessionStorage.getItem(PAIR_STORAGE_KEY) ?? undefined
          : undefined;
      return getPair(paperId, stored);
    },
    enabled: paperId.length > 0,
    retry: (failureCount, err) =>
      failureCount < 60 && err instanceof ApiError && err.code === "NotReady",
    retryDelay: 2000,
  });

  useEffect(() => {
    const token = pairQuery.data?.pairToken;
    if (token && typeof window !== "undefined") {
      window.sessionStorage.setItem(PAIR_STORAGE_KEY, token);
    }
  }, [pairQuery.data?.pairToken, PAIR_STORAGE_KEY]);

  // While reviews are still being generated, the API responds with
  // NotReady — drive a progress bar from /papers/:id so the user sees
  // generation move along rather than staring at a generic spinner.
  const pairError = pairQuery.error;
  const isGenerating =
    paperId.length > 0 &&
    !pairQuery.data &&
    (pairQuery.isPending ||
      (pairError instanceof ApiError && pairError.code === "NotReady"));

  const statusQuery = useQuery({
    queryKey: ["paper-status", paperId],
    queryFn: () => getPaperStatus(paperId),
    enabled: isGenerating,
    refetchInterval: isGenerating ? 1500 : false,
  });

  // Placeholder gating: in DEV we show mock data when no pair is loaded;
  // in PROD we never render mock (would skew Elo). PLACEHOLDER_PAIR is
  // ALWAYS the fallback for `pair` so the downstream hooks (useMutation,
  // useReviewStream) always get a defined value with the right shape —
  // this is purely a Rules-of-Hooks safety measure. In prod when there's
  // no real data and we're not generating, we redirect via <Navigate>
  // at the END of the render, AFTER all hooks have run.
  const allowPlaceholder = import.meta.env.DEV;
  const pair = pairQuery.data ?? PLACEHOLDER_PAIR;
  const usingPlaceholder = !pairQuery.data && !isGenerating && allowPlaceholder;
  const shouldRedirectToUpload =
    !pairQuery.data && !isGenerating && !allowPlaceholder && paperId.length > 0;

  const voteMutation = useMutation({
    mutationFn: (winner: "A" | "B" | "TIE") =>
      submitVote({
        pairToken: pair.pairToken,
        winner,
        note: overallNote.trim() || undefined,
        decisionMs: Date.now() - startedAt,
        dimensions: Object.entries(dimensionValues).map(([dimension, value]) => ({
          dimension: dimension as VoteDimension,
          value: value as -1 | 0 | 1,
          note: dimensionNotes[dimension as VoteDimension]?.trim() || undefined,
        })),
      }),
    onSuccess: (data) => {
      // Vote landed — release the stored pair so the next /compare visit
      // (from the reveal screen's "Next comparison" button) gets a fresh
      // sample instead of trying to resume this now-spent round.
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(PAIR_STORAGE_KEY);
      }
      const state = encodeURIComponent(JSON.stringify(data.reveal));
      navigate(`/reveal?voteId=${data.voteId}&state=${state}`);
    },
  });

  const refinedCount = Object.keys(dimensionValues).length;
  const allDimensionsFilled = refinedCount === VOTE_DIMENSIONS.length;
  const submitting = voteMutation.isPending;

  // Open streams here (not in the panels) so we can gate the vote bar
  // on "both done" at the parent level. The hook returns INITIAL state
  // when reviewId is undefined and short-circuits when the structured
  // payload was already in the /pair response.
  const streamA = useReviewStream(
    pairQuery.data && !pairQuery.data.reviewA.structured
      ? pairQuery.data.reviewA.reviewId
      : undefined,
  );
  const streamB = useReviewStream(
    pairQuery.data && !pairQuery.data.reviewB.structured
      ? pairQuery.data.reviewB.reviewId
      : undefined,
  );

  // bothReady = both reviews are in a TERMINAL state — either:
  //   (a) /pair returned structured outright (review COMPLETED before
  //       this page mounted),
  //   (b) the SSE stream emitted 'done' with structured, or
  //   (c) the stream errored (treated terminal so the user isn't stuck;
  //       the panel surfaces a Retry button so they can try again).
  // Voting while one side has errored is allowed — it counts as the
  // model "failing to review" which is real signal.
  const aReady =
    !!pairQuery.data?.reviewA.structured || streamA.done || !!streamA.error;
  const bReady =
    !!pairQuery.data?.reviewB.structured || streamB.done || !!streamB.error;
  const bothReady = aReady && bReady;

  // Keyboard shortcuts for power-users. 1 / 2 / 3 map to A / Tie / B.
  // Only fires when both reviews are ready and no input is focused.
  // ArrowLeft/Right as an alternate for muscle memory.
  useEffect(() => {
    if (!bothReady || submitting || isGenerating || !allDimensionsFilled) return;
    const cast = (winner: "A" | "B" | "TIE") => voteMutation.mutate(winner);
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "1" || e.key === "ArrowLeft") {
        e.preventDefault();
        cast("A");
      } else if (e.key === "2") {
        e.preventDefault();
        cast("TIE");
      } else if (e.key === "3" || e.key === "ArrowRight") {
        e.preventDefault();
        cast("B");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bothReady, submitting, isGenerating, allDimensionsFilled, voteMutation]);

  // Prod-only: pair is missing AND we're not actively generating →
  // something went wrong (stale link, pair API failed silently).
  // Declarative redirect via <Navigate> — safe to return AFTER all hooks
  // have run, unlike an early `return null` which would break hook order.
  if (shouldRedirectToUpload) {
    return <Navigate to="/upload" replace />;
  }

  return (
    // pb-32 so the sticky bottom bar never covers the last review section.
    <div className="container max-w-[1080px] py-6 pb-32 space-y-5">
      {usingPlaceholder && (
        <div className="flex justify-end">
          <Badge variant="outline">placeholder</Badge>
        </div>
      )}

      {isGenerating ? (
        <GeneratingPanel
          completed={statusQuery.data?.completedReviewCount ?? 0}
          expected={statusQuery.data?.expectedReviewCount ?? 0}
          parseFailed={statusQuery.data?.status === "PARSE_FAILED"}
        />
      ) : (
        // The signature: one card, two equal columns, a single 1px divider.
        <div className="border border-rule2 bg-card">
          <div className="flex items-baseline justify-between gap-3.5 border-b border-rule bg-paper2 px-4 py-[13px]">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-graphite">
              Pair / blind
              {pair.paper.conference && (
                <span className="ml-2 border border-rule2 px-1.5 py-0.5 normal-case tracking-[0.04em]">
                  {CONFERENCE_NAMES[pair.paper.conference]} form
                </span>
              )}
            </span>
            <span className="min-w-0 text-right font-serif text-sm italic">
              <span className="block font-mono text-[10.5px] not-italic tracking-[0.1em] text-graphite">
                Manuscript
              </span>
              “{pair.paper.title ?? "Untitled paper"}”
            </span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1px_1fr]">
            <StreamingReviewPanel
              label="Review A"
              structured={pair.reviewA.structured ?? null}
              stream={streamA}
            />
            <div className="hidden bg-rule lg:block" aria-hidden />
            <div className="h-px bg-rule lg:hidden" aria-hidden />
            <StreamingReviewPanel
              label="Review B"
              structured={pair.reviewB.structured ?? null}
              stream={streamB}
            />
          </div>
        </div>
      )}

      {/* Per-dimension picks are REQUIRED before submitting an overall
          vote — every rater must rate all 8 dimensions. Open by default
          so the requirement is visible immediately. Each dimension is a
          single segmented split-button (matrix-style survey pattern) for
          clear mutual-exclusion and tight vertical rhythm. */}
      <div className="border border-rule2 bg-card">
        <button
          type="button"
          onClick={() => setRefineOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 bg-paper2 px-4 py-3 hover:bg-paper2/70"
        >
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
              Rate every dimension
            </span>
            <span className="font-mono text-[11px] text-red">required</span>
          </div>
          <div className="flex items-center gap-3">
            <DimensionProgress
              count={refinedCount}
              total={VOTE_DIMENSIONS.length}
            />
            <span
              aria-hidden
              className={cn(
                "text-graphite transition-transform duration-150",
                refineOpen && "rotate-90",
              )}
            >
              ▸
            </span>
          </div>
        </button>
        {refineOpen && (
          <div className="border-t border-rule px-4 py-4">
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
              {VOTE_DIMENSIONS.map((d) => {
                const v = dimensionValues[d];
                const pick = (next: -1 | 0 | 1) =>
                  setDimensionValues((prev) => {
                    const copy = { ...prev };
                    // Click the already-selected side to deselect.
                    if (copy[d] === next) delete copy[d];
                    else copy[d] = next;
                    return copy;
                  });
                return (
                  <DimensionRow
                    key={d}
                    label={DIMENSION_LABELS[d]}
                    question={DIMENSION_DESCRIPTIONS[d]}
                    value={v}
                    note={dimensionNotes[d] ?? ""}
                    onPick={pick}
                    onChangeNote={(text) =>
                      setDimensionNotes((prev) => ({ ...prev, [d]: text }))
                    }
                  />
                );
              })}
            </div>
            {refinedCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setDimensionValues({});
                  setDimensionNotes({});
                }}
                className="mt-4 font-mono text-xs text-graphite underline-offset-4 hover:text-ink hover:underline"
              >
                Clear all picks
              </button>
            )}
          </div>
        )}
      </div>

      {/* Optional overall rationale — free-text for the final A/Tie/B
          verdict, mirroring the per-dimension notes. Never gates the vote. */}
      <div className="border border-rule2 bg-card">
        <div className="flex items-baseline gap-2 bg-paper2 px-4 py-3">
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
            Overall note
          </span>
          <span className="font-mono text-[11px] text-graphite">optional</span>
        </div>
        <div className="border-t border-rule px-4 py-4">
          <textarea
            value={overallNote}
            onChange={(e) => setOverallNote(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="Why is this review more useful? (optional)"
            aria-label="Overall verdict note"
            className="w-full resize-y border border-rule2 bg-paper px-2.5 py-2 font-mono text-[12.5px] leading-relaxed text-ink placeholder:text-graphite"
          />
        </div>
      </div>

      {voteMutation.isError && (
        <p className="font-mono text-sm text-red">{(voteMutation.error as Error).message}</p>
      )}

      {/* Sticky vote strip — the single primary action on the page. */}
      <div
        className="fixed bottom-0 right-0 z-30 border-t border-rule bg-paper left-0 lg:[left:var(--sidebar-w)]"
      >
        <div className="container max-w-[1080px] flex flex-col gap-2 py-3 md:flex-row md:items-center">
          {bothReady && !allDimensionsFilled ? (
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-red md:whitespace-nowrap">
              Rate all {VOTE_DIMENSIONS.length} dimensions to vote ·{" "}
              {refinedCount}/{VOTE_DIMENSIONS.length}
            </span>
          ) : (
            <span className="hidden font-mono text-[11px] uppercase tracking-[0.1em] text-graphite md:inline">
              Which review is more useful?
            </span>
          )}
          <div className="flex flex-1 gap-2.5">
            {(
              [
                { winner: "A" as const, label: "Review A", kbd: "1", hint: "Shortcut: 1 or ←" },
                { winner: "TIE" as const, label: "Tie", kbd: "2", hint: "Shortcut: 2" },
                { winner: "B" as const, label: "Review B", kbd: "3", hint: "Shortcut: 3 or →" },
              ]
            ).map((b) => (
              <Button
                key={b.winner}
                size="lg"
                className="flex-1"
                variant="outline"
                disabled={submitting || isGenerating || !bothReady || !allDimensionsFilled}
                onClick={() => voteMutation.mutate(b.winner)}
                title={
                  !allDimensionsFilled
                    ? `Rate all ${VOTE_DIMENSIONS.length} dimensions first`
                    : b.hint
                }
              >
                <span>{b.label}</span>
                <kbd className="ml-2 hidden border border-rule2 px-1.5 font-mono text-[10px] text-graphite md:inline">
                  {b.kbd}
                </kbd>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
