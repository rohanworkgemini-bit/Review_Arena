/**
 * Dimension-tagged highlighting for the comparison panels.
 *
 * A rater picks a dimension, selects text in either review, and the span is
 * tinted in that dimension's colour; hovering it names the dimension. This
 * is a reading aid only — highlights live in React state for the duration
 * of the comparison and are never submitted or persisted (decision
 * 2026-09-04). Nothing here touches the vote payload.
 *
 * Offsets are stored against the *plain text* of a rendered block, not the
 * markdown source: `el.textContent` is unaffected by the <mark> wrappers we
 * inject, so previously-recorded offsets stay valid as more highlights are
 * added to the same block.
 */
import { VOTE_DIMENSIONS, type VoteDimension } from "@reviewarena/shared-types";

export type Highlight = {
  id: string;
  /** Index of the text block within one panel (see data-hl-block). */
  block: number;
  /** Character offsets into that block's plain text; end is exclusive. */
  start: number;
  end: number;
  dimension: VoteDimension;
};

/** A span the user selected, before a dimension is attached. */
export type SelectedRange = Pick<Highlight, "block" | "start" | "end">;

/**
 * One hue per dimension. `bg` is deliberately translucent so the tint reads
 * on both the light paper and the dark theme without changing text colour —
 * the panels are a presentation-symmetry control, so highlighting must not
 * alter typography, only background.
 */
export const DIMENSION_COLORS: Record<VoteDimension, { bg: string; edge: string }> = {
  CONTRIBUTION_ACCURACY: { bg: "rgba(245, 158, 11, 0.34)", edge: "rgb(180, 105, 0)" },
  RESULTS_INTERPRETATION: { bg: "rgba(56, 189, 248, 0.34)", edge: "rgb(2, 132, 199)" },
  COMPARATIVE_ANALYSIS: { bg: "rgba(167, 139, 250, 0.36)", edge: "rgb(124, 58, 237)" },
  EVIDENCE_BASED_CRITIQUE: { bg: "rgba(52, 211, 153, 0.34)", edge: "rgb(5, 150, 105)" },
  CRITIQUE_CLARITY: { bg: "rgba(244, 114, 182, 0.32)", edge: "rgb(219, 39, 119)" },
  COMPLETENESS_COVERAGE: { bg: "rgba(34, 211, 238, 0.30)", edge: "rgb(14, 116, 144)" },
  CONSTRUCTIVE_TONE: { bg: "rgba(163, 230, 53, 0.36)", edge: "rgb(101, 163, 13)" },
  FALSE_CLAIMS: { bg: "rgba(248, 113, 113, 0.34)", edge: "rgb(220, 38, 38)" },
};

let seq = 0;
export function newHighlightId(): string {
  seq += 1;
  return `hl-${Date.now().toString(36)}-${seq}`;
}

/**
 * Map the current DOM selection onto block-relative offsets.
 *
 * Returns one entry per text block the selection touches, so dragging
 * across two bullets tags both. Blocks are located by the data-hl-block
 * attribute the renderer stamps on every text-bearing element.
 */
export function selectionToRanges(root: HTMLElement | null): SelectedRange[] {
  if (!root || typeof window === "undefined") return [];
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return [];

  const out: SelectedRange[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-hl-block]"))) {
    if (!range.intersectsNode(el)) continue;
    const block = Number(el.dataset.hlBlock);
    if (!Number.isInteger(block)) continue;
    const text = el.textContent ?? "";

    // Offset of a boundary = length of the text from the block's start up to
    // that boundary. Boundaries outside this block clamp to its edges, which
    // is what makes multi-block drags work.
    let start = 0;
    let end = text.length;
    if (el.contains(range.startContainer)) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.setEnd(range.startContainer, range.startOffset);
      start = r.toString().length;
    }
    if (el.contains(range.endContainer)) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.setEnd(range.endContainer, range.endOffset);
      end = r.toString().length;
    }
    // Trim whitespace the browser habitually includes at a drag's edges.
    while (start < end && /\s/.test(text[start] ?? "")) start++;
    while (end > start && /\s/.test(text[end - 1] ?? "")) end--;
    if (end > start) out.push({ block, start, end });
  }
  return out;
}

/**
 * Add spans under one dimension, dropping any overlap with what is already
 * highlighted in that block. Re-tagging text that is already marked replaces
 * the old span rather than stacking two tints on the same words.
 */
export function addHighlights(
  existing: readonly Highlight[],
  ranges: readonly SelectedRange[],
  dimension: VoteDimension,
): Highlight[] {
  let next = [...existing];
  for (const r of ranges) {
    next = next.flatMap((h) => {
      if (h.block !== r.block || h.end <= r.start || h.start >= r.end) return [h];
      const pieces: Highlight[] = [];
      if (h.start < r.start) pieces.push({ ...h, id: newHighlightId(), end: r.start });
      if (h.end > r.end) pieces.push({ ...h, id: newHighlightId(), start: r.end });
      return pieces;
    });
    next.push({ id: newHighlightId(), dimension, ...r });
  }
  return next.sort((a, b) => a.block - b.block || a.start - b.start);
}

/** Count of highlights per dimension — drives the toolbar's badges. */
export function countsByDimension(
  highlights: readonly Highlight[],
): Partial<Record<VoteDimension, number>> {
  const out: Partial<Record<VoteDimension, number>> = {};
  for (const d of VOTE_DIMENSIONS) {
    const n = highlights.filter((h) => h.dimension === d).length;
    if (n > 0) out[d] = n;
  }
  return out;
}
