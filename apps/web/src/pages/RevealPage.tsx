import { useMemo } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  VOTE_DIMENSIONS,
  DIMENSION_LABELS,
  type SubmitVoteResponse,
  type RevealSide,
  type JudgeVerdict,
} from "@reviewarena/shared-types";
import { getReveal } from "@/lib/api";

type RevealHeader = SubmitVoteResponse["reveal"];

const PLACEHOLDER_HEADER: RevealHeader = {
  winner: "A",
  reviewA: {
    reviewId: "rev-a",
    systemSlug: "gpt-5-mini",
    systemName: "GPT-5-mini",
    btBefore: 1094.2,
    btAfter: 1101.7,
  },
  reviewB: {
    reviewId: "rev-b",
    systemSlug: "gemini-2.5-flash",
    systemName: "Gemini 2.5 Flash",
    btBefore: 1071.5,
    btAfter: 1064.3,
  },
};

const ERROR_HEADER: RevealHeader = {
  winner: "TIE",
  reviewA: {
    reviewId: "",
    systemSlug: "error",
    systemName: "Error",
    btBefore: null,
    btAfter: null,
  },
  reviewB: {
    reviewId: "",
    systemSlug: "error",
    systemName: "Error",
    btBefore: null,
    btAfter: null,
  },
};

export function RevealPage() {
  const [params] = useSearchParams();
  const voteId = params.get("voteId");
  // Set by ComparisonPage on submit. Lets us link back to the comparison
  // the user just voted on — /compare bounces to /upload without it, so
  // the button is only rendered when we actually have the id (e.g. a
  // reveal link opened cold won't show it).
  const paperId = params.get("paperId");

  const header = useMemo<RevealHeader>(() => {
    const raw = params.get("state");
    if (!raw) {
      // Only show placeholder in dev; in prod this is an error (no state param).
      if (import.meta.env.DEV) return PLACEHOLDER_HEADER;
      return ERROR_HEADER;
    }
    try {
      return JSON.parse(decodeURIComponent(raw)) as RevealHeader;
    } catch {
      if (import.meta.env.DEV) return PLACEHOLDER_HEADER;
      return ERROR_HEADER;
    }
  }, [params]);

  // Judge-panel output is fetched by voteId. The panel may still be running
  // when the user lands here, so poll until judgeStatus settles. Only
  // study pairs are judged: an arena vote comes back PENDING with no
  // scores, which is final — never poll for a judge that will not come.
  // Cap at ~10 min of polling in case the panel is slow or wedged.
  const revealQuery = useQuery({
    queryKey: ["reveal", voteId],
    queryFn: () => getReveal(voteId!),
    enabled: !!voteId,
    refetchInterval: (q) => {
      // Count errors toward the cap too: with a dead API, dataUpdateCount
      // never advances and 100 tabs would otherwise poll forever — a retry
      // storm aimed at a server that's trying to come back.
      if (q.state.dataUpdateCount + q.state.errorUpdateCount > 120) return false;
      const d = q.state.data;
      if (!d) return 5000;
      return d.judgeStatus === "RUNNING" ? 5000 : false;
    },
    retry: 1,
  });

  const usingPlaceholder = !params.get("state");
  const detail = revealQuery.data;
  // The judge section is withheld unless there is something real to show.
  //
  // PENDING covers every "no judges" case: judging switched off, or an
  // empty judge selection in admin settings, or an arena pair the panel
  // never claimed. Those pairs are simply never judged, so rather than
  // render a panel explaining its own absence — or worse, a radar of
  // zeros — the section does not appear at all. It also cannot flash in
  // during load.
  //
  // COMPLETE with no verdict is possible for rows predating judge-status
  // tracking (the column defaulted to COMPLETE), and is treated the same
  // way. RUNNING and FAILED still render, because "in progress" and
  // "unavailable" are things the voter should be told.
  const judged =
    !!detail &&
    detail.judgeStatus !== "PENDING" &&
    (!!detail.judgeVerdict ||
      detail.judgeStatus === "RUNNING" ||
      detail.judgeStatus === "FAILED");
  const scoringPending = judged && detail.judgeStatus === "RUNNING";
  const panelSize = detail?.judgeVerdict?.judgesExpected ?? 0;
  // Guard: in prod, require state param (no mocking system IDs)
  const hasMissingState = !header.reviewA.reviewId && !import.meta.env.DEV;
  if (hasMissingState) {
    return (
      <div className="container py-8">
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Error: no vote state</CardTitle>
            <CardDescription>This page requires a valid &lt;state&gt; query parameter.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  // Only chart dimensions the panel actually scored. Defaulting a missing
  // score to 0 would draw a collapsed shape that reads as "both reviews
  // scored zero" rather than "not scored".
  const hasDimensionScores =
    !!detail?.reviewA.judgeDimensions || !!detail?.reviewB.judgeDimensions;

  // The API echoes the verdict back, so the headline never has to be
  // inferred from rating movement (which can be null for an unplaced system).
  const winnerLabel =
    header.winner === "TIE"
      ? "Tie"
      : header.winner === "A"
        ? `${header.reviewA.systemName} (A)`
        : `${header.reviewB.systemName} (B)`;

  return (
    <div className="container py-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="eyebrow">Vote recorded · you preferred</div>
          <h1 className="text-3xl font-semibold tracking-[-0.01em] mt-2">{winnerLabel}</h1>
          <p className="text-graphite mt-2">
            {judged
              ? "Systems revealed below, along with how the LLM judge panel sees the same reviews."
              : "Systems revealed below."}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {usingPlaceholder && <Badge variant="outline">placeholder</Badge>}
          <Button asChild>
            <Link to="/compare">Next comparison →</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <RevealCard slot="A" reveal={header.reviewA} detail={detail?.reviewA} />
        <RevealCard slot="B" reveal={header.reviewB} detail={detail?.reviewB} />
      </div>

      <p className="font-mono text-[11px] text-graphite">
        Ratings are Bradley-Terry: every comparison in the log is refit before
        and after your vote, on the same 1000-point scale the{" "}
        <Link to="/leaderboard" className="underline underline-offset-2">
          standings
        </Link>{" "}
        rank by, where 400 points is ten-to-one odds.
      </p>

      {judged && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Judge-panel dimension scores</CardTitle>
          <CardDescription>
            {detail.judgeStatus === "FAILED" ? (
              <span>
                Judge scores are unavailable — your vote is saved and counted;
                check the leaderboard later.
              </span>
            ) : scoringPending ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Judge panel in progress — updates automatically as judges finish.
              </span>
            ) : (
              `0–10 per dimension, mean across the ${detail.reviewA.judgeCount}-model judge panel. Higher is better.`
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasDimensionScores && (
            <DimensionScores
              a={detail.reviewA.judgeDimensions}
              b={detail.reviewB.judgeDimensions}
              nameA={header.reviewA.systemName}
              nameB={header.reviewB.systemName}
            />
          )}

          {detail.judgeVerdict && (
            <div className="mt-5 border-t border-dashed border-rule2 pt-4">
              <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
                Panel scores (same comparison you made)
              </div>
              <p className="mb-3 text-sm">
                {detail.judgeVerdict.overall === "TIE" ? (
                  <>
                    The panel is split overall ({detail.judgeVerdict.counts.A}–
                    {detail.judgeVerdict.counts.B}, {detail.judgeVerdict.counts.TIE} ties).
                  </>
                ) : (
                  <>
                    {detail.judgeVerdict.counts[detail.judgeVerdict.overall]} of{" "}
                    {detail.judgeVerdict.judgesReturned} judges preferred{" "}
                    <span className="font-medium">
                      {detail.judgeVerdict.overall === "A"
                        ? header.reviewA.systemName
                        : header.reviewB.systemName}
                    </span>{" "}
                    overall.
                  </>
                )}{" "}
                {detail.judgeVerdict.judgesReturned < panelSize && (
                  <span className="text-graphite">
                    ({detail.judgeVerdict.judgesReturned} of {panelSize} judges responded)
                  </span>
                )}
              </p>
              <JudgeScores
                judges={detail.judgeVerdict.judges}
                nameA={header.reviewA.systemName}
                nameB={header.reviewB.systemName}
                slugA={header.reviewA.systemSlug}
                slugB={header.reviewB.systemSlug}
              />
            </div>
          )}
        </CardContent>
      </Card>
      )}

      <div className="flex flex-wrap justify-between gap-3 pt-2">
        <div className="flex flex-wrap gap-3">
          {paperId && (
            <Button variant="outline" asChild>
              <Link to={`/compare?paperId=${encodeURIComponent(paperId)}`}>
                ← Back to the reviews
              </Link>
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link to="/leaderboard">Leaderboard</Link>
          </Button>
        </div>
        <Button asChild>
          <Link to="/compare">Next comparison →</Link>
        </Button>
      </div>
    </div>
  );
}

function RevealCard({
  slot,
  reveal,
  detail,
}: {
  slot: "A" | "B";
  reveal: RevealHeader["reviewA"];
  detail?: RevealSide;
}) {
  // Bradley-Terry has no incremental update, so these two numbers are the
  // board refit over every comparison before this vote and again after it —
  // already converted to the same 1000-point scale the standings use.
  // null means BT cannot place this system yet (see the leaderboard's
  // "not yet ranked" note).
  const btBefore = reveal.btBefore ?? null;
  const btAfter = reveal.btAfter ?? null;
  const btDelta = btBefore !== null && btAfter !== null ? btAfter - btBefore : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className=" bg-muted px-2 py-0.5 font-mono text-xs uppercase">
              {slot}
            </span>
            <span>{reveal.systemName}</span>
          </div>
          <Badge variant="secondary">{reveal.systemSlug}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          {/* Bradley-Terry leads: it is the board the standings rank by. */}
          {btAfter !== null && btDelta !== null ? (
            <div className="flex items-baseline gap-3">
              <div className="font-mono text-3xl">{Math.round(btAfter)}</div>
              <div className={`font-mono text-sm ${btDelta >= 0 ? "text-up" : "text-red"}`}>
                {btDelta >= 0 ? "+" : ""}
                {btDelta.toFixed(1)} BT
              </div>
              <div className="ml-auto font-mono text-xs text-muted-foreground">
                was {Math.round(btBefore!)}
              </div>
            </div>
          ) : (
            <div className="flex items-baseline gap-3">
              <div className="font-mono text-3xl text-muted-foreground">—</div>
              <div className="font-mono text-xs text-muted-foreground">
                not on the Bradley-Terry board yet
              </div>
            </div>
          )}
        </div>

        {detail?.judgeOverall != null && (
          <div className="border-t border-dashed border-rule2 px-1 pt-3 text-sm">
            <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-graphite">
              Judge overall (panel mean, n={detail.judgeCount})
            </div>
            <div className="font-mono">{detail.judgeOverall.toFixed(1)} / 10</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Per-judge scores ───────────────────────────────────────────────────────
//
// Six systems play two roles here: a system AUTHORS a review and also JUDGES
// the pair. A grouped bar chart made that unreadable — the same name appeared
// as a row (judge) and as a series (author) with nothing distinguishing them.
//
// This is a table instead: rows are judges, the two columns are the two
// reviews. The "own" mark then lands on the single CELL where the judge is
// scoring its own work, which is exactly what self-judging means and is far
// clearer than flagging the whole row.
//
// Scores are each judge's 0-10 rating, not a preference. A judge can score
// both reviews highly and still prefer one; the preference lives in the
// pairwise verdict, not in the gap between these two numbers.

function ScoreBar({
  value,
  own,
  tone,
  lead = false,
}: {
  value: number | null;
  own: boolean;
  tone: "a" | "b";
  /** This side scored higher on this row — marked so the comparison does
   *  not depend on eyeballing two bar lengths that differ by a few pixels. */
  lead?: boolean;
}) {
  if (value === null) {
    return <span className="text-graphite/60">not scored</span>;
  }
  const pct = Math.max(0, Math.min(100, (value / 10) * 100));
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-[9px] w-full min-w-[70px] border border-rule bg-paper2">
        <div
          className={`absolute bottom-0 left-0 top-0 ${tone === "a" ? "bg-ink" : "bg-graphite"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={`w-9 shrink-0 text-right tabular-nums ${lead ? "font-medium text-ink" : "text-graphite"}`}
      >
        {value.toFixed(1)}
      </span>
      {lead && (
        <span className="shrink-0 text-[10px] text-ink" title="Higher score on this dimension">
          ▲
        </span>
      )}
      {own && (
        <span
          className="shrink-0 rounded-sm border border-rule px-1 text-[9.5px] uppercase tracking-[0.08em] text-graphite"
          title="This judge wrote the review it is scoring here"
        >
          own
        </span>
      )}
    </div>
  );
}

function JudgeScores({
  judges,
  nameA,
  nameB,
  slugA,
  slugB,
}: {
  judges: JudgeVerdict["judges"];
  nameA: string;
  nameB: string;
  slugA: string;
  slugB: string;
}) {
  const rows = judges.filter((j) => j.scoreA !== null || j.scoreB !== null);
  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-graphite">
            <th className="border-b border-rule2 pb-2 pr-4 text-left font-medium">Judge</th>
            <th className="w-[34%] border-b border-rule2 px-3 pb-2 text-left font-medium">
              <span className="mr-1.5 inline-block h-2 w-2 bg-ink align-middle" />
              review by {nameA}
            </th>
            <th className="w-[34%] border-b border-rule2 px-3 pb-2 text-left font-medium">
              <span className="mr-1.5 inline-block h-2 w-2 bg-graphite align-middle" />
              review by {nameB}
            </th>
          </tr>
        </thead>
        <tbody className="font-mono text-[11.5px]">
          {rows.map((j) => (
            <tr key={j.judge}>
              <td className="whitespace-nowrap border-b border-rule py-2.5 pr-4 text-ink2">
                {j.judgeName}
                {j.passesUsed < 2 && (
                  <span
                    className="ml-1.5 text-graphite"
                    title="Only one display order returned, so the order-swap check is unavailable for this judge"
                  >
                    ·1 pass
                  </span>
                )}
              </td>
              <td className="border-b border-rule px-3 py-2.5">
                <ScoreBar value={j.scoreA} own={j.judge === slugA} tone="a" />
              </td>
              <td className="border-b border-rule px-3 py-2.5">
                <ScoreBar value={j.scoreB} own={j.judge === slugB} tone="b" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2.5 max-w-prose text-[11px] leading-relaxed text-graphite">
        Each judge scores both reviews out of 10.{" "}
        <span className="uppercase tracking-[0.08em]">own</span> marks the cell
        where a judge is scoring its own review — every system both writes
        reviews and sits on the panel, so two of the judges always meet their
        own work. A score is not a preference: a judge can rate both reviews
        highly and still prefer one.
      </p>
    </div>
  );
}

// ─── Per-dimension panel scores ─────────────────────────────────────────────
//
// This was a radar chart. Two overlaid translucent polygons in a two-tone
// palette are unreadable when the systems score similarly — which is the
// common case — and a reader cannot tell which shape is which review. The
// same numbers as a table answer the actual question ("which review scored
// better on this dimension, and by how much") directly.

function DimensionScores({
  a,
  b,
  nameA,
  nameB,
}: {
  a: Record<string, number> | null;
  b: Record<string, number> | null;
  nameA: string;
  nameB: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-graphite">
            <th className="border-b border-rule2 pb-2 pr-4 text-left font-medium">Dimension</th>
            <th className="w-[32%] border-b border-rule2 px-3 pb-2 text-left font-medium">
              <span className="mr-1.5 inline-block h-2 w-2 bg-ink align-middle" />
              review by {nameA}
            </th>
            <th className="w-[32%] border-b border-rule2 px-3 pb-2 text-left font-medium">
              <span className="mr-1.5 inline-block h-2 w-2 bg-graphite align-middle" />
              review by {nameB}
            </th>
          </tr>
        </thead>
        <tbody className="font-mono text-[11.5px]">
          {VOTE_DIMENSIONS.map((d) => {
            const va = a?.[d] ?? null;
            const vb = b?.[d] ?? null;
            return (
              <tr key={d}>
                <td className="border-b border-rule py-2.5 pr-4 text-ink2">
                  {DIMENSION_LABELS[d]}
                </td>
                <td className="border-b border-rule px-3 py-2.5">
                  <ScoreBar value={va} own={false} tone="a" lead={va !== null && vb !== null && va > vb} />
                </td>
                <td className="border-b border-rule px-3 py-2.5">
                  <ScoreBar value={vb} own={false} tone="b" lead={va !== null && vb !== null && vb > va} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2.5 max-w-prose text-[11px] leading-relaxed text-graphite">
        Mean score out of 10 across the judges that returned, per dimension.
        The higher of the two is marked. These are the panel's scores, not
        yours.
      </p>
    </div>
  );
}
