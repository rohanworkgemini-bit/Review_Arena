import { useCallback, useEffect, useState } from "react";

/**
 * True while the viewport is inside the observed box and moving through it.
 *
 * Used to reveal the rating rail only once the rater is actually reading:
 * pinned above the reviews from the start it is furniture, and it competes
 * with the survey for attention before there is anything to judge. It
 * appears once the top of the reviews has scrolled away, and disappears
 * again at the bottom, where the full survey takes over.
 *
 * The element is tracked by callback ref rather than a RefObject on
 * purpose. The reviews mount only after the pair has loaded, so an effect
 * reading `ref.current` on the first render finds null, bails out, and —
 * with nothing in its dependencies changing when the node later appears —
 * never attaches the listener at all. A callback ref stored in state
 * re-runs the effect the moment the node exists.
 */
export function useScrolledInto({
  topOffset = 0,
  bottomSlack = 240,
}: { topOffset?: number; bottomSlack?: number } = {}) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  const ref = useCallback((el: HTMLElement | null) => setNode(el), []);

  useEffect(() => {
    if (!node) {
      setVisible(false);
      return;
    }

    let frame = 0;
    const measure = () => {
      frame = 0;
      const r = node.getBoundingClientRect();
      // Past the top edge, and the end still far enough below that the
      // survey underneath has not come into play.
      setVisible(r.top < topOffset && r.bottom > bottomSlack);
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    // The reviews grow as images and fonts settle, and a highlight or a
    // jump can change their height — all of which move the bottom edge the
    // measurement depends on.
    const ro = new ResizeObserver(onScroll);
    ro.observe(node);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      ro.disconnect();
    };
  }, [node, topOffset, bottomSlack]);

  return { ref, visible };
}
