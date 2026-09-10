import { ChevronLeft, ChevronRight, CornerDownLeft, Check } from "lucide-react";
import {
  DIMENSION_DESCRIPTIONS,
  DIMENSION_LABELS,
  VOTE_DIMENSIONS,
  type VoteDimension,
  type Winner,
} from "@reviewarena/shared-types";
import { cn } from "@/lib/cn";

/**
 * Rate as you read.
 *
 * Without this the rater works through 2,400 words of two reviews and then
 * reconstructs eight judgements from memory at the bottom of the page — so
 * the later dimensions are answered from a fading impression rather than
 * from the text. The rail sticks to the top of the viewport while they
 * scroll, so a judgement can be recorded the moment it forms.
 *
 * One dimension at a time, on purpose. Eight sets of buttons in a bar would
 * be unreadable at this height, and more importantly the rater should be
 * reading *for* something rather than scanning for all eight at once.
 *
 * Answering never moves the rail on its own — an answered dimension offers
 * "Next" and waits. Advancing on click looked like the answer had been
 * snatched away, and left no beat to reconsider or undo a misclick.
 *
 * It does not replace the full survey below — the same values are shown
 * there with room for notes, and either control can set them. This is an
 * additional way in, not a second source of truth.
 *
 * Shown only while the rater is scrolling through the reviews. Pinned from
 * the start it is furniture; it appears once the top of the reviews has
 * gone by and retires at the bottom, where the full survey takes over.
 */
export function RatingRail({
  active,
  onActiveChange,
  values,
  onPick,
  onJump,
  canJump,
  visible,
  className,
}: {
  active: VoteDimension;
  onActiveChange: (d: VoteDimension) => void;
  values: Partial<Record<VoteDimension, Winner>>;
  onPick: (d: VoteDimension, v: Winner) => void;
  /** Scroll the reviews to the section this dimension is mostly answered
   *  from. Absent when the pair has no matching section. */
  onJump?: (d: VoteDimension) => void;
  canJump: boolean;
  /** Drives the reveal. Rendered either way so focus is not thrown when it
   *  slides out from under the pointer mid-scroll. */
  visible: boolean;
  className?: string;
}) {
  const i = VOTE_DIMENSIONS.indexOf(active);
  const answered = VOTE_DIMENSIONS.filter((d) => values[d] !== undefined).length;
  const current = values[active];

  const step = (delta: number) => {
    const next = VOTE_DIMENSIONS[(i + delta + VOTE_DIMENSIONS.length) % VOTE_DIMENSIONS.length]!;
    onActiveChange(next);
  };

  // Answering does NOT advance. Moving the rail out from under the rater
  // the instant they click reads as the answer being taken away, and it
  // removes the beat where they might reconsider or correct a misclick.
  // The rail offers the next dimension instead and waits to be asked.
  const answeredHere = current !== undefined;
  const hasNext = i < VOTE_DIMENSIONS.length - 1;

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        // Opaque, and no backdrop blur. A blurred backdrop on a translating
        // element gets rasterised at low quality for the duration of the
        // animation and re-rasterised at the end, which read as the bar
        // arriving out of focus and then snapping sharp.
        "fixed inset-x-0 top-0 z-30 border-b border-rule2 bg-paper2",
        "transition-transform duration-150 motion-reduce:transition-none",
        visible ? "translate-y-0" : "-translate-y-full",
        className,
      )}
    >
      <div className="mx-auto flex max-w-[1900px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
        <div className="flex items-center gap-1">
          <Arrow label="Previous dimension" onClick={() => step(-1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </Arrow>
          <span className="w-9 text-center font-mono text-[11px] text-graphite">
            {i + 1}/{VOTE_DIMENSIONS.length}
          </span>
          <Arrow label="Next dimension" onClick={() => step(1)}>
            <ChevronRight className="h-3.5 w-3.5" />
          </Arrow>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{DIMENSION_LABELS[active]}</span>
            {current !== undefined && (
              <Check className="h-3.5 w-3.5 shrink-0 text-red" aria-label="answered" />
            )}
          </div>
          <p className="truncate text-[11px] text-graphite">
            {DIMENSION_DESCRIPTIONS[active]}
          </p>
        </div>

        {canJump && onJump && (
          <button
            type="button"
            onClick={() => onJump(active)}
            title="Scroll to the section this is mostly answered from"
            className="flex items-center gap-1 font-mono text-[11px] text-graphite underline-offset-4 hover:text-ink hover:underline"
          >
            <CornerDownLeft className="h-3 w-3" />
            jump
          </button>
        )}

        <div className="flex shrink-0 border border-ink">
          <Choice on={current === "A"} onClick={() => onPick(active, "A")}>
            A better
          </Choice>
          <Choice on={current === "TIE"} onClick={() => onPick(active, "TIE")} middle>
            Tie
          </Choice>
          <Choice on={current === "B"} onClick={() => onPick(active, "B")}>
            B better
          </Choice>
        </div>

        {/* Offered only once this dimension is answered, so it reads as
            "done here, move on" rather than as a way to skip. */}
        {answeredHere && hasNext && (
          <button
            type="button"
            onClick={() => onActiveChange(VOTE_DIMENSIONS[i + 1]!)}
            className="flex shrink-0 items-center gap-1 border border-ink px-2.5 py-1 font-mono text-[11px] transition-colors hover:bg-ink hover:text-paper"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}

        <span className="shrink-0 font-mono text-[11px] text-graphite">
          {answered}/{VOTE_DIMENSIONS.length}
        </span>
      </div>
    </div>
  );
}

function Arrow({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center border border-rule2 text-graphite transition-colors hover:text-ink"
    >
      {children}
    </button>
  );
}

function Choice({
  on,
  onClick,
  middle,
  children,
}: {
  on: boolean;
  onClick: () => void;
  middle?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "px-2.5 py-1 font-mono text-[11px] transition-colors",
        middle && "border-x border-ink",
        on ? "bg-ink text-paper" : "text-graphite hover:bg-paper hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
