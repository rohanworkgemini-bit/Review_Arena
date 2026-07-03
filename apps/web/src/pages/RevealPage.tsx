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
  },
  reviewB: {
    reviewId: "rev-b",
    systemSlug: "gemini-2.5-flash",
    systemName: "Gemini 2.5 Flash",
    eloBefore: 1080,
    eloAfter: 1068,
  },
};

const ERROR_HEADER: RevealHeader = {
  reviewA: {
    reviewId: "",
    systemSlug: "error",
    systemName: "Error",
    eloBefore: 0,
    eloAfter: 0,
  },
  reviewB: {
    reviewId: "",
    systemSlug: "error",
    systemName: "Error",
    eloBefore: 0,
    eloAfter: 0,
  },
};

export function RevealPage() {
  const [params] = useSearchParams();
  const voteId = params.get("voteId");

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

  // ClaimChecks + per-dimension judge scores are fetched by voteId. The
  // score job may still be running when the user lands here. Each side's
  // claims + judge scores commit in one transaction, but A and B are scored
  // independently — so keep polling until BOTH sides have judgeDimensions
  // (previously we stopped on first partial data, forcing a manual refresh).
  // Cap at ~3 min of polling in case the judge failed and scores never land.
  const revealQuery = useQuery({
    queryKey: ["reveal", voteId],
    queryFn: () => getReveal(voteId!),
    enabled: !!voteId,
    refetchInterval: (q) => {
      if (q.state.dataUpdateCount > 60) return false;
      const d = q.state.data;
      const done = !!d?.reviewA.judgeDimensions && !!d?.reviewB.judgeDimensions;
      return done ? false : 3000;
    },
    retry: 1,
  });

  const usingPlaceholder = !params.get("state");
  const detail = revealQuery.data;
  const scoringPending =
    !!voteId &&
    (!detail || !detail.reviewA.judgeDimensions || !detail.reviewB.judgeDimensions);
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
            Systems revealed below, along with how the LLM-as-judge sees the same
            reviews.
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">LLM-as-judge dimension scores</CardTitle>
          <CardDescription>
            {scoringPending ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Scoring in progress — updates automatically as the judge finishes.
              </span>
            ) : (
              "0–10 per dimension from the judge model. Higher is better."
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Paper-grounded verifiability</CardTitle>
          <CardDescription>
            Each claim each review makes, checked by an LLM-as-judge against the
            paper text.
          </CardDescription>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 font-mono text-xs text-muted-foreground">
            {(["SUPPORTED", "CONTRADICTED", "UNSUPPORTED"] as const).map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className={`border px-1 ${VERDICT_STYLES[k]}`}>
                  {VERDICT_SHORT[k]}
                </span>
                {VERDICT_LEGEND[k]}
              </span>
            ))}
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <ClaimList label="Review A" side={detail?.reviewA} pending={scoringPending} />
          <ClaimList label="Review B" side={detail?.reviewB} pending={scoringPending} />
        </CardContent>
      </Card>

      <div className="flex justify-between gap-3 pt-2">
        <Button variant="outline" asChild>
          <Link to="/leaderboard">← Back to leaderboard</Link>
        </Button>
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
  const positive = delta >= 0;
  const verifPct =
    detail?.verifiabilityFraction != null
      ? Math.round(detail.verifiabilityFraction * 100)
      : null;
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
        <div className="flex items-baseline gap-3">
          <div className="font-mono text-3xl">{Math.round(reveal.eloAfter)}</div>
          <div
            className={`font-mono text-sm ${
              positive ? "text-up" : "text-red"
            }`}
          >
            {positive ? "+" : ""}
            {delta.toFixed(1)} Elo
          </div>
          <div className="ml-auto font-mono text-xs text-muted-foreground">
            was {Math.round(reveal.eloBefore)}
          </div>
        </div>

        {(detail?.judgeOverall != null || verifPct != null) && (
          <div className="grid grid-cols-2 gap-3 border-t border-dashed border-rule2 px-1 pt-3 text-sm">
            <div>
              <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-graphite">Judge overall</div>
              <div className="font-mono">
                {detail?.judgeOverall != null
                  ? `${detail.judgeOverall.toFixed(1)} / 10`
                  : "—"}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-graphite">Verifiable claims</div>
              <div className="font-mono">{verifPct != null ? `${verifPct}%` : "—"}</div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Hairline chips, text color carries the verdict — no colored fills.
const VERDICT_STYLES: Record<RevealSide["claims"][number]["verdict"], string> = {
  SUPPORTED: "border-up/50 text-up",
  CONTRADICTED: "border-red/50 text-red",
  UNSUPPORTED: "border-rule2 text-graphite",
};

const VERDICT_SHORT: Record<RevealSide["claims"][number]["verdict"], string> = {
  SUPPORTED: "✓",
  CONTRADICTED: "✗",
  UNSUPPORTED: "?",
};

// Short legend text (shown under the card title) and the fuller hover
// tooltips on every ✓ / ✗ / ? marker.
const VERDICT_LEGEND: Record<RevealSide["claims"][number]["verdict"], string> = {
  SUPPORTED: "supported",
  CONTRADICTED: "contradicted",
  UNSUPPORTED: "unsupported",
};

const VERDICT_TOOLTIP: Record<RevealSide["claims"][number]["verdict"], string> = {
  SUPPORTED: "✓ Supported — the paper's text backs this claim.",
  CONTRADICTED: "✗ Contradicted — the paper's text conflicts with this claim.",
  UNSUPPORTED: "? Unsupported — no evidence for this claim was found in the paper.",
};

function ClaimList({
  label,
  side,
  pending,
}: {
  label: string;
  side?: RevealSide;
  pending: boolean;
}) {
  const counts =
    side?.claims.reduce<Record<string, number>>(
      (acc, c) => ({ ...acc, [c.verdict]: (acc[c.verdict] ?? 0) + 1 }),
      {},
    ) ?? {};
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">{label}</div>
        {side && side.claims.length > 0 && (
          <div className="flex gap-1 text-xs">
            {(["SUPPORTED", "CONTRADICTED", "UNSUPPORTED"] as const).map((k) =>
              counts[k] ? (
                <span
                  key={k}
                  className={`cursor-help border px-1.5 py-0.5 font-mono ${VERDICT_STYLES[k]}`}
                  title={VERDICT_TOOLTIP[k]}
                >
                  {VERDICT_SHORT[k]} {counts[k]}
                </span>
              ) : null,
            )}
          </div>
        )}
      </div>
      {!side || side.claims.length === 0 ? (
        <div className="border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
          {pending ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Judging claims — updates automatically…
            </span>
          ) : (
            "No claims extracted."
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {side.claims.map((c, i) => (
            <li key={i} className="rounded-md border px-3 py-2 text-sm">
              <div className="flex items-start gap-2">
                <span
                  className={`shrink-0 cursor-help border px-1.5 py-0.5 font-mono text-xs ${VERDICT_STYLES[c.verdict]}`}
                  title={VERDICT_TOOLTIP[c.verdict]}
                >
                  {VERDICT_SHORT[c.verdict]}
                </span>
                <div className="flex-1">{c.claim}</div>
              </div>
              {c.evidence && (
                <div className="mt-2 border-l-2 border-muted-foreground/20 pl-3 text-xs text-muted-foreground">
                  {c.evidence}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
