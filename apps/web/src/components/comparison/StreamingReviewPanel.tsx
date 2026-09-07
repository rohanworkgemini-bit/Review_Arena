import type { StructuredReview } from "@reviewarena/shared-types";
import type { ReviewStreamState } from "@/hooks/useReviewStream";
import type { Highlight, SelectedRange } from "@/lib/highlight";
import { ReviewPanel } from "@/components/comparison/ReviewPanel";
import { LiveStreamingPanel } from "@/components/comparison/LiveStreamingPanel";

/**
 * Switches between three states:
 *   1. Already-COMPLETED review (`structured` prop is non-null) →
 *      render via ReviewPanel.
 *   2. In-flight review → stream tokens via LiveStreamingPanel; when
 *      the stream emits 'done' with a structured payload, swap to
 *      ReviewPanel.
 *   3. Neither → live streaming panel showing accumulated text /
 *      "Waiting for first token…".
 *
 * Streams are opened by the parent so the vote bar can gate on
 * "both done" without lifting state across siblings.
 */
export function StreamingReviewPanel({
  label,
  structured,
  rawOutput,
  stream,
  ...highlighting
}: {
  label: string;
  structured: StructuredReview | null;
  /** Verbatim model output for already-completed reviews (from /pair).
   *  Streams accumulate their own raw text in stream.text. */
  rawOutput?: string | null;
  stream: ReviewStreamState;
  /** Forwarded to ReviewPanel. Not offered mid-stream: the text is still
   *  growing, so any offset recorded against it would shift under the
   *  highlight. Highlighting becomes available once the review lands. */
  highlights?: readonly Highlight[];
  onSelectRanges?: (ranges: SelectedRange[]) => void;
  onRemoveHighlight?: (id: string) => void;
  highlighterArmed?: boolean;
}) {
  if (structured)
    return <ReviewPanel label={label} review={structured} raw={rawOutput} {...highlighting} />;
  if (stream.structured)
    return (
      <ReviewPanel label={label} review={stream.structured} raw={stream.text} {...highlighting} />
    );
  return <LiveStreamingPanel label={label} stream={stream} />;
}
