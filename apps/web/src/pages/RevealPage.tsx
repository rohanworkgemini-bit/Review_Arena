import { useMemo } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
} from "recharts";
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
} from "@reviewarena/shared-types";
import { getReveal } from "@/lib/api";

type RevealHeader = SubmitVoteResponse["reveal"];

const PLACEHOLDER_HEADER: RevealHeader = {
  reviewA: {
    reviewId: "rev-a",
    systemSlug: "gpt-5-mini",
    systemName: "GPT-5-mini",
    eloBefore: 1100,
    eloAfter: 1112,
    btBefore: 1094.2,
    btAfter: 1101.7,
  },
  reviewB: {
    reviewId: "rev-b",
    systemSlug: "gemini-2.5-flash",
    systemName: "Gemini 2.5 Flash",
    eloBefore: 1080,
    eloAfter: 1068,
    btBefore: 1071.5,
    btAfter: 1064.3,
  },
};

const ERROR_HEADER: RevealHeader = {
  reviewA: {
    reviewId: "",
    systemSlug: "error",
    systemName: "Error",
    eloBefore: 0,
    eloAfter: 0,
    btBefore: null,
    btAfter: null,
  },
  reviewB: {
    reviewId: "",
    systemSlug: "error",
    systemName: "Error",
    eloBefore: 0,
    eloAfter: 0,
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
  const scoringPending = !!voteId && (!detail || detail.judgeStatus === "RUNNING");
  const notJudged = !!detail && detail.judgeStatus === "PENDING";
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

  const radarData = VOTE_DIMENSIONS.map((d) => ({
    dimension: DIMENSION_LABELS[d],
    A: detail?.reviewA.judgeDimensions?.[d] ?? 0,
    B: detail?.reviewB.judgeDimensions?.[d] ?? 0,
  }));

  const aDelta = header.reviewA.eloAfter - header.reviewA.eloBefore;
  const winnerLabel =
    Math.abs(aDelta) < 0.01
      ? "Tie"
      : aDelta > 0
      ? `${header.reviewA.systemName} (A)`
      : `${header.reviewB.systemName} (B)`;

  return (
    <div className="container py-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="eyebrow">Vote recorded · you preferred</div>
          <h1 className="text-3xl font-semibold tracking-[-0.01em] mt-2">{winnerLabel}</h1>
          <p className="text-graphite mt-2">
            Systems revealed below, along with how the LLM judge panel sees the
            same reviews.
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
        Bradley-Terry (large) refits every comparison in the log and is what the{" "}
        <Link to="/leaderboard" className="underline underline-offset-2">
          standings
        </Link>{" "}
        rank by; Elo (small) is the running per-vote update. Both sit on the same
        1000-point scale, where 400 points is ten-to-one odds.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Judge-panel dimension scores</CardTitle>
          <CardDescription>
            {revealQuery.isError || detail?.judgeStatus === "FAILED" ? (
              <span>
                Judge scores are unavailable — your vote is saved and counted;
                check the leaderboard later.
              </span>
            ) : notJudged ? (
              <span>
                This comparison was not scored by the judge panel (judging runs
                for study papers only). Your vote is saved and counted.
              </span>
            ) : scoringPending ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Judge panel in progress — updates automatically as judges finish.
              </span>
            ) : (
              `0–10 per dimension, mean across the ${detail?.reviewA.judgeCount ?? 0}-model judge panel. Higher is better.`
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[420px] font-mono text-xs">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={radarData}>
                <PolarGrid stroke="#ddd8cc" />
                <PolarAngleAxis dataKey="dimension" tick={{ fill: "#6d685f", fontSize: 11 }} />
                <PolarRadiusAxis angle={30} domain={[0, 10]} tick={{ fill: "#6d685f", fontSize: 10 }} />
                {/* Token palette only. A = ink, B = graphite — using the
                    red for either side would mis-signal "worse" before
                    the user has read anything. */}
                <Radar
                  name="Review A"
                  dataKey="A"
                  stroke="#191815"
                  fill="#191815"
                  fillOpacity={0.22}
                />
                <Radar
                  name="Review B"
                  dataKey="B"
                  stroke="#6d685f"
                  fill="#6d685f"
                  fillOpacity={0.18}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 flex gap-5 font-mono text-[11px] text-graphite">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 bg-ink" /> Review A
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 bg-graphite" /> Review B
            </span>
          </div>

          {detail?.judgeVerdict && (
            <div className="mt-5 border-t border-dashed border-rule2 pt-4">
              <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
                Panel verdict (same A/B comparison you made)
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
                      Review {detail.judgeVerdict.overall}
                      {" — "}
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
              <ul className="mb-4 space-y-0.5 font-mono text-[11px]">
                {detail.judgeVerdict.judges.map((j) => (
                  <li key={j.judge} className="flex items-baseline gap-2">
                    <span className="w-44 truncate text-graphite">{j.judgeName}</span>
                    <span className={j.overall === "TIE" ? "text-graphite" : "font-medium"}>
                      {j.overall === "TIE" ? "tie" : `Review ${j.overall}`}
                    </span>
                    {j.selfJudging && (
                      <span className="text-graphite" title="This judge wrote one of the two reviews">
                        · judged own review
                      </span>
                    )}
                    {j.passesUsed < 2 && (
                      <span className="text-graphite" title="Order-swap check unavailable">
                        · single pass
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px] sm:grid-cols-4">
                {VOTE_DIMENSIONS.map((d) => {
                  const p = detail.judgeVerdict!.dimensions[d];
                  return (
                    <span key={d} className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-graphite">{DIMENSION_LABELS[d]}</span>
                      <span className={p === "TIE" ? "text-graphite" : "font-medium"}>
                        {p === "TIE" ? "=" : p}
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

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
  const delta = reveal.eloAfter - reveal.eloBefore;
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
          <div className="flex items-baseline gap-3">
            <div className="font-mono text-base text-muted-foreground">
              {Math.round(reveal.eloAfter)}
            </div>
            <div
              className={`font-mono text-xs ${
                delta >= 0 ? "text-up" : "text-red"
              }`}
            >
              {delta >= 0 ? "+" : ""}
              {delta.toFixed(1)} Elo
            </div>
            <div className="ml-auto font-mono text-xs text-muted-foreground">
              was {Math.round(reveal.eloBefore)}
            </div>
          </div>
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
