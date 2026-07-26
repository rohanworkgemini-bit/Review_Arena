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
  readOnly = false,
}: {
  label: string;
  question: string;
  value: number | undefined;
  note: string;
  onPick: (v: -1 | 0 | 1) => void;
  onChangeNote: (text: string) => void;
  /** Vote already cast — show the pick, refuse to change it. */
  readOnly?: boolean;
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
        <SegButton active={value === -1} onClick={() => onPick(-1)} divider label="A better" readOnly={readOnly} />
        <SegButton active={value === 0} onClick={() => onPick(0)} divider label="Tie" readOnly={readOnly} />
        <SegButton active={value === 1} onClick={() => onPick(1)} label="B better" readOnly={readOnly} />
      </div>
      <input
        type="text"
        value={note}
        onChange={(e) => onChangeNote(e.target.value)}
        readOnly={readOnly}
        maxLength={1000}
        placeholder={readOnly ? "No note given." : "Why? (optional)"}
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
  readOnly = false,
}: {
  active: boolean;
  onClick: () => void;
  divider?: boolean;
  label: string;
  readOnly?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-disabled={readOnly || undefined}
      disabled={readOnly}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center px-2 py-2 font-mono text-[12.5px] transition-colors",
        divider && "border-r border-ink",
        active
          ? "bg-red font-medium text-paper"
          // Unpicked options fade out once the vote is locked, so the
          // chosen side still reads clearly without hover affordances.
          : readOnly
          ? "text-graphite/50"
          : "text-graphite hover:bg-paper2 hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}
