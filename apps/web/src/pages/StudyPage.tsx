import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReviewPanel } from "@/components/comparison/ReviewPanel";
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
 * shell, no leaderboard link: participants must not see live standings.
 *
 * Screens, driven entirely by GET /study/state:
 *   code entry → upload paper N → "reviews generating" progress →
 *   3 blind comparisons (single-axis vote) → per-paper celebration +
 *   identity reveal → next paper → final thank-you.
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
  const [tab, setTab] = useState<"pdf" | "arxiv">("pdf");
  const [file, setFile] = useState<File | null>(null);
  const [arxivUrl, setArxivUrl] = useState("");
  const [title, setTitle] = useState("");
  const mutation = useMutation({
    mutationFn: async () => {
      if (tab === "pdf") {
        if (!file) throw new Error("Choose a PDF first.");
        return studyUploadPdf(code, file, title || undefined);
      }
      if (!arxivUrl.trim()) throw new Error("Paste an arXiv link first.");
      return studyUploadArxiv(code, arxivUrl.trim(), title || undefined);
    },
    onSuccess: onDone,
  });

  return (
    <div className="mx-auto max-w-xl">
      <Progress state={state} paperIndex={paperIndex} />
      <h1 className="mb-2 font-serif text-2xl font-semibold">
        Upload paper {paperIndex}
      </h1>
      <p className="mb-5 text-sm text-ink2">
        Six systems will each write a review of this paper. You will then judge
        three anonymous head-to-head comparisons.
      </p>
      {failedMessage && <p className="mb-4 text-sm text-red">{failedMessage}</p>}

      <div className="mb-4 flex font-mono text-xs">
        {(["pdf", "arxiv"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`border border-rule px-3 py-1.5 ${tab === t ? "bg-ink text-paper" : "text-graphite"}`}
          >
            {t === "pdf" ? "PDF file" : "arXiv link"}
          </button>
        ))}
      </div>

      {tab === "pdf" ? (
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="mb-3 block w-full text-sm"
        />
      ) : (
        <input
          value={arxivUrl}
          onChange={(e) => setArxivUrl(e.target.value)}
          placeholder="https://arxiv.org/abs/…"
          className="mb-3 w-full border border-rule bg-white px-3 py-2 font-mono text-sm"
        />
      )}
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional)"
        className="mb-4 w-full border border-rule bg-white px-3 py-2 text-sm"
      />
      <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        {mutation.isPending ? "Uploading…" : "Upload & generate reviews"}
      </Button>
      {mutation.error && (
        <p className="mt-3 text-sm text-red">{(mutation.error as Error).message}</p>
      )}
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

      <div className="mb-6 grid grid-cols-1 divide-y divide-rule2 border border-rule2 bg-white md:grid-cols-2 md:divide-x md:divide-y-0">
        <ReviewPanel
          label="REVIEW A"
          review={pair.reviewA.structured ?? EMPTY_REVIEW}
          raw={pair.reviewA.rawOutput}
        />
        <ReviewPanel
          label="REVIEW B"
          review={pair.reviewB.structured ?? EMPTY_REVIEW}
          raw={pair.reviewB.rawOutput}
        />
      </div>

      <div className="mx-auto max-w-xl text-center">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.1em] text-graphite">
          Which review is better overall?
        </p>
        <div className="mb-4 flex justify-center gap-3">
          <Button onClick={() => vote.mutate("A")} disabled={vote.isPending}>
            A is better
          </Button>
          <Button variant="outline" onClick={() => vote.mutate("TIE")} disabled={vote.isPending}>
            Tie
          </Button>
          <Button onClick={() => vote.mutate("B")} disabled={vote.isPending}>
            B is better
          </Button>
        </div>
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
      {isFinal && (
        <p className="font-mono text-xs text-graphite">
          You can close this window now.
        </p>
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
