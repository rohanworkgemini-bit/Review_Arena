import { useEffect, useState, type RefObject } from "react";

/**
 * True while the viewport is inside `ref`'s box and moving through it.
 *
 * Used to reveal the rating rail only once the rater is actually reading:
 * pinned above the reviews from the start it is furniture, and it competes
 * with the survey for attention before there is anything to judge. It
 * appears once the top of the reviews has scrolled away, and disappears
 * again at the bottom, where the full survey takes over.
 */
export function useScrolledInto(
  ref: RefObject<HTMLElement | null>,
  { topOffset = 0, bottomSlack = 240 }: { topOffset?: number; bottomSlack?: number } = {},
): boolean {
  const [inside, setInside] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      // Past the top edge, and the end is still far enough below that the
      // survey underneath has not come into play.
      setInside(r.top < topOffset && r.bottom > bottomSlack);
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [ref, topOffset, bottomSlack]);

  return inside;
}
