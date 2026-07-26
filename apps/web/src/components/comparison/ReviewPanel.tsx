import { useState } from "react";
import { Section } from "@/components/comparison/Section";
import { cn } from "@/lib/cn";
import type { StructuredReview } from "@reviewarena/shared-types";

/**
 * Renders a COMPLETED review with structured fields. Chrome-less — the
 * parent comparison card owns the frame and the 1px divider; this is
 * one column of it. Identical typography on both sides is the point:
 * 14.5px / 1.62, ink-2.
 *
 * When `raw` is provided, a Formatted/Raw toggle lets the rater read
 * the model's verbatim markdown output instead of our parsed sections —
 * transparency about what the LLM actually produced. The parser
 * reorganizes and strips inline markdown emphasis (so one model's bold
 * lead-ins can't out-shout a plain-prose rival in a blind comparison);
 * it never changes the wording. Raw shows the untouched original.
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
  const [view, setView] = useState<"formatted" | "raw">("formatted");
  const hasRaw = !!raw?.trim();

  return (
    <div className="px-[17px] pb-[15px] pt-4">
      <div className="mb-[11px] flex items-baseline justify-between gap-2">
        <span className="font-mono text-xs font-medium tracking-[0.04em]">{label}</span>
        <span className="flex items-baseline gap-3">
          {hasRaw && (
            <span className="flex items-baseline font-mono text-[11px]">
              {(["formatted", "raw"] as const).map((v, i) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={cn(
                    "px-1.5 transition-colors",
                    i === 0 && "border-r border-rule2",
                    view === v
                      ? "text-red underline underline-offset-4"
                      : "text-graphite hover:text-ink",
                  )}
                >
                  {v === "formatted" ? "Formatted" : "Raw"}
                </button>
              ))}
            </span>
          )}
          <span className="font-mono text-[11px] text-graphite">blind until vote</span>
        </span>
      </div>

      {view === "raw" && hasRaw ? (
        // The model's output, verbatim — no parsing, no reflow.
        <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.6] text-ink2">
          {raw}
        </pre>
      ) : (
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
      )}
    </div>
  );
}
