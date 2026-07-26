import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

/**
 * A viewport-pinned action bar (the upload button, the vote strip) that
 * does NOT cover the footer.
 *
 * Why this exists: the bar is `position: fixed`, so it sits at the bottom
 * of the VIEWPORT. The Footer is the last element in AppShell's normal
 * flow, so once you scroll to the end of the document the two occupy the
 * same band and the bar wins — the footer (session id, data-processing
 * link) was unreachable on /upload and /compare. Page-level `pb-*` can't
 * fix it: the Footer lives outside <main>, so padding inside the page
 * pushes the footer DOWN rather than reserving room after it.
 *
 * The fix has to add scrollable space AFTER the footer, which only the
 * shell can do. So the bar measures itself and reports its height up;
 * AppShell pads its column by that much. Measured rather than hardcoded
 * because the bars reflow (the vote strip wraps to two lines on narrow
 * viewports, and swaps to a taller "vote recorded" state).
 */
export const BottomBarContext = createContext<(height: number) => void>(() => {});

export function BottomBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const setHeight = useContext(BottomBarContext);
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // ResizeObserver rather than a one-shot measure: the bar changes
    // height when its content wraps or its state swaps.
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    setHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [setHeight]);

  // Release the reservation when the page unmounts, otherwise every other
  // route keeps a dead gap under its footer.
  useEffect(() => () => setHeight(0), [setHeight]);

  return (
    <div
      ref={ref}
      className={cn(
        "fixed bottom-0 left-0 right-0 z-30 border-t lg:[left:var(--sidebar-w)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
