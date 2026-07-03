import { Section } from "@/components/comparison/Section";
import type { StructuredReview } from "@reviewarena/shared-types";

/**
 * Renders a COMPLETED review with structured fields. Chrome-less — the
 * parent comparison card owns the frame and the 1px divider; this is
 * one column of it. Identical typography on both sides is the point:
 * 14.5px / 1.62, ink-2.
 */
export function ReviewPanel({
  label,
  review,
}: {
  label: string;
  review: StructuredReview;
}) {
  return (
    <div className="px-[17px] pb-[15px] pt-4">
      <div className="mb-[11px] flex items-baseline justify-between">
        <span className="font-mono text-xs font-medium tracking-[0.04em]">{label}</span>
        <span className="font-mono text-[11px] text-graphite">blind until vote</span>
      </div>
      <div className="space-y-4 text-[14.5px] leading-[1.62] text-ink2">
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
      </div>
    </div>
  );
}
