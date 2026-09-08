import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate, Navigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { ApiError, getPair, getPaperStatus, submitVote } from "@/lib/api";
import { useReviewStream } from "@/hooks/useReviewStream";
import { BottomBar } from "@/components/layout/BottomBar";
import {
  DimensionProgress,
  DimensionRow,
  GeneratingPanel,
  HighlightToolbar,
  StreamingReviewPanel,
} from "@/components/comparison";
import { addHighlights, type Highlight } from "@/lib/highlight";
import { clearDraft, draftKey, loadDraft, saveDraft } from "@/lib/voteDraft";
import {
  VOTE_DIMENSIONS,
  DIMENSION_LABELS,
  DIMENSION_DESCRIPTIONS,
  CONFERENCE_NAMES,
  type VoteDimension,
  type PairResponse,
  type StructuredReview,
  type SubmitVoteResponse,
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

/** What we stash in sessionStorage after a successful vote, so returning
 *  to this page from the reveal screen can render it read-only. */
interface CastVote {
  voteId: string;
  winner: "A" | "B" | "TIE";
  dimensionValues: Partial<Record<VoteDimension, number>>;
  dimensionNotes: Partial<Record<VoteDimension, string>>;
  overallNote: string;
  /** URL-encoded reveal header. /reveal renders a placeholder (dev) or an
   *  error header (prod) without it, so going back must carry it along. */
  revealState: string;
}

export function ComparisonPage() {
  const [params] = useSearchParams();
  const paperId = params.get("paperId") ?? "";
  const navigate = useNavigate();

  // /compare is only reachable via an upload — no standalone nav entry.
  // If someone lands here without a paperId, send them to /upload.
  useEffect(() => {
    if (!paperId) navigate("/upload", { replace: true });
  }, [paperId, navigate]);

  // An unsubmitted draft for this paper, if the tab was reloaded mid-survey.
  // A cast vote always wins: that one is final and the page is read-only.
  const dKey = paperId ? draftKey("arena", paperId) : null;
  const draft = useMemo(() => (dKey ? loadDraft(dKey) : null), [dKey]);

  // Restored so decisionMs measures from when the rater FIRST opened this
  // pair. Under-reporting a resumed vote would make it look rushed, and
  // "too fast to be real" is a quality flag in the analysis.
  const startedAt = useMemo(
    () => draft?.startedAt ?? Date.now(),
    [paperId, draft], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Record of the vote already cast for this paper in this tab, if any.
  // Written on submit, read back when the user walks in from the reveal
  // screen's "Back to the reviews" link. Its presence flips the whole page
  // to read-only: the reviews and the choices stay visible, but nothing is
  // editable and no second vote can be sent (the API would 409 anyway —
  // one vote per session per pair).
  const castVote = useMemo<CastVote | null>(() => {
    if (typeof window === "undefined" || !paperId) return null;
    try {
      const raw = window.sessionStorage.getItem(`vote-cast:${paperId}`);
      return raw ? (JSON.parse(raw) as CastVote) : null;
    } catch {
      return null;
    }
  }, [paperId]);
  const readOnly = castVote !== null;

  // Seeded from the stored vote when revisiting, so the read-only view
  // shows exactly what was submitted rather than an empty survey.
  const [dimensionValues, setDimensionValues] = useState<Partial<Record<VoteDimension, number>>>(
    () => castVote?.dimensionValues ?? draft?.values ?? {},
  );
  // Optional free-text rationale per dimension, keyed the same way.
  const [dimensionNotes, setDimensionNotes] = useState<Partial<Record<VoteDimension, string>>>(
    () => castVote?.dimensionNotes ?? draft?.notes ?? {},
  );
  // Optional free-text rationale for the overall verdict.
  const [overallNote, setOverallNote] = useState(
    () => castVote?.overallNote ?? draft?.note ?? "",
  );
  // Per-dimension picks are REQUIRED — open by default so the rater
  // sees right away that 8 picks are needed before they can submit.
  const [refineOpen, setRefineOpen] = useState(true);

  // Highlighter: arm a dimension, select text in either review to tint it,
  // hover a tint to see which dimension it belongs to. Reading aid only —
  // held in component state and never sent with the vote.
  const [highlighter, setHighlighter] = useState<VoteDimension | null>(null);
  // Seeded from the draft: the pair is held by its token across a reload,
  // so the same markdown re-renders to the same blocks and the stored
  // offsets still address the words the rater marked.
  const [marksA, setMarksA] = useState<Highlight[]>(() => draft?.marksA ?? []);
  const [marksB, setMarksB] = useState<Highlight[]>(() => draft?.marksB ?? []);

  // Persist the in-progress survey so a reload does not cost the rater a
  // re-read of both reviews. Skipped once a vote is cast — that record is
  // final and lives in sessionStorage instead.
  useEffect(() => {
    if (!dKey || readOnly) return;
    saveDraft(dKey, {
      note: overallNote,
      values: dimensionValues as Partial<Record<VoteDimension, -1 | 0 | 1>>,
      notes: dimensionNotes,
      marksA,
      marksB,
      startedAt,
    });
  }, [dKey, readOnly, overallNote, dimensionValues, dimensionNotes, marksA, marksB, startedAt]);

  // Resume the in-flight round on reload. The pair is held stable from the
  // moment it's picked until the user votes — refreshing should never
  // re-roll. We persist the pairToken in sessionStorage keyed by
  // paperId and send it back on the next /pair call; the server honors it
  // if the HMAC + session match. Cleared in voteMutation.onSuccess so the
  // next round (next paper / explicit "next comparison") picks fresh.
  const PAIR_STORAGE_KEY = `pair-token:${paperId}`;
  // Wall-clock budget for generation. The old retry loop gave up silently
  // after ~2 min (rate-limited providers routinely take longer in a bursty
  // class) and then dead-ended on the skeleton because nothing ever
  // refetched. refetchInterval keeps polling an errored NotReady query;
  // past the budget we stop and show an explicit card instead.
  const GENERATION_BUDGET_MS = 12 * 60_000;
  const generationStartedAt = useRef(Date.now());
  useEffect(() => {
    generationStartedAt.current = Date.now();
  }, [paperId]);

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
    retry: false,
    refetchInterval: (q) => {
      if (q.state.data) return false;
      const err = q.state.error;
      const notReady = err instanceof ApiError && err.code === "NotReady";
      if (!notReady && q.state.errorUpdateCount > 5) return false; // hard errors: stop
      if (Date.now() - generationStartedAt.current > GENERATION_BUDGET_MS) return false;
      return 2500;
    },
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
  const notReady = pairError instanceof ApiError && pairError.code === "NotReady";
  const generationTimedOut =
    paperId.length > 0 &&
    !pairQuery.data &&
    notReady &&
    Date.now() - generationStartedAt.current > GENERATION_BUDGET_MS;
  const isGenerating =
    paperId.length > 0 &&
    !pairQuery.data &&
    !generationTimedOut &&
    (pairQuery.isPending || notReady);

  const statusQuery = useQuery({
    queryKey: ["paper-status", paperId],
    queryFn: () => getPaperStatus(paperId),
    enabled: isGenerating,
    refetchInterval: (q) =>
      isGenerating && q.state.errorUpdateCount < 20 ? 1500 : false,
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
    !pairQuery.data &&
    !isGenerating &&
    !generationTimedOut &&
    !allowPlaceholder &&
    paperId.length > 0;

  // Ref, not state: the keyboard handler's closure captures a stale
  // `voteMutation.isPending`, so two rapid keypresses could both fire.
  const voteInFlight = useRef(false);

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
    onSettled: () => {
      voteInFlight.current = false;
    },
    onError: (err, winner) => {
      // 409 = this session already voted on this pair — usually a first
      // submit whose response was lost. The server echoes the recorded
      // voteId + reveal payload, so finish the journey instead of telling
      // the student to "upload another paper" about their own vote.
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as {
          voteId?: string | null;
          reveal?: SubmitVoteResponse["reveal"] | null;
        } | null;
        if (body?.voteId && body.reveal) {
          finishVote({ voteId: body.voteId, reveal: body.reveal }, winner);
        }
      }
    },
    onSuccess: (data, winner) => {
      finishVote(data, winner);
    },
  });

  // Shared by the success path and the 409 duplicate-vote recovery path.
  // Releases the stored pair so the next /compare visit gets a fresh
  // sample, records what was submitted for the read-only revisit view,
  // and moves on to the reveal screen.
  function finishVote(
    data: { voteId: string; reveal: SubmitVoteResponse["reveal"] },
    winner: "A" | "B" | "TIE",
  ) {
    const state = encodeURIComponent(JSON.stringify(data.reveal));
    // The vote is recorded server-side; the scratchpad has done its job.
    if (dKey) clearDraft(dKey);
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(PAIR_STORAGE_KEY);
      const record: CastVote = {
        voteId: data.voteId,
        winner,
        dimensionValues,
        dimensionNotes,
        overallNote,
        revealState: state,
      };
      try {
        window.sessionStorage.setItem(`vote-cast:${paperId}`, JSON.stringify(record));
      } catch {
        /* storage full / disabled — read-only view just won't rehydrate */
      }
    }
    navigate(
      `/reveal?voteId=${data.voteId}&paperId=${encodeURIComponent(paperId)}&state=${state}`,
    );
  }

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
    // No shortcuts once the vote is in — the page is a record, not a form.
    if (readOnly) return;
    if (!bothReady || submitting || isGenerating || !allDimensionsFilled) return;
    const cast = (winner: "A" | "B" | "TIE") => {
      if (voteInFlight.current) return;
      voteInFlight.current = true;
      voteMutation.mutate(winner);
    };
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
  }, [readOnly, bothReady, submitting, isGenerating, allDimensionsFilled, voteMutation]);

  // Prod-only: pair is missing AND we're not actively generating →
  // something went wrong (stale link, pair API failed silently).
  // Declarative redirect via <Navigate> — safe to return AFTER all hooks
  // have run, unlike an early `return null` which would break hook order.
  if (shouldRedirectToUpload) {
    return <Navigate to="/upload" replace />;
  }

  return (
    <div className="container max-w-[1080px] py-6 space-y-5">
      {usingPlaceholder && (
        <div className="flex justify-end">
          <Badge variant="outline">placeholder</Badge>
        </div>
      )}

      {generationTimedOut ? (
        <div className="border border-rule2 bg-card px-6 py-10 text-center">
          <p className="font-mono text-sm text-ink">
            Generation is taking unusually long.
          </p>
          <p className="mx-auto mt-2 max-w-prose text-sm text-graphite">
            The reviewers may be rate-limited right now. Your paper is safe —
            you can keep waiting or come back to this page later.
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <Button
              onClick={() => {
                generationStartedAt.current = Date.now();
                void pairQuery.refetch();
              }}
            >
              Keep waiting
            </Button>
            <Button asChild variant="outline">
              <a href="/upload">Upload a different paper</a>
            </Button>
          </div>
        </div>
      ) : isGenerating ? (
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
          <HighlightToolbar
            className="border-x-0 border-b border-t-0"
            active={highlighter}
            onChange={setHighlighter}
            highlights={[...marksA, ...marksB]}
            onClear={() => {
              setMarksA([]);
              setMarksB([]);
            }}
          />
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1px_1fr]">
            <StreamingReviewPanel
              label="Review A"
              structured={pair.reviewA.structured ?? null}
              rawOutput={pair.reviewA.rawOutput ?? null}
              stream={streamA}
              conference={pair.paper.conference}
              highlights={marksA}
              highlighterArmed={highlighter !== null}
              onSelectRanges={(r) =>
                highlighter && setMarksA((prev) => addHighlights(prev, r, highlighter))
              }
              onRemoveHighlight={(id) => setMarksA((prev) => prev.filter((h) => h.id !== id))}
            />
            <div className="hidden bg-rule lg:block" aria-hidden />
            <div className="h-px bg-rule lg:hidden" aria-hidden />
            <StreamingReviewPanel
              label="Review B"
              structured={pair.reviewB.structured ?? null}
              rawOutput={pair.reviewB.rawOutput ?? null}
              stream={streamB}
              conference={pair.paper.conference}
              highlights={marksB}
              highlighterArmed={highlighter !== null}
              onSelectRanges={(r) =>
                highlighter && setMarksB((prev) => addHighlights(prev, r, highlighter))
              }
              onRemoveHighlight={(id) => setMarksB((prev) => prev.filter((h) => h.id !== id))}
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
                const pick = (next: -1 | 0 | 1) => {
                  if (readOnly) return;
                  setDimensionValues((prev) => {
                    const copy = { ...prev };
                    // Click the already-selected side to deselect.
                    if (copy[d] === next) delete copy[d];
                    else copy[d] = next;
                    return copy;
                  });
                };
                return (
                  <DimensionRow
                    key={d}
                    label={DIMENSION_LABELS[d]}
                    question={DIMENSION_DESCRIPTIONS[d]}
                    value={v}
                    note={dimensionNotes[d] ?? ""}
                    onPick={pick}
                    readOnly={readOnly}
                    onChangeNote={(text) => {
                      if (readOnly) return;
                      setDimensionNotes((prev) => ({ ...prev, [d]: text }));
                    }}
                  />
                );
              })}
            </div>
            {refinedCount > 0 && !readOnly && (
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
            readOnly={readOnly}
            maxLength={1000}
            rows={3}
            placeholder={readOnly ? "No note given." : "Why is this review more useful? (optional)"}
            aria-label="Overall verdict note"
            className="w-full resize-y border border-rule2 bg-paper px-2.5 py-2 font-mono text-[12.5px] leading-relaxed text-ink placeholder:text-graphite"
          />
        </div>
      </div>

      {voteMutation.isError && (
        // A 409 is the expected outcome when someone walks back here from
        // the reveal screen: the pair is already spent for this session
        // (votes_session_pair_sig_uk). That is not a failure, so say so in
        // plain language instead of showing a raw error string.
        voteMutation.error instanceof ApiError && voteMutation.error.status === 409 ? (
          <p className="text-sm text-graphite">
            You have already voted on this pair — your original vote still
            stands. Upload another paper to keep comparing.
          </p>
        ) : (
          <p className="font-mono text-sm text-red">{(voteMutation.error as Error).message}</p>
        )
      )}

      {/* Sticky vote strip — the single primary action on the page. Must
          stay the LAST child of the container so it comes to rest above
          the footer at the end of the page (see BottomBar). */}
      <BottomBar className="border-rule bg-paper">
        <div className="flex flex-col gap-2 py-3 md:flex-row md:items-center">
          {readOnly ? (
            // Already voted: the strip becomes a record of the verdict plus
            // a way back to the reveal, instead of a second chance to vote.
            <>
              <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-graphite md:whitespace-nowrap">
                Vote recorded
              </span>
              <div className="flex flex-1 flex-wrap items-center gap-2.5">
                <span className="text-sm text-ink">
                  You chose{" "}
                  <strong className="font-semibold">
                    {castVote.winner === "TIE"
                      ? "Tie"
                      : castVote.winner === "A"
                      ? "Review A"
                      : "Review B"}
                  </strong>
                  . This page is read-only.
                </span>
                <Button
                  size="lg"
                  className="ml-auto"
                  onClick={() =>
                    navigate(
                      `/reveal?voteId=${castVote.voteId}` +
                        `&paperId=${encodeURIComponent(paperId)}` +
                        `&state=${castVote.revealState}`,
                    )
                  }
                >
                  Back to results →
                </Button>
              </div>
            </>
          ) : bothReady && !allDimensionsFilled ? (
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-red md:whitespace-nowrap">
              Rate all {VOTE_DIMENSIONS.length} dimensions to vote ·{" "}
              {refinedCount}/{VOTE_DIMENSIONS.length}
            </span>
          ) : (
            <span className="hidden font-mono text-[11px] uppercase tracking-[0.1em] text-graphite md:inline">
              Which review is more useful?
            </span>
          )}
          {!readOnly && (
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
          )}
        </div>
      </BottomBar>
    </div>
  );
}
