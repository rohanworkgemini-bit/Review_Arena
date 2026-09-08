// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrolledInto } from "./useScrolledInto";

// jsdom has no layout engine and no ResizeObserver, and rAF must be
// synchronous here so a measurement is observable by the assertion.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
  cb(0);
  return 1;
});
vi.stubGlobal("cancelAnimationFrame", () => {});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * Probe that mounts its observed element only when `ready`, with a stubbed
 * box — jsdom reports every rect as zero, so the geometry has to be faked.
 */
function Probe({
  ready,
  box,
  report,
}: {
  ready: boolean;
  box: Partial<DOMRect>;
  report: (v: boolean) => void;
}) {
  const { ref, visible } = useScrolledInto();
  report(visible);
  if (!ready) return null;
  return createElement("div", {
    ref: (el: HTMLElement | null) => {
      if (el) el.getBoundingClientRect = () => box as DOMRect;
      ref(el);
    },
  });
}

function mount(ready: boolean, box: Partial<DOMRect>) {
  let visible = false;
  const report = (v: boolean) => {
    visible = v;
  };
  act(() => root.render(createElement(Probe, { ready, box, report })));
  return {
    get visible() {
      return visible;
    },
    rerender: (next: boolean) =>
      act(() => root.render(createElement(Probe, { ready: next, box, report }))),
  };
}

describe("useScrolledInto", () => {
  it("stays hidden while the box is still below the fold", () => {
    expect(mount(true, { top: 400, bottom: 2000 }).visible).toBe(false);
  });

  it("shows once the top of the box has scrolled past", () => {
    expect(mount(true, { top: -120, bottom: 2000 }).visible).toBe(true);
  });

  it("hides again near the bottom, where the survey takes over", () => {
    expect(mount(true, { top: -1800, bottom: 100 }).visible).toBe(false);
  });

  // The regression this hook was rewritten for: the reviews mount only
  // after the pair loads, so an effect reading a RefObject on the first
  // render found null, bailed out, and never attached its listener — the
  // rail then stayed hidden for the whole comparison.
  it("attaches when the element appears after the first render", () => {
    const probe = mount(false, { top: -120, bottom: 2000 });
    expect(probe.visible).toBe(false);
    probe.rerender(true);
    expect(probe.visible).toBe(true);
  });
});
