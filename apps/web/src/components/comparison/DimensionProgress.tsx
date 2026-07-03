/**
 * Tiny progress chip rendered next to "Rate every dimension" — gives
 * users a live count of how many of the 8 they've picked without
 * expanding the panel. Matches the "matrix question" UX best practice
 * of always showing completion progress.
 */
export function DimensionProgress({ count, total }: { count: number; total: number }) {
  const pct = (count / total) * 100;
  return (
    <div className="flex items-center gap-2 font-mono text-xs text-graphite">
      <div className="relative h-[7px] w-14 border border-rule bg-paper2">
        <div
          className="absolute bottom-0 left-0 top-0 bg-red transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums">
        {count}/{total}
      </span>
    </div>
  );
}
