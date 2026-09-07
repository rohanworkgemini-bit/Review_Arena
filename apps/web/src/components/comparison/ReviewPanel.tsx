import { Fragment, useRef, type ReactNode } from "react";
import { Section } from "@/components/comparison/Section";
import {
  ScoreLine,
  scaleFor,
  splitLeadingScore,
} from "@/components/comparison/ScoreLine";
import {
  DIMENSION_LABELS,
  type Conference,
  type StructuredReview,
} from "@reviewarena/shared-types";
import {
  DIMENSION_COLORS,
  selectionToRanges,
  type Highlight,
  type SelectedRange,
} from "@/lib/highlight";

/**
 * Renders a COMPLETED review — one chrome-less column of the comparison
 * card; the parent owns the frame and the 1px divider.
 *
 * Single view (decision 2026-09-04): the model's raw markdown output,
 * rendered as formatted text — every section exactly as the LLM wrote
 * it, in the venue's own review-form order. The only alteration is
 * sanitizing stray inline emphasis markers (** / *) that some models
 * sprinkle in: rendering the bold would hand one system visual salience
 * its rival lacks, and leaving literal asterisks on screen is noise.
 * Wording, sections, and order are never touched. Both panels use
 * identical typography — the presentation-symmetry control.
 *
 * Reviews from before rawOutput was stored fall back to the parsed
 * structured fields. Highlighting is available on the markdown path only;
 * the legacy fallback renders exactly as it always did.
 */
export function ReviewPanel({
  label,
  review,
  raw,
  highlights = [],
  onSelectRanges,
  onRemoveHighlight,
  highlighterArmed = false,
  conference,
}: {
  label: string;
  review: StructuredReview;
  raw?: string | null;
  /** Sets the scale the numeric answers are drawn against. Without it the
   *  widest overall scale is assumed, so a bar is never drawn short. */
  conference?: Conference;
  /** Spans to tint in this panel. Omit for a plain, non-interactive panel. */
  highlights?: readonly Highlight[];
  /** Called on mouse-up with whatever the rater selected. */
  onSelectRanges?: (ranges: SelectedRange[]) => void;
  /** Click a tinted span to drop it. */
  onRemoveHighlight?: (id: string) => void;
  /** A dimension is chosen, so selecting text will tag it. */
  highlighterArmed?: boolean;
}) {
  const hasRaw = !!raw?.trim();
  const bodyRef = useRef<HTMLDivElement>(null);

  const handleMouseUp = () => {
    if (!onSelectRanges) return;
    const ranges = selectionToRanges(bodyRef.current);
    if (ranges.length === 0) return;
    onSelectRanges(ranges);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div className="px-[17px] pb-[15px] pt-4">
      <div className="mb-[11px] flex items-baseline justify-between gap-2">
        <span className="font-mono text-xs font-medium tracking-[0.04em]">{label}</span>
        <span className="font-mono text-[11px] text-graphite">blind until vote</span>
      </div>

      <div
        ref={bodyRef}
        onMouseUp={handleMouseUp}
        className="space-y-4 text-[14.5px] leading-[1.62] text-ink2"
        style={highlighterArmed ? { cursor: "text" } : undefined}
      >
        {hasRaw ? (
          renderMarkdownLite(raw!, highlights, onRemoveHighlight, conference)
        ) : (
          <StructuredFallback review={review} />
        )}
      </div>
    </div>
  );
}

// ─── highlight-aware text ────────────────────────────────────────────────

/**
 * Split one block's plain text around its highlights. Offsets are against
 * this text, and <mark> does not change textContent, so the offsets a later
 * selection produces stay consistent with the ones already stored.
 */
function BlockText({
  text,
  block,
  highlights,
  onRemove,
}: {
  text: string;
  block: number;
  highlights: readonly Highlight[];
  onRemove?: (id: string) => void;
}): ReactNode {
  const mine = highlights
    .filter((h) => h.block === block)
    .sort((a, b) => a.start - b.start);
  if (mine.length === 0) return text;

  const out: ReactNode[] = [];
  let pos = 0;
  for (const h of mine) {
    const start = Math.max(pos, Math.min(h.start, text.length));
    const end = Math.max(start, Math.min(h.end, text.length));
    if (end <= start) continue;
    if (start > pos) out.push(text.slice(pos, start));
    const color = DIMENSION_COLORS[h.dimension];
    out.push(
      <mark
        key={h.id}
        title={DIMENSION_LABELS[h.dimension]}
        aria-label={`Highlighted: ${DIMENSION_LABELS[h.dimension]}`}
        onClick={() => onRemove?.(h.id)}
        className="rounded-[2px] px-[1px] text-inherit"
        style={{
          backgroundColor: color.bg,
          boxShadow: `inset 0 -2px 0 ${color.edge}`,
          cursor: onRemove ? "pointer" : "default",
        }}
      >
        {text.slice(start, end)}
      </mark>,
    );
    pos = end;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return <Fragment>{out}</Fragment>;
}

// ─── markdown-lite renderer ──────────────────────────────────────────────
//
// Deliberately not a full markdown engine: the review form only produces
// headings, bullet/numbered lists, and paragraphs, and a hand-rolled
// renderer guarantees the two panels can never diverge on edge cases a
// library might handle "helpfully" (raw HTML, links, images — all of
// which render as plain text here).

// Asterisk emphasis only — underscore forms are left alone on purpose:
// reviews routinely mention snake_case identifiers, and `__init__` must
// not silently become `init`. Mirrors _review_parse.strip_inline_emphasis.
const BOLD_RX = /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g;
const ITALIC_RX = /(?<!\*)\*(?=\S)([^*]+?)(?<=\S)\*(?!\*)/g;

function sanitizeInline(text: string): string {
  return text.replace(BOLD_RX, "$1").replace(ITALIC_RX, "$1");
}

const HEADING_RX = /^#{1,4}\s+(.*)$/;
const BULLET_RX = /^[-*•]\s+(.*)$/;
const NUMBERED_RX = /^\d+[.)]\s+(.*)$/;

function renderMarkdownLite(
  md: string,
  highlights: readonly Highlight[],
  onRemove?: (id: string) => void,
  conference?: Conference,
): ReactNode {
  const lines = md.split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  let key = 0;
  // Scale of the section currently open, when it is a numeric field. Set by
  // the heading, consumed by the first paragraph under it, then cleared —
  // only the answer immediately following the heading is a score.
  let pendingScale: number | null = null;
  // Monotonic index across every text-bearing element in this panel; it is
  // what highlight offsets are anchored to, so the walk order must stay
  // deterministic (it is — one pass over the lines).
  let blockIndex = 0;

  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    const items = list.items;
    blocks.push(
      <Tag
        key={key++}
        className={`${list.ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5`}
      >
        {items.map((item, i) => {
          const block = blockIndex++;
          return (
            <li key={i} data-hl-block={block}>
              <BlockText
                text={item}
                block={block}
                highlights={highlights}
                onRemove={onRemove}
              />
            </li>
          );
        })}
      </Tag>,
    );
    list = null;
  };
  const flushPara = () => {
    if (para.length === 0) return;
    const text = para.join(" ");
    const scale = pendingScale;
    pendingScale = null;
    const scored = scale === null ? null : splitLeadingScore(text, scale);
    // The block's text is what remains after the number is lifted out, and
    // highlight offsets are taken against the rendered text — so stripping
    // it here keeps offsets and rendering in step. blockIndex is unchanged
    // either way: one paragraph is still one block.
    const body = scored ? scored.rest : text;
    const block = blockIndex++;
    blocks.push(
      <div key={key++}>
        {scored && <ScoreLine value={scored.value} max={scale!} />}
        <p data-hl-block={block}>
          <BlockText text={body} block={block} highlights={highlights} onRemove={onRemove} />
        </p>
      </div>,
    );
    para = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      flushPara();
      continue;
    }

    const heading = HEADING_RX.exec(line);
    if (heading) {
      flushList();
      flushPara();
      const text = sanitizeInline(heading[1]!);
      pendingScale = scaleFor(text, conference);
      const block = blockIndex++;
      blocks.push(
        <div
          key={key++}
          data-hl-block={block}
          className="mb-1 mt-1 font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-graphite"
        >
          <BlockText text={text} block={block} highlights={highlights} onRemove={onRemove} />
        </div>,
      );
      continue;
    }

    const bullet = BULLET_RX.exec(line);
    if (bullet) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(sanitizeInline(bullet[1]!));
      continue;
    }

    const numbered = NUMBERED_RX.exec(line);
    if (numbered) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(sanitizeInline(numbered[1]!));
      continue;
    }

    flushList();
    para.push(sanitizeInline(line));
  }
  flushList();
  flushPara();

  return <Fragment>{blocks}</Fragment>;
}

// ─── legacy fallback (rows without rawOutput) ────────────────────────────

function StructuredFallback({ review }: { review: StructuredReview }) {
  return (
    <>
      <Section title="Summary">{review.summary}</Section>
      <Section title="Strengths">
        <ul className="list-disc pl-5 space-y-1">
          {review.strengths.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      </Section>
      <Section title="Weaknesses">
        <ul className="list-disc pl-5 space-y-1">
          {review.weaknesses.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      </Section>
      <Section title="Questions">
        <ul className="list-disc pl-5 space-y-1">
          {review.questions.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      </Section>
      {review.overallRating !== undefined && (
        <div className="border-t border-dashed border-rule2 pt-3 font-mono text-xs text-graphite">
          Overall {review.overallRating}/10
          {review.confidence !== undefined && `  ·  confidence ${review.confidence}/5`}
        </div>
      )}
    </>
  );
}
