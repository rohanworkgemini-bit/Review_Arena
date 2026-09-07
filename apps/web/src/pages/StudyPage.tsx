import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useDropzone, type FileRejection } from "react-dropzone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReviewPanel } from "@/components/comparison/ReviewPanel";
import { DimensionProgress, DimensionRow, HighlightToolbar } from "@/components/comparison";
import { addHighlights, type Highlight } from "@/lib/highlight";
import { cn } from "@/lib/cn";
import {
  CONFERENCE_OPTIONS,
  SOURCE_OPTIONS,
  StyledDropdown,
  type UploadSource,
} from "@/components/ui/styled-dropdown";
import {
  DIMENSION_DESCRIPTIONS,
  DIMENSION_LABELS,
  VOTE_DIMENSIONS,
  type Conference,
  type VoteDimension,
} from "@reviewarena/shared-types";
import {
  ApiError,
  studyPairFetch,
  studyRetry,
  studyReveal,
  studyState,
  studyUploadArxiv,
  studyUploadPdf,
  studyVote,
  type StudyPaperState,
  type StudyState,
} from "@/lib/api";

/**
 * The controlled study's single-page flow (/study). Standalone — no app
 * shell and no leaderboard nav *during* the session, so a participant
 * can't check standings between their own comparisons. The board is
 * unlocked on the final reveal, once every vote of theirs is recorded.
 *
 * Voting is identical to the arena: all eight dimensions required, same
 * widgets and wording. The deterministic rotation is the only difference.
 *
 * Screens, driven entirely by GET /study/state:
 *   code entry → upload paper N → "reviews generating" progress →
 *   3 blind comparisons (8 dimensions + overall verdict) → per-paper
 *   celebration + identity reveal → next paper → final thank-you +
 *   leaderboard.
 */

const CODE_KEY = "ra-study-code";

export default function StudyPage() {
  const [code, setCode] = useState<string>(() => {
    try {
      return localStorage.getItem(CODE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [entered, setEntered] = useState<boolean>(() => !!code);

  if (!entered || !code) {
    return (
      <StudyFrame>
        <CodeEntry
          initial={code}
          onSubmit={(c) => {
            setCode(c);
            setEntered(true);
            try {
              localStorage.setItem(CODE_KEY, c);
            } catch {
              /* private mode */
            }
          }}
        />
      </StudyFrame>
    );
  }
  return (
    <StudyFrame>
      <StudyFlow
        code={code}
        onBadCode={() => {
          setEntered(false);
        }}
      />
    </StudyFrame>
  );
}

function StudyFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b border-rule2 px-6 py-4">
        <span className="font-serif text-lg font-semibold">ReviewArena</span>
        <span className="ml-3 font-mono text-xs text-graphite">controlled study</span>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}

function CodeEntry({ initial, onSubmit }: { initial: string; onSubmit: (c: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="mx-auto max-w-md pt-16 text-center">
      <h1 className="mb-2 font-serif text-2xl font-semibold">Welcome</h1>
      <p className="mb-6 text-sm text-ink2">
        Enter the participant code you received to begin. You will upload two
        papers and judge three review comparisons for each.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
        className="flex gap-2"
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. maple-1234"
          className="flex-1 border border-rule bg-white px-3 py-2 font-mono text-sm outline-none focus:border-ink"
          autoFocus
        />
        <Button type="submit">Start</Button>
      </form>
    </div>
  );
}

function StudyFlow({ code, onBadCode }: { code: string; onBadCode: () => void }) {
  const qc = useQueryClient();
  const stateQuery = useQuery({
    queryKey: ["study-state", code],
    queryFn: () => studyState(code),
    refetchInterval: (q) => {
      const s = q.state.data;
      if (!s) return false;
      // Poll while any paper is parsing/generating; otherwise on demand.
      const busy = s.papers.some(
        (p) =>
          p.paperId &&
          p.status !== "PARSE_FAILED" &&
          (p.status !== "PARSED" ||
            (p.comparisons ?? []).some((c) => !c.ready && !c.failed && !c.voted)),
      );
      return busy ? 4000 : false;
    },
    retry: 1,
  });

  useEffect(() => {
    if (stateQuery.error instanceof ApiError && stateQuery.error.status === 404) {
      try {
        localStorage.removeItem(CODE_KEY);
      } catch {
        /* noop */
      }
      onBadCode();
    }
  }, [stateQuery.error, onBadCode]);

  const refresh = useCallback(
    () => qc.invalidateQueries({ queryKey: ["study-state", code] }),
    [qc, code],
  );

  // Reveal acknowledgment survives reloads so the celebration doesn't loop.
  const [ackPapers, setAckPapers] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("ra-study-acks") ?? "{}");
    } catch {
      return {};
    }
  });
  const acknowledge = (paperId: string) => {
    const next = { ...ackPapers, [paperId]: true };
    setAckPapers(next);
    try {
      localStorage.setItem("ra-study-acks", JSON.stringify(next));
    } catch {
      /* noop */
    }
  };

  const s = stateQuery.data;
  if (stateQuery.isLoading || !s) {
    return (
      <p className="flex items-center gap-2 font-mono text-sm text-graphite">
        <Loader2 className="h-4 w-4 animate-spin" /> loading…
      </p>
    );
  }

  // Decide the current screen from state, in schedule order.
  for (const paper of s.papers) {
    if (!paper.paperId) {
      return <UploadScreen code={code} state={s} paperIndex={paper.paperIndex} onDone={refresh} />;
    }
    if (paper.status === "PARSE_FAILED") {
      return (
        <UploadScreen
          code={code}
          state={s}
          paperIndex={paper.paperIndex}
          failedMessage="That paper could not be processed — please try a different PDF or arXiv link."
          onDone={refresh}
        />
      );
    }
    const comps = paper.comparisons ?? [];
    if (paper.status !== "PARSED" || comps.length === 0) {
      return <GeneratingScreen code={code} paper={paper} />;
    }
    const nextComp = comps.find((c) => !c.voted && c.ready);
    if (nextComp) {
      return (
        <ComparisonScreen
          key={nextComp.comparisonId}
          code={code}
          comparisonId={nextComp.comparisonId}
          pairIndex={nextComp.pairIndex}
          paperIndex={paper.paperIndex}
          state={s}
          onVoted={refresh}
        />
      );
    }
    const unvoted = comps.filter((c) => !c.voted);
    if (unvoted.length > 0) {
      // Remaining comparisons exist but aren't ready (still generating or failed).
      return <GeneratingScreen code={code} paper={paper} />;
    }
    // Paper fully voted → celebration + reveal, until acknowledged.
    if (!ackPapers[paper.paperId] || paper.paperIndex === s.papersPerParticipant) {
      return (
        <RevealScreen
          code={code}
          paperId={paper.paperId}
          paperIndex={paper.paperIndex}
          state={s}
          acknowledged={!!ackPapers[paper.paperId]}
          onContinue={
            paper.paperIndex < s.papersPerParticipant
              ? () => acknowledge(paper.paperId!)
              : undefined
          }
        />
      );
    }
  }

  return <RevealScreenDoneFallback />;
}

function Progress({ state, paperIndex }: { state: StudyState; paperIndex: number }) {
  return (
    <p className="mb-6 font-mono text-xs uppercase tracking-[0.1em] text-graphite">
      {state.participantId} · paper {paperIndex} of {state.papersPerParticipant} ·{" "}
      {state.totalVotes} of {state.papersPerParticipant * state.pairsPerPaper} judgements done
    </p>
  );
}

// Mirrors the arena UploadPage exactly — same dropzone, review-format
// picker, title field, consent notice, and bottom bar — so participants
// see the platform's normal upload experience.
const MAX_SIZE = 10 * 1024 * 1024;
const ARXIV_HINT_RE =
  /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf|html)\/)?\d{4}\.\d{4,5}(?:v\d+)?$/i;

function UploadScreen({
  code,
  state,
  paperIndex,
  failedMessage,
  onDone,
}: {
  code: string;
  state: StudyState;
  paperIndex: number;
  failedMessage?: string;
  onDone: () => void;
}) {
  const [source, setSource] = useState<UploadSource>("pdf");
  const [file, setFile] = useState<File | null>(null);
  const [arxivUrl, setArxivUrl] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);
  const [conference, setConference] = useState<Conference>("iclr");

  const onDrop = useCallback((accepted: File[], rejected: FileRejection[]) => {
    setError(null);
    const r = rejected[0];
    if (r) {
      if (r.errors.some((e) => e.code === "file-too-large")) {
        setError("File exceeds 10 MB.");
      } else {
        setError("Only PDFs are accepted.");
      }
      return;
    }
    if (accepted[0]) setFile(accepted[0]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    maxSize: MAX_SIZE,
    multiple: false,
  });

  const mutation = useMutation({
    mutationFn: () =>
      source === "pdf"
        ? studyUploadPdf(code, file!, title || undefined, conference)
        : studyUploadArxiv(code, arxivUrl.trim(), title || undefined, conference),
    onSuccess: onDone,
  });

  const submitting = mutation.isPending;
  const arxivLooksValid = ARXIV_HINT_RE.test(arxivUrl.trim());
  const canSubmit =
    !submitting && consented && (source === "pdf" ? !!file : arxivLooksValid);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Progress state={state} paperIndex={paperIndex} />
        <div className="eyebrow mb-3">Submit a manuscript</div>
        <h1 className="text-3xl font-semibold tracking-[-0.01em]">
          Upload paper {paperIndex}
        </h1>
        <p className="text-graphite mt-1">
          Six systems will each review this paper in the venue format you pick.
          You will then judge three anonymous head-to-head comparisons.
        </p>
      </div>

      {failedMessage && <p className="text-sm text-red">{failedMessage}</p>}

      {/* Review format — every generated review for this paper follows the
          selected venue's form and rating scale (all six share the scale). */}
      <div>
        <div className="text-sm font-medium">Review format</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <StyledDropdown
            value={conference}
            onChange={setConference}
            options={CONFERENCE_OPTIONS}
            ariaLabel="Review format"
            idPrefix="study-conf"
          />
          <span className="font-mono text-xs text-graphite">
            All six reviews follow this venue&rsquo;s form and rating scale.
          </span>
        </div>
      </div>

      <StyledDropdown
        value={source}
        onChange={setSource}
        options={SOURCE_OPTIONS}
        ariaLabel="Source"
        idPrefix="study-source"
      />

      <div className="border-y border-rule py-6">
        <div className="space-y-4">
          {source === "pdf" ? (
            <div
              {...getRootProps()}
              className={cn(
                "flex flex-col items-center justify-center border border-dashed border-rule2 p-12 text-center cursor-pointer transition-colors",
                isDragActive && "border-red bg-paper2",
                file && "border-red/50 bg-paper2/60",
              )}
            >
              <input {...getInputProps()} />
              {file ? (
                <div className="flex items-center gap-3 text-sm">
                  <FileText className="h-8 w-8 text-graphite" />
                  <div className="text-left">
                    <div className="font-medium">{file.name}</div>
                    <div className="font-mono text-xs text-graphite">
                      {(file.size / 1024 / 1024).toFixed(2)} MB · click to replace
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-graphite">
                  <UploadCloud className="h-10 w-10" />
                  <div className="font-mono text-xs tracking-[0.02em]">
                    {isDragActive ? "Release to upload" : "Drag a PDF here, or click to browse"}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="study-arxiv">
                arXiv URL or ID
              </label>
              <input
                id="study-arxiv"
                value={arxivUrl}
                onChange={(e) => setArxivUrl(e.target.value)}
                placeholder="2312.00752  or  https://arxiv.org/abs/2312.00752"
                className="w-full border border-rule2 bg-paper px-3 py-2 font-mono text-sm"
              />
              <p className="font-mono text-xs text-graphite">
                Parsed via arxiv2md.org — works for arXiv papers with HTML
                rendering.
              </p>
            </div>
          )}
          {error && <p className="text-sm text-red">{error}</p>}
          <div>
            <label className="text-sm font-medium" htmlFor="study-title">
              Title <span className="text-graphite">(optional)</span>
            </label>
            <input
              id="study-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                source === "pdf"
                  ? "Falls back to the title extracted from the PDF."
                  : "Falls back to the title from arXiv."
              }
              className="mt-1 w-full border border-rule2 bg-paper px-3 py-2 text-sm"
            />
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 border-t border-rule pt-4">
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              className="mt-[3px] h-4 w-4 shrink-0 cursor-pointer accent-[#9d2b22]"
              aria-describedby="study-consent-hint"
            />
            <span id="study-consent-hint" className="text-[13px] leading-relaxed text-graphite">
              I understand that this paper will be processed by{" "}
              <span className="text-ink">commercial AI model APIs</span> and
              parsed via the Datalab Chandra API, as described in the study's
              data-processing notice.
            </span>
          </label>
        </div>
      </div>

      {mutation.isError && (
        <p className="text-sm text-red">{(mutation.error as Error).message}</p>
      )}

      <div className="flex items-center gap-4 py-3">
        {submitting ? (
          <div className="flex flex-1 items-center gap-2 font-mono text-xs text-graphite">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            <span>Uploading…</span>
          </div>
        ) : (
          <div className="flex-1 font-mono text-xs text-graphite">
            {source === "pdf" && !file
              ? "Select a PDF to continue."
              : source === "arxiv" && !arxivLooksValid
              ? "Paste an arXiv URL or ID to continue."
              : !consented
              ? "Accept the data-processing notice to continue."
              : `Ready: ${source === "pdf" ? file!.name : arxivUrl.trim()}`}
          </div>
        )}
        <Button
          onClick={() => mutation.mutate()}
          disabled={!canSubmit}
          size="lg"
          className="shrink-0"
        >
          {submitting ? "Working…" : "Upload and generate reviews"}
        </Button>
      </div>
    </div>
  );
}

function GeneratingScreen({ code, paper }: { code: string; paper: StudyPaperState }) {
  const total = paper.reviewsTotal ?? 6;
  const done = paper.reviewsCompleted ?? 0;
  const failed = paper.reviewsFailed ?? 0;
  const retry = useMutation({ mutationFn: () => studyRetry(code, paper.paperId!) });
  return (
    <div className="mx-auto max-w-xl pt-10 text-center">
      <h1 className="mb-3 font-serif text-2xl font-semibold">
        Reviews are being written…
      </h1>
      <p className="mb-6 text-sm text-ink2">
        Six systems are reading your paper. This usually takes a minute or two.
      </p>
      <div className="mx-auto mb-3 h-2 w-64 overflow-hidden rounded bg-rule2">
        <div
          className="h-full bg-ink transition-all"
          style={{ width: `${Math.round((done / total) * 100)}%` }}
        />
      </div>
      <p className="font-mono text-xs text-graphite">
        {done} of {total} reviews finished
      </p>
      {failed > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-sm text-red">
            {failed} review{failed > 1 ? "s" : ""} failed to generate.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
          >
            {retry.isPending ? "Retrying…" : "Retry failed reviews"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ComparisonScreen({
  code,
  comparisonId,
  pairIndex,
  paperIndex,
  state,
  onVoted,
}: {
  code: string;
  comparisonId: string;
  pairIndex: number;
  paperIndex: number;
  state: StudyState;
  onVoted: () => void;
}) {
  const startedAt = useRef(Date.now());
  const [note, setNote] = useState("");
  // Per-dimension picks, identical to the arena's ComparisonPage:
  // -1 = A better, 0 = tie, +1 = B better. All eight are REQUIRED.
  const [dimensionValues, setDimensionValues] = useState<
    Partial<Record<VoteDimension, -1 | 0 | 1>>
  >({});
  const [dimensionNotes, setDimensionNotes] = useState<Partial<Record<VoteDimension, string>>>({});
  const refinedCount = Object.keys(dimensionValues).length;
  const allDimensionsPicked = refinedCount === VOTE_DIMENSIONS.length;

  // Highlighter: a reading aid, never submitted. Kept per panel so the same
  // block index in A and B can't collide.
  const [highlighter, setHighlighter] = useState<VoteDimension | null>(null);
  const [marksA, setMarksA] = useState<Highlight[]>([]);
  const [marksB, setMarksB] = useState<Highlight[]>([]);

  // Each comparison is a fresh survey — clear picks when the pair changes,
  // otherwise comparison 2 inherits comparison 1's answers.
  useEffect(() => {
    setDimensionValues({});
    setDimensionNotes({});
    setNote("");
    setMarksA([]);
    setMarksB([]);
    setHighlighter(null);
    startedAt.current = Date.now();
  }, [comparisonId]);

  const pairQuery = useQuery({
    queryKey: ["study-pair", comparisonId],
    queryFn: () => studyPairFetch(code, comparisonId),
    staleTime: Infinity,
  });
  const vote = useMutation({
    mutationFn: (winner: "A" | "B" | "TIE") =>
      studyVote({
        code,
        comparisonId,
        winner,
        note: note.trim() || undefined,
        decisionMs: Date.now() - startedAt.current,
        dimensions: VOTE_DIMENSIONS.map((d) => ({
          dimension: d,
          value: dimensionValues[d] as -1 | 0 | 1,
          note: dimensionNotes[d]?.trim() || undefined,
        })),
      }),
    onSuccess: onVoted,
  });

  const pair = pairQuery.data;
  if (pairQuery.isLoading || !pair) {
    return (
      <p className="flex items-center gap-2 font-mono text-sm text-graphite">
        <Loader2 className="h-4 w-4 animate-spin" /> loading comparison…
      </p>
    );
  }

  return (
    <div>
      <Progress state={state} paperIndex={paperIndex} />
      <h1 className="mb-1 font-serif text-xl font-semibold">
        Comparison {pairIndex} of {state.pairsPerPaper}
        {pair.paperTitle ? ` — ${pair.paperTitle}` : ""}
      </h1>
      <p className="mb-5 text-sm text-ink2">
        Read both reviews, then pick the one that would help the paper's
        authors more. The systems stay anonymous until you finish this paper.
      </p>

      <HighlightToolbar
        className="mb-3"
        active={highlighter}
        onChange={setHighlighter}
        highlights={[...marksA, ...marksB]}
        onClear={() => {
          setMarksA([]);
          setMarksB([]);
        }}
      />

      <div className="mb-6 grid grid-cols-1 divide-y divide-rule2 border border-rule2 bg-white md:grid-cols-2 md:divide-x md:divide-y-0">
        <ReviewPanel
          label="REVIEW A"
          review={pair.reviewA.structured ?? EMPTY_REVIEW}
          raw={pair.reviewA.rawOutput}
          conference={pair.conference}
          highlights={marksA}
          highlighterArmed={highlighter !== null}
          onSelectRanges={(r) =>
            highlighter && setMarksA((prev) => addHighlights(prev, r, highlighter))
          }
          onRemoveHighlight={(id) => setMarksA((prev) => prev.filter((h) => h.id !== id))}
        />
        <ReviewPanel
          label="REVIEW B"
          review={pair.reviewB.structured ?? EMPTY_REVIEW}
          raw={pair.reviewB.rawOutput}
          conference={pair.conference}
          highlights={marksB}
          highlighterArmed={highlighter !== null}
          onSelectRanges={(r) =>
            highlighter && setMarksB((prev) => addHighlights(prev, r, highlighter))
          }
          onRemoveHighlight={(id) => setMarksB((prev) => prev.filter((h) => h.id !== id))}
        />
      </div>

      {/* Per-dimension picks — the same eight axes, wording and widget the
          arena uses, so study and arena votes are directly comparable. */}
      <div className="mb-6 border border-rule2 bg-card">
        <div className="flex items-center justify-between gap-3 bg-paper2 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
              Rate every dimension
            </span>
            <span className="font-mono text-[11px] text-red">required</span>
          </div>
          <DimensionProgress count={refinedCount} total={VOTE_DIMENSIONS.length} />
        </div>
        <div className="border-t border-rule px-4 py-4">
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
            {VOTE_DIMENSIONS.map((d) => (
              <DimensionRow
                key={d}
                label={DIMENSION_LABELS[d]}
                question={DIMENSION_DESCRIPTIONS[d]}
                value={dimensionValues[d]}
                note={dimensionNotes[d] ?? ""}
                onPick={(next) =>
                  setDimensionValues((prev) => {
                    const copy = { ...prev };
                    // Click the selected side again to deselect.
                    if (copy[d] === next) delete copy[d];
                    else copy[d] = next;
                    return copy;
                  })
                }
                onChangeNote={(text) =>
                  setDimensionNotes((prev) => ({ ...prev, [d]: text }))
                }
              />
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-xl text-center">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.1em] text-graphite">
          Which review is better overall?
        </p>
        <div className="mb-4 flex justify-center gap-3">
          <Button
            onClick={() => vote.mutate("A")}
            disabled={vote.isPending || !allDimensionsPicked}
          >
            A is better
          </Button>
          <Button
            variant="outline"
            onClick={() => vote.mutate("TIE")}
            disabled={vote.isPending || !allDimensionsPicked}
          >
            Tie
          </Button>
          <Button
            onClick={() => vote.mutate("B")}
            disabled={vote.isPending || !allDimensionsPicked}
          >
            B is better
          </Button>
        </div>
        {!allDimensionsPicked && (
          <p className="mb-3 font-mono text-xs text-graphite">
            Rate all {VOTE_DIMENSIONS.length} dimensions above to submit —{" "}
            {VOTE_DIMENSIONS.length - refinedCount} left.
          </p>
        )}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why? (optional, but very helpful for the study)"
          rows={2}
          className="w-full border border-rule bg-white px-3 py-2 text-sm"
        />
        {vote.error && (
          <p className="mt-2 text-sm text-red">{(vote.error as Error).message}</p>
        )}
      </div>
    </div>
  );
}

const EMPTY_REVIEW = { summary: "", strengths: [], weaknesses: [], questions: [] };

function RevealScreen({
  code,
  paperId,
  paperIndex,
  state,
  acknowledged,
  onContinue,
}: {
  code: string;
  paperId: string;
  paperIndex: number;
  state: StudyState;
  acknowledged: boolean;
  onContinue?: () => void;
}) {
  const revealQuery = useQuery({
    queryKey: ["study-reveal", paperId],
    queryFn: () => studyReveal(code, paperId),
    staleTime: Infinity,
  });
  const isFinal = paperIndex === state.papersPerParticipant;
  const remaining = state.papersPerParticipant * state.pairsPerPaper - state.totalVotes;

  return (
    <div className="mx-auto max-w-xl pt-6 text-center">
      {!acknowledged && (
        <div className="mb-6">
          <div className="mb-2 text-4xl" aria-hidden>
            🎉
          </div>
          <h1 className="mb-2 font-serif text-2xl font-semibold">
            {isFinal
              ? "That's all six judgements — thank you!"
              : `Paper ${paperIndex} complete!`}
          </h1>
          <p className="text-sm text-ink2">
            {isFinal
              ? "Your comparisons are recorded. You're done — the systems you just judged are revealed below."
              : `Great judging. ${remaining} more judgement${remaining === 1 ? "" : "s"} to go — but first, here's who wrote what.`}
          </p>
        </div>
      )}

      <div className="mb-6 border border-rule2 bg-white p-4 text-left">
        <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
          Paper {paperIndex} — who you compared
        </p>
        {revealQuery.data ? (
          <ul className="space-y-2 text-sm">
            {revealQuery.data.comparisons.map((c) => (
              <li key={c.pairIndex} className="flex items-baseline justify-between gap-3">
                <span>
                  {c.systemA.name} <span className="text-graphite">vs</span> {c.systemB.name}
                </span>
                <span className="font-mono text-xs text-graphite">
                  {c.winner === "TIE"
                    ? "you called it a tie"
                    : `you preferred ${c.winner === "A" ? c.systemA.name : c.systemB.name}`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="font-mono text-xs text-graphite">loading…</p>
        )}
      </div>

      {onContinue && (
        <Button onClick={onContinue}>Continue to paper {paperIndex + 1} →</Button>
      )}
      {/* The leaderboard is unlocked ONLY here, after the final vote is
          already recorded. Showing it mid-study would let a participant on
          paper 2 see which system is ahead and vote to match it — the
          votes would stop being independent. */}
      {isFinal && (
        <div className="mt-2">
          <Link to="/leaderboard">
            <Button variant="outline">See the leaderboard →</Button>
          </Link>
          <p className="mt-4 font-mono text-xs text-graphite">
            You can close this window now.
          </p>
        </div>
      )}
    </div>
  );
}

function RevealScreenDoneFallback() {
  return (
    <div className="mx-auto max-w-md pt-16 text-center">
      <h1 className="mb-2 font-serif text-2xl font-semibold">All done 🎉</h1>
      <p className="text-sm text-ink2">Thank you for participating.</p>
    </div>
  );
}
