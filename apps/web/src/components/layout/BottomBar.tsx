import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The page's primary action bar (upload button, vote strip).
 *
 * `sticky`, deliberately NOT `fixed`. A fixed bar is glued to the bottom
 * of the VIEWPORT, so at the end of the document it lands on top of — or
 * below — the footer, and the footer is where the anonymous session id
 * lives that /consent tells participants to quote in a deletion request.
 *
 * Sticky gives both behaviours from one rule: while there is page content
 * left to scroll the bar is pinned to the bottom of the screen exactly as
 * before, and once the end of the page is reached it comes to rest in
 * normal flow, so the footer is always the last thing on the page.
 *
 * It must therefore stay the LAST child of the page's container element —
 * a sticky element only travels within its own parent.
 *
 * The negative inline margin cancels the container's 1.5rem padding so the
 * rule above the bar spans the full column, while the padding puts its
 * contents back in line with the rest of the page.
 */
export function BottomBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("sticky bottom-0 z-30 -mx-6 border-t px-6", className)}>
      {children}
    </div>
  );
}
