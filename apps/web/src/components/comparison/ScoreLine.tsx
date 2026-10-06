import type { Conference } from "@reviewarena/shared-types";

// The numeric answers in a review form arrive as a bare number at the head
// of the section's paragraph — "4 The paper presents a useful system…" —
// because that is the shape the venue forms ask for and the prompts
// reproduce them verbatim. Read as running text it is a stray digit; the
// rater has to work out what it was out of.
//
// So the number is lifted out and drawn on its scale, and the sentence that
// follows stays as prose. Nothing is reworded — this is presentation only,
// and both panels render identically, which is the presentation-symmetry
// control the comparison depends on.

// Per-venue maxima, from the forms in services/review-gen/app/prompts/review/.
// Getting these wrong would misdraw the bar, so they are read off the same
// source the prompts are built from:
//   ICLR 2026   overall on {0,2,4,6,8,10}
//   ICML 2026   overall recommendation 1-6
//   NeurIPS 26  rating 1-6
//   General     rating 1-6 (study/expert styles; domain asks for none)
//   all four    confidence 1-5, sub-dimensions 1-4
const OVERALL_MAX: Record<Conference, number> = {
  general: 6,
  iclr: 10,
  icml: 6,
  neurips: 6,
};

const OVERALL_RX = /^(?:overall\s+)?(?:rating|recommendation|score)$/i;
const OVERALL_REC_RX = /^overall\s+recommendation$/i;
const CONFIDENCE_RX = /^confidence$/i;
const SUBSCORE_RX =
  /^(?:soundness|presentation|contribution|significance|originality|quality|clarity)$/i;

/**
 * Whether a heading is the form's overall rating or its confidence field —
 * the two places a review states its verdict outright.
 *
 * These are not rendered in the comparison (decision 2026-09-19). A rater
 * who reads "0/10 LOWEST" beside "4/10" has been handed the answer before
 * reading a word of either review, and the vote that follows measures
 * agreement with the models' own scores rather than the quality of their
 * prose. The sub-scores — soundness, presentation, contribution — stay:
 * they caption the reasoning a rater is asked to weigh instead of
 * pronouncing on the paper.
 */
export function isVerdictHeading(heading: string): boolean {
  const h = heading.trim();
  return CONFIDENCE_RX.test(h) || OVERALL_RX.test(h) || OVERALL_REC_RX.test(h);
}

/**
 * The scale a section's leading number is on, or null when the heading is
 * not a numeric field. Falls back to the widest overall scale when the
 * venue is unknown, so a bar is never drawn shorter than the truth.
 */
export function scaleFor(heading: string, conference?: Conference): number | null {
  const h = heading.trim();
  if (CONFIDENCE_RX.test(h)) return 5;
  if (SUBSCORE_RX.test(h)) return 4;
  if (OVERALL_RX.test(h) || OVERALL_REC_RX.test(h))
    return conference ? OVERALL_MAX[conference] : 10;
  return null;
}

/**
 * Split "4 The paper presents…" into its score and the rest.
 *
 * Deliberately strict: the number must open the paragraph and land inside
 * the scale. A weakness that happens to begin "3 of the 5 baselines are
 * missing" is prose, not a score, and must survive untouched — so anything
 * that does not parse cleanly is left exactly as written.
 */
export function splitLeadingScore(
  text: string,
  max: number,
): { value: number; rest: string } | null {
  const m = /^(\d+(?:\.\d+)?)\s*(?:\/\s*\d+(?:\.\d+)?)?\s*[.):\-—]?\s+(\S[\s\S]*)$/.exec(
    text.trim(),
  );
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0 || value > max) return null;
  return { value, rest: m[2]!.trim() };
}

/**
 * The score itself: the number against its scale, and a row of segments
 * showing where it sits. Segments rather than a continuous bar because
 * every one of these scales is a small set of integers — a bar implies a
 * precision the form does not have.
 */
export function ScoreLine({ value, max }: { value: number; max: number }) {
  // ICLR's overall runs {0,2,4,6,8,10}; drawing ten segments for six
  // reachable values reads as a half-empty bar, so scales above six are
  // halved into five segments and the number carries the precision.
  const segments = max > 6 ? Math.round(max / 2) : max;
  const filled = Math.round((value / max) * segments);
  const zero = value === 0;

  return (
    <div className="mb-1.5 flex items-center gap-2.5">
      <span className="font-mono text-[15px] font-medium tabular-nums text-ink">
        {Number.isInteger(value) ? value : value.toFixed(1)}
        <span className="text-[11px] font-normal text-graphite">/{max}</span>
      </span>
      <span className="flex gap-[3px]" aria-hidden>
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            className={
              "h-[5px] w-[13px] rounded-[1px] " +
              (i < filled ? "bg-red" : "bg-rule2")
            }
          />
        ))}
      </span>
      {zero && (
        <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-graphite">
          lowest
        </span>
      )}
    </div>
  );
}
