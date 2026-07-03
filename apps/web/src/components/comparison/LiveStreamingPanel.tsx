import { Button } from "@/components/ui/button";
import type { ReviewStreamState } from "@/hooks/useReviewStream";

/**
 * Renders an in-flight review as live-streaming text — one chrome-less
 * column of the comparison card. Shows the red pen cursor while tokens
 * still arrive (suppressed by the global reduced-motion rule); surfaces
 * stream errors with a retry button so a transient cold-start hiccup
 * doesn't trap the user.
 */
export function LiveStreamingPanel({
  label,
  stream,
}: {
  label: string;
  stream: ReviewStreamState;
}) {
  return (
    <div className="px-[17px] pb-[15px] pt-4">
      <div className="mb-[11px] flex items-baseline justify-between">
        <span className="font-mono text-xs font-medium tracking-[0.04em]">{label}</span>
        <span className="font-mono text-[11px] text-graphite">
          {stream.error
            ? "generation failed"
            : stream.text
            ? "streaming…"
            : "waiting for first token…"}
        </span>
      </div>
      {stream.error ? (
        <div className="space-y-3 text-[14.5px]">
          <p className="text-red">{stream.error}</p>
          <Button type="button" size="sm" variant="outline" onClick={stream.retry}>
            Retry
          </Button>
        </div>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-sans text-[14.5px] leading-[1.62] text-ink2">
          {stream.text}
          {!stream.done && <span className="stream-cursor" aria-hidden />}
        </pre>
      )}
    </div>
  );
}
