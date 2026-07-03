import { type ReactNode } from "react";

/** Small titled section inside a review column. Used by ReviewPanel. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-graphite">
        {title}
      </div>
      {children}
    </div>
  );
}
