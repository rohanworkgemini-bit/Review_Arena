import { useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { getLeaderboard } from "@/lib/api";
import { cn } from "@/lib/cn";
import { VOTE_DIMENSIONS, DIMENSION_LABELS, type VoteDimension } from "@reviewarena/shared-types";

export function LeaderboardPage() {
  const [dimension, setDimension] = useState<VoteDimension | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["leaderboard", dimension],
    queryFn: () => getLeaderboard(dimension ?? undefined),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const entries = data?.entries ?? [];

  // Shared rating range across all rows so CI bars are visually comparable.
  const { minRating, maxRating } = useMemo(() => {
    if (entries.length === 0) return { minRating: 1000, maxRating: 1000 };
    const lows = entries.map((e) => e.ratingCiLow);
    const highs = entries.map((e) => e.ratingCiHigh);
    const min = Math.min(...lows);
    const max = Math.max(...highs);
    const pad = Math.max(10, (max - min) * 0.05);
    return { minRating: min - pad, maxRating: max + pad };
  }, [entries]);

  // "Rank Spread": [best-possible-rank, worst-possible-rank].
  // Best  rank = 1 + (# systems whose ciLow strictly above this.ciHigh)
  // Worst rank = 1 + (# systems whose ciHigh strictly above this.ciLow)
  // Communicates "given the votes we have, this system could place
  // anywhere between rank X and rank Y."
  const rankSpread = useMemo(() => {
    const map = new Map<string, { best: number; worst: number }>();
    for (const e of entries) {
      let best = 1;
      let worst = 1;
      for (const other of entries) {
        if (other.systemSlug === e.systemSlug) continue;
        if (other.ratingCiLow > e.ratingCiHigh) best++;
        if (other.ratingCiHigh > e.ratingCiLow) worst++;
      }
      map.set(e.systemSlug, { best, worst });
    }
    return map;
  }, [entries]);

  const currentLabel = dimension ? DIMENSION_LABELS[dimension] : "Overall";
  const currentDescription = dimension
    ? `Ranking by ${DIMENSION_LABELS[dimension]}, computed only over votes that included a per-dimension pick for ${DIMENSION_LABELS[dimension]}.`
    : "Overall ranking across automated peer-review systems, computed from blinded pairwise human comparisons.";

  return (
    <div className="container max-w-[1080px] py-8">
      <div className="grid gap-10 lg:grid-cols-[200px_1fr]">
        {/* ─── Left rail: categories (plain mono list) ─────────────────── */}
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <div className="eyebrow mb-3">Categories</div>
          <nav className="flex flex-row flex-wrap gap-x-1 gap-y-0.5 lg:flex-col">
            <CategoryRow
              label="Overall"
              active={dimension === null}
              onClick={() => setDimension(null)}
            />
            {VOTE_DIMENSIONS.map((d) => (
              <CategoryRow
                key={d}
                label={DIMENSION_LABELS[d]}
                active={dimension === d}
                onClick={() => setDimension(d)}
              />
            ))}
          </nav>
        </aside>

        {/* ─── Right pane: header + table ──────────────────────────────── */}
        <section className="min-w-0">
          <h1 className="text-[28px] font-semibold tracking-[-0.01em]">
            Standings — {currentLabel}
          </h1>
          <p className="mt-1 max-w-prose text-sm text-graphite">{currentDescription}</p>
          <div className="mt-3 font-mono text-[11.5px] text-graphite">
            <span className="text-ink">{data?.totalVotes ?? "—"}</span> votes ·{" "}
            <span className="text-ink">{data?.totalPapers ?? "—"}</span> papers ·{" "}
            <span className="text-ink">{entries.length}</span> systems
            {isError && (
              <span className="ml-3 text-red">
                {(error as Error)?.message ?? "API error"}
              </span>
            )}
          </div>

          <div className="mt-6">
            {isLoading ? (
              <LeaderboardSkeleton />
            ) : entries.length === 0 ? (
              <div className="border-y border-rule py-12 text-center text-sm text-graphite">
                <p className="mb-1">
                  No votes yet{dimension ? ` for ${DIMENSION_LABELS[dimension]}` : ""}.
                </p>
                <p className="mb-4">
                  {dimension
                    ? `Vote on a comparison and pick "A is better" or "B is better" for ${DIMENSION_LABELS[dimension]} to populate this ladder.`
                    : "Upload a paper and cast a vote to see systems ranked here."}
                </p>
                <Button asChild variant="outline">
                  <a href="/upload">Upload a paper</a>
                </Button>
              </div>
            ) : (
              <>
                <table className="w-full border-collapse font-mono text-[13.5px]">
                  <thead>
                    <tr>
                      <Th className="text-left">Rank spread</Th>
                      <Th className="text-left">System</Th>
                      <Th className="text-right">Elo</Th>
                      <Th className="hidden w-[30%] pl-5 text-left md:table-cell">95% CI</Th>
                      <Th className="text-right">Votes</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => {
                      const spread = rankSpread.get(e.systemSlug);
                      const halfCi = Math.round((e.ratingCiHigh - e.ratingCiLow) / 2);
                      return (
                        <tr key={e.systemSlug}>
                          <td className="border-b border-rule py-[13px] pr-3">
                            <RankSpread
                              best={spread?.best ?? e.rank}
                              worst={spread?.worst ?? e.rank}
                            />
                          </td>
                          <td className="border-b border-rule py-[13px] pr-4">
                            <div className="font-medium text-ink">{e.systemName}</div>
                            <div className="text-[11px] text-graphite">{e.systemSlug}</div>
                          </td>
                          <td className="border-b border-rule py-[13px] pr-1 text-right">
                            <span className="text-ink">{Math.round(e.rating)}</span>
                            <span className="ml-1 text-[11px] text-graphite">±{halfCi}</span>
                          </td>
                          <td className="hidden border-b border-rule py-[13px] pl-5 md:table-cell">
                            <CiBar
                              low={e.ratingCiLow}
                              rating={e.rating}
                              high={e.ratingCiHigh}
                              min={minRating}
                              max={maxRating}
                            />
                            <div className="mt-1 text-[10px] text-graphite">
                              [{Math.round(e.ratingCiLow)}, {Math.round(e.ratingCiHigh)}]
                            </div>
                          </td>
                          <td className="border-b border-rule py-[13px] text-right text-ink2">
                            {e.voteCount}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-4 font-mono text-[11px] text-graphite">
                  Elo initialised at 1000 · Bradley–Terry MLE · intervals from 100
                  bootstrap resamples · overlapping intervals widen the rank spread
                </p>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Th({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <th
      className={cn(
        "border-b border-rule2 pb-[11px] text-[10.5px] font-medium uppercase tracking-[0.12em] text-graphite",
        className,
      )}
    >
      {children}
    </th>
  );
}

function CategoryRow({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "border-l-2 px-2.5 py-1.5 text-left font-mono text-[12.5px] tracking-[0.02em] transition-colors",
        active
          ? "border-red text-red"
          : "border-transparent text-graphite hover:bg-paper2 hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}

function RankSpread({ best, worst }: { best: number; worst: number }) {
  // Renders the "1 – 4" rank-range shorthand. When best == worst we just
  // show the single number so unambiguous ranks read cleanly.
  if (best === worst) {
    return <span className="text-base text-ink">{best}</span>;
  }
  return (
    <span className="text-sm">
      <span className="text-ink">{best}</span>
      <span className="mx-1 text-graphite">–</span>
      <span className="text-graphite">{worst}</span>
    </span>
  );
}

function CiBar({
  low,
  rating,
  high,
  min,
  max,
}: {
  low: number;
  rating: number;
  high: number;
  min: number;
  max: number;
}) {
  const span = Math.max(1, max - min);
  const leftPct = ((low - min) / span) * 100;
  const widthPct = Math.max(0.5, ((high - low) / span) * 100);
  const markPct = ((rating - min) / span) * 100;
  return (
    <div className="relative h-[7px] w-full border border-rule bg-paper2">
      <div
        className="absolute bottom-0 top-0 bg-red/30"
        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
      />
      <div
        className="absolute top-[-3px] h-[11px] w-[2px] bg-red"
        style={{ left: `calc(${markPct}% - 1px)` }}
        title={`Rating ${Math.round(rating)}`}
      />
    </div>
  );
}

// Eight skeleton rows that match the real table's height so the page
// doesn't reflow when data arrives. Better than a centred "Loading…"
// line, which makes the layout jump.
function LeaderboardSkeleton() {
  return (
    <div className="divide-y divide-rule border-y border-rule">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 py-[15px]">
          <div className="h-4 w-6 animate-pulse bg-paper2" />
          <div className="h-4 w-40 animate-pulse bg-paper2" />
          <div className="ml-auto h-[7px] w-48 animate-pulse bg-paper2" />
          <div className="h-4 w-12 animate-pulse bg-paper2" />
        </div>
      ))}
    </div>
  );
}
