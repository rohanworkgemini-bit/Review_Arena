import { useMemo, useRef } from "react";
import type { Conference } from "@reviewarena/shared-types";
import { parseReviewSections, type ReviewSection } from "@/components/comparison/ReviewPanel";
import { selectionToRanges, type Highlight, type SelectedRange } from "@/lib/highlight";

/**
 * The two reviews, laid out section against section.
 *
 * Read as two independent columns, "Weaknesses" in A sits at whatever
 * vertical offset A's earlier sections happen to produce, and B's sits
 * somewhere else entirely — so comparing them means scrolling between two
 * moving targets while holding a paragraph in mind. Pairing the sections
 * removes that: the rater's eye travels sideways, not up and down.
 *
 * Layout is a CSS grid with explicit row placement rather than nested
 * columns, for one specific reason: highlighting requires each panel to be
 * a single DOM subtree (selectionToRanges takes one root and queries
 * [data-hl-block] beneath it). Interleaving A and B cells row by row would
 * break that. With `display: contents` on the panel wrappers, each panel
 * stays one subtree in the DOM while its sections are placed into their own
 * column and row — so the alignment is purely visual and the highlighting
 * code needs no knowledge of it.
 *
 * Headings are hoisted into a row spanning both columns. They are stated
 * once because both reviews answer the same form, and where one review
 * omits a section its cell renders empty — which shows the omission
 * instead of hiding it behind reflow.
 */

/** Match key for a heading: what the two reviews have to agree on. */
function norm(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface Row {
  heading: string | null;
  a: ReviewSection | null;
  b: ReviewSection | null;
}

/**
 * Pair the two reviews' sections.
 *
 * A's order is canonical because both models were given the same form and
 * A is as good an authority on it as B; anything only B produced is
 * appended in B's own order rather than dropped. A heading repeated within
 * one review keeps its own row, so nothing is silently merged away.
 */
export function pairSections(a: ReviewSection[], b: ReviewSection[]): Row[] {
  const unusedB = b.map((sec) => ({ sec, taken: false }));
  const rows: Row[] = [];

  for (const secA of a) {
    if (secA.heading === null) {
      rows.push({ heading: null, a: secA, b: null });
      continue;
    }
    const key = norm(secA.heading);
    const hit = unusedB.find((e) => !e.taken && e.sec.heading && norm(e.sec.heading) === key);
    if (hit) hit.taken = true;
    rows.push({ heading: secA.heading, a: secA, b: hit?.sec ?? null });
  }

  for (const e of unusedB) {
    if (e.taken || e.sec.heading === null) continue;
    rows.push({ heading: e.sec.heading, a: null, b: e.sec });
  }

  // B's preamble, if it has one, belongs at the top beside A's.
  const bPre = unusedB.find((e) => !e.taken && e.sec.heading === null);
  if (bPre) {
    const aPre = rows.find((r) => r.heading === null && r.a);
    if (aPre) aPre.b = bPre.sec;
    else rows.unshift({ heading: null, a: null, b: bPre.sec });
  }

  return rows;
}

interface PanelHighlighting {
  highlights?: readonly Highlight[];
  onSelectRanges?: (ranges: SelectedRange[]) => void;
  onRemoveHighlight?: (id: string) => void;
}

export function AlignedReviewPair({
  labelA,
  labelB,
  rawA,
  rawB,
  conference,
  panelA = {},
  panelB = {},
  highlighterArmed = false,
}: {
  labelA: string;
  labelB: string;
  rawA: string;
  rawB: string;
  conference?: Conference;
  panelA?: PanelHighlighting;
  panelB?: PanelHighlighting;
  highlighterArmed?: boolean;
}) {
  const rootA = useRef<HTMLDivElement>(null);
  const rootB = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () =>
      pairSections(
        parseReviewSections(rawA, panelA.highlights ?? [], panelA.onRemoveHighlight, conference),
        parseReviewSections(rawB, panelB.highlights ?? [], panelB.onRemoveHighlight, conference),
      ),
    [rawA, rawB, conference, panelA.highlights, panelB.highlights, panelA.onRemoveHighlight, panelB.onRemoveHighlight],
  );

  const onUp = (side: "A" | "B") => () => {
    const cfg = side === "A" ? panelA : panelB;
    if (!cfg.onSelectRanges) return;
    const ranges = selectionToRanges(side === "A" ? rootA.current : rootB.current);
    if (ranges.length === 0) return;
    cfg.onSelectRanges(ranges);
    window.getSelection()?.removeAllRanges();
  };

  // Rows are 1-indexed and each pairing occupies two of them: the shared
  // heading, then the two bodies side by side.
  const headingRow = (i: number) => 2 * i + 1;
  const bodyRow = (i: number) => 2 * i + 2;
  const cursor = highlighterArmed ? ({ cursor: "text" } as const) : undefined;

  return (
    <div className="px-[17px] pb-[15px] pt-4">
      <div className="mb-[11px] grid grid-cols-1 gap-x-6 lg:grid-cols-[1fr_1px_1fr]">
        <PanelLabel label={labelA} />
        <div className="hidden lg:block" aria-hidden />
        <PanelLabel label={labelB} />
      </div>

      <div
        className="grid grid-cols-1 gap-x-6 text-[14.5px] leading-[1.62] text-ink2 lg:grid-cols-[1fr_1px_1fr]"
        style={{ gridAutoRows: "min-content" }}
      >
        {/* Column rule, drawn once across every row. */}
        <div
          className="hidden bg-rule lg:block"
          style={{ gridColumn: 2, gridRow: `1 / ${2 * rows.length + 1}` }}
          aria-hidden
        />

        {rows.map((row, i) => (
          <div
            key={`h${i}`}
            // A band across the full width, not a label at the left edge:
            // the heading captions BOTH reviews, and left-aligned in the
            // flow it read as though it belonged to column A alone.
            className={
              "-mx-[17px] border-y border-rule2 bg-paper2/70 px-[17px] py-1.5 " +
              (i === 0 ? "mb-2" : "mb-2 mt-6")
            }
            style={{ gridColumn: "1 / -1", gridRow: headingRow(i) }}
          >
            {row.heading && (
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-graphite">
                {row.heading}
              </span>
            )}
          </div>
        ))}

        {/* Each panel stays one DOM subtree — `display: contents` keeps the
            wrapper out of the layout while its children are placed into the
            grid, so selectionToRanges still has a single root per panel. */}
        <div ref={rootA} onMouseUp={onUp("A")} style={{ display: "contents" }}>
          {rows.map((row, i) => (
            <div
              key={`a${i}`}
              className="space-y-3"
              style={{ gridColumn: 1, gridRow: bodyRow(i), ...cursor }}
            >
              {row.a ? row.a.nodes : <Omitted label={labelA} />}
            </div>
          ))}
        </div>

        <div ref={rootB} onMouseUp={onUp("B")} style={{ display: "contents" }}>
          {rows.map((row, i) => (
            <div
              key={`b${i}`}
              className="space-y-3"
              style={{ gridColumn: 3, gridRow: bodyRow(i), ...cursor }}
            >
              {row.b ? row.b.nodes : <Omitted label={labelB} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PanelLabel({ label }: { label: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="font-mono text-xs font-medium tracking-[0.04em]">{label}</span>
      <span className="font-mono text-[11px] text-graphite">blind until vote</span>
    </div>
  );
}

/**
 * One review answered this section and the other did not. Said plainly,
 * because completeness is one of the eight dimensions and a rater should
 * be able to see an omission rather than infer it from a short column.
 */
function Omitted({ label }: { label: string }) {
  return (
    <p className="font-mono text-[11px] italic text-graphite">
      {label} did not answer this section.
    </p>
  );
}
