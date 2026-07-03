/** Placeholder column while the model hasn't started streaming yet. */
export function ReviewSkeleton({ label }: { label: string }) {
  return (
    <div className="px-[17px] pb-[15px] pt-4">
      <div className="mb-[11px] flex items-baseline justify-between">
        <span className="font-mono text-xs font-medium tracking-[0.04em]">{label}</span>
        <span className="font-mono text-[11px] text-graphite">waiting on the model…</span>
      </div>
      <div className="space-y-3">
        {[90, 75, 85, 60, 80, 70].map((w, i) => (
          <div
            key={i}
            className="h-3 animate-pulse bg-paper2"
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
    </div>
  );
}
