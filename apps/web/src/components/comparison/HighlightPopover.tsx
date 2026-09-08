import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DIMENSION_LABELS, VOTE_DIMENSIONS, type VoteDimension } from "@reviewarena/shared-types";
import { DIMENSION_COLORS } from "@/lib/highlight";

/**
 * Pick a dimension for the text you just selected.
 *
 * The palette used to sit permanently above the reviews and had to be armed
 * before selecting anything — so tagging a sentence meant deciding which
 * dimension you were reading for, before you had read it. This inverts it:
 * select the text that struck you, then say what it was about. That is the
 * order the thought actually arrives in.
 *
 * A named list rather than a grid of swatches. Eight colours carry no
 * meaning on their own, so a grid asked the rater to learn a legend or
 * hover each square in turn; the label is the thing being chosen and the
 * colour is only how it will look afterwards.
 *
 * Appears at the selection, dismisses on Escape, on a click elsewhere, or
 * on scroll — the anchor rect is viewport-relative and would otherwise
 * drift away from the words it belongs to.
 */
export function HighlightPopover({
  rect,
  onPick,
  onDismiss,
}: {
  /** Viewport-relative box of the current selection. */
  rect: DOMRect;
  onPick: (d: VoteDimension) => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  // Measure first, then place: a popover clamped after paint visibly jumps.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;

    const left = Math.min(
      Math.max(margin, rect.left + rect.width / 2 - width / 2),
      window.innerWidth - width - margin,
    );

    // Eight named rows is tall enough that neither side always fits, so
    // take whichever has more room and cap the height there rather than
    // letting the list run off the viewport.
    const roomAbove = rect.top - margin * 2;
    const roomBelow = window.innerHeight - rect.bottom - margin * 2;
    const placeAbove = height <= roomAbove || roomAbove >= roomBelow;
    const maxHeight = Math.max(140, placeAbove ? roomAbove : roomBelow);
    const top = placeAbove
      ? Math.max(margin, rect.top - Math.min(height, maxHeight) - margin)
      : rect.bottom + margin;

    setPos({ left, top, maxHeight });
  }, [rect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    };
    window.addEventListener("keydown", onKey);
    // `capture` so the dismiss lands before a fresh selection starts.
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onDismiss, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onDismiss, true);
    };
  }, [onDismiss]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Tag the selection with a dimension"
      className="fixed z-50 w-[268px] overflow-y-auto border border-ink bg-paper py-1 shadow-lg"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        maxHeight: pos?.maxHeight,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className="px-2.5 pb-1 pt-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-graphite">
        Tag as
      </div>
      {VOTE_DIMENSIONS.map((d) => {
        const c = DIMENSION_COLORS[d];
        return (
          <button
            key={d}
            type="button"
            role="menuitem"
            onClick={() => onPick(d)}
            className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors hover:bg-paper2"
          >
            <span
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 border border-rule2"
              style={{ backgroundColor: c.bg, boxShadow: `inset 0 -3px 0 ${c.edge}` }}
            />
            <span className="truncate text-[13px]">{DIMENSION_LABELS[d]}</span>
          </button>
        );
      })}
    </div>
  );
}
