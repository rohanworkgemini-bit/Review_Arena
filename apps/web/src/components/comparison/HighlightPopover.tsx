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
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

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
    // Above the selection by default; below when there is no room, so the
    // popover never covers the text being tagged.
    const above = rect.top - height - margin;
    const top = above >= margin ? above : rect.bottom + margin;
    setPos({ left, top });
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
      className="fixed z-50 border border-ink bg-paper p-1.5 shadow-lg"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className="mb-1 px-1 font-mono text-[10px] uppercase tracking-[0.1em] text-graphite">
        Tag as
      </div>
      <div className="grid grid-cols-4 gap-1">
        {VOTE_DIMENSIONS.map((d) => {
          const c = DIMENSION_COLORS[d];
          return (
            <button
              key={d}
              type="button"
              role="menuitem"
              title={DIMENSION_LABELS[d]}
              aria-label={DIMENSION_LABELS[d]}
              onClick={() => onPick(d)}
              className="h-7 w-7 border border-rule2 transition-transform hover:scale-110"
              style={{ backgroundColor: c.bg, boxShadow: `inset 0 -3px 0 ${c.edge}` }}
            />
          );
        })}
      </div>
    </div>
  );
}
