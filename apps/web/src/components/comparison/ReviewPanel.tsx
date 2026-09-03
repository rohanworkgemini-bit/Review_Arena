import { Fragment, type ReactNode } from "react";
import { Section } from "@/components/comparison/Section";
import type { StructuredReview } from "@reviewarena/shared-types";

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
 * structured fields.
 */
export function ReviewPanel({
  label,
  review,
  raw,
}: {
  label: string;
  review: StructuredReview;
  raw?: string | null;
}) {
  const hasRaw = !!raw?.trim();

  return (
    <div className="px-[17px] pb-[15px] pt-4">
      <div className="mb-[11px] flex items-baseline justify-between gap-2">
        <span className="font-mono text-xs font-medium tracking-[0.04em]">{label}</span>
        <span className="font-mono text-[11px] text-graphite">blind until vote</span>
      </div>

      <div className="space-y-4 text-[14.5px] leading-[1.62] text-ink2">
        {hasRaw ? renderMarkdownLite(raw!) : <StructuredFallback review={review} />}
      </div>
    </div>
  );
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

function renderMarkdownLite(md: string): ReactNode {
  const lines = md.split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  let key = 0;

  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag
        key={key++}
        className={`${list.ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5`}
      >
        {list.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(<p key={key++}>{para.join(" ")}</p>);
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
      blocks.push(
        <div
          key={key++}
          className="mb-1 mt-1 font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-graphite"
        >
          {sanitizeInline(heading[1]!)}
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
