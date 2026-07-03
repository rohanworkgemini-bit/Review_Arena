import { cn } from "@/lib/cn";

/**
 * Single dimension row in the "Rate every dimension" panel —
 * segmented split-button in the reference's button grammar: 1px ink
 * border, paper fill; the chosen side fills red. Clicking the already-
 * selected side deselects (returns the dimension to "no opinion").
 */
export function DimensionRow({
  label,
  question,
  value,
  onPickA,
  onPickB,
}: {
  label: string;
  question: string;
  value: number | undefined;
  onPickA: () => void;
  onPickB: () => void;
}) {
  const aActive = value === -1;
  const bActive = value === 1;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-[11px] text-graphite">{question}</span>
      </div>
      <div
        className="grid grid-cols-2 border border-ink bg-paper"
        role="radiogroup"
        aria-label={`${label} preference`}
      >
        <SegButton active={aActive} onClick={onPickA} divider tag="A" />
        <SegButton active={bActive} onClick={onPickB} tag="B" />
      </div>
    </div>
  );
}

function SegButton({
  active,
  onClick,
  divider,
  tag,
}: {
  active: boolean;
  onClick: () => void;
  divider?: boolean;
  tag: "A" | "B";
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-1.5 px-3 py-2 font-mono text-[12.5px] transition-colors",
        divider && "border-r border-ink",
        active
          ? "bg-red font-medium text-paper"
          : "text-graphite hover:bg-paper2 hover:text-ink",
      )}
    >
      <span className="font-medium">{tag}</span>
      <span>is better</span>
    </button>
  );
}
