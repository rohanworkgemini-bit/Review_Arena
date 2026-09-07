import { DIMENSION_LABELS, VOTE_DIMENSIONS, type VoteDimension } from "@reviewarena/shared-types";
import { DIMENSION_COLORS, type Highlight, countsByDimension } from "@/lib/highlight";
import { cn } from "@/lib/cn";

/**
 * The highlighter palette: one swatch per voting dimension. Pick a colour,
 * then select text in either review to tag it. Clicking the active swatch
 * again puts the highlighter away.
 *
 * Purely a reading aid — see lib/highlight.ts. Nothing here is submitted.
 */
export function HighlightToolbar({
  active,
  onChange,
  highlights,
  onClear,
  className,
}: {
  active: VoteDimension | null;
  onChange: (d: VoteDimension | null) => void;
  highlights: readonly Highlight[];
  onClear: () => void;
  className?: string;
}) {
  const counts = countsByDimension(highlights);

  return (
    <div className={cn("border border-rule2 bg-card", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-paper2 px-4 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
          Highlighter
        </span>
        <span className="font-mono text-[11px] text-graphite">
          {active
            ? `select text to tag it — ${DIMENSION_LABELS[active]}`
            : "pick a dimension, then select text in either review"}
        </span>
        {highlights.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto font-mono text-[11px] text-graphite underline-offset-4 hover:text-ink hover:underline"
          >
            Clear {highlights.length} highlight{highlights.length === 1 ? "" : "s"}
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 border-t border-rule px-4 py-3">
        {VOTE_DIMENSIONS.map((d) => {
          const on = active === d;
          const n = counts[d] ?? 0;
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? null : d)}
              title={DIMENSION_LABELS[d]}
              className={cn(
                "flex items-center gap-1.5 border px-2 py-1 text-[12px] transition-colors",
                on ? "border-ink" : "border-rule2 hover:border-graphite",
              )}
              style={on ? { backgroundColor: DIMENSION_COLORS[d].bg } : undefined}
            >
              <span
                aria-hidden
                className="inline-block h-3 w-3 rounded-[2px]"
                style={{
                  backgroundColor: DIMENSION_COLORS[d].bg,
                  boxShadow: `inset 0 0 0 1px ${DIMENSION_COLORS[d].edge}`,
                }}
              />
              <span className={cn(on && "font-medium")}>{DIMENSION_LABELS[d]}</span>
              {n > 0 && <span className="font-mono text-[11px] text-graphite">{n}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
