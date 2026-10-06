// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewStream, type ReviewStreamState } from "./useReviewStream";

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static last: FakeEventSource | null = null;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  private listeners: Record<string, ((e: Event) => void)[]> = {};
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  fireBareError(readyState: number) {
    this.readyState = readyState;
    for (const fn of this.listeners.error ?? []) fn(new Event("error"));
  }
}

vi.stubGlobal("EventSource", FakeEventSource);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let latest: ReviewStreamState;

function Probe() {
  latest = useReviewStream("r1");
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(Probe)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useReviewStream bare errors", () => {
  it("treats a CLOSED EventSource (non-200 response) as terminal at once", () => {
    const es = FakeEventSource.last!;
    act(() => es.fireBareError(FakeEventSource.CLOSED));
    expect(latest.error).toMatch(/Couldn't open the review stream/);
    expect(es.closed).toBe(true);
  });

  it("tolerates transient errors while the browser is reconnecting", () => {
    const es = FakeEventSource.last!;
    act(() => es.fireBareError(FakeEventSource.CONNECTING));
    expect(latest.error).toBeNull();
    expect(es.closed).toBe(false);
  });
});
