import { cn } from "@/lib/cn";

/**
 * Single dimension row in the "Rate every dimension" panel — a 3-way
 * segmented control (A better / Tie / B better) in the reference's
 * button grammar, plus an optional free-text note explaining the pick.
 * Clicking the already-selected side deselects (dimension → unrated).
 * value: -1 = A, 0 = tie, 1 = B, undefined = unrated.
 */
export function DimensionRow({
  label,
  question,
  value,
  note,
  onPick,
  onChangeNote,
}: {
  label: string;
  question: string;
  value: number | undefined;
  note: string;
  onPick: (v: -1 | 0 | 1) => void;
  onChangeNote: (text: string) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-[11px] text-graphite">{question}</span>
      </div>
      <div
        className="grid grid-cols-3 border border-ink bg-paper"
        role="radiogroup"
        aria-label={`${label} preference`}
      >
        <SegButton active={value === -1} onClick={() => onPick(-1)} divider label="A better" />
        <SegButton active={value === 0} onClick={() => onPick(0)} divider label="Tie" />
        <SegButton active={value === 1} onClick={() => onPick(1)} label="B better" />
      </div>
      <input
        type="text"
        value={note}
        onChange={(e) => onChangeNote(e.target.value)}
        maxLength={1000}
        placeholder="Why? (optional)"
        aria-label={`${label} note`}
        className="mt-1.5 w-full border border-rule2 bg-paper px-2.5 py-1.5 font-mono text-[12px] text-ink placeholder:text-graphite"
      />
    </div>
  );
}

function SegButton({
  active,
  onClick,
  divider,
  label,
}: {
  active: boolean;
  onClick: () => void;
  divider?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center px-2 py-2 font-mono text-[12.5px] transition-colors",
        divider && "border-r border-ink",
        active
          ? "bg-red font-medium text-paper"
          : "text-graphite hover:bg-paper2 hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}
