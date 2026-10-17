// @vitest-environment jsdom

import { act, useRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasLayout } from "../../src/renderer/canvas/spatial/spatial-types";
import type { Camera } from "../../src/renderer/canvas/spatial/spatial-types";
import { useCanvasCamera } from "../../src/renderer/canvas/spatial/use-canvas-camera";

const layout: CanvasLayout = {
  nodes: [],
  bounds: { left: -500, top: -300, right: 500, bottom: 300 },
  wires: [],
  ports: [],
};

class TestResizeObserver {
  static latest: TestResizeObserver | undefined;
  callback: ResizeObserverCallback;
  observed: Element | undefined;
  disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    TestResizeObserver.latest = this;
  }
  observe(target: Element): void {
    this.observed = target;
    this.callback([], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
}

function pointer(type: string, pointerId: number, x: number, y: number, pointerType = "mouse"): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: x },
    clientY: { value: y },
    pointerType: { value: pointerType },
    button: { value: 0 },
  });
  return event;
}

describe("canvas camera input", () => {
  let container: HTMLDivElement;
  let root: Root;
  let capture: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    capture = vi.fn();
    TestResizeObserver.latest = undefined;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    Object.defineProperty(HTMLDivElement.prototype, "setPointerCapture", { configurable: true, value: capture });
    Object.defineProperty(HTMLDivElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLDivElement.prototype, "setPointerCapture");
    Reflect.deleteProperty(HTMLDivElement.prototype, "releasePointerCapture");
  });

  function render(
    disabled = false,
    initialCamera?: Camera,
    layoutForSize?: () => CanvasLayout,
    resizeAnchor?: "center" | "origin",
  ): HTMLDivElement {
    function Harness(): ReactElement {
      const viewportRef = useRef<HTMLDivElement>(null);
      const camera = useCanvasCamera({
        viewportRef,
        viewKey: "project",
        layout,
        layoutForSize,
        initialCamera,
        resizeAnchor,
        disabled,
        onCameraChange: () => undefined,
      });
      const measureRef = (viewport: HTMLDivElement | null): void => {
        viewportRef.current = viewport;
        if (!viewport) return;
        Object.defineProperties(viewport, {
          clientWidth: { configurable: true, value: 800 },
          clientHeight: { configurable: true, value: 600 },
        });
        viewport.getBoundingClientRect = () => ({
          x: 100,
          y: 50,
          left: 100,
          top: 50,
          right: 900,
          bottom: 650,
          width: 800,
          height: 600,
          toJSON: () => ({}),
        });
      };
      return (
        <div
          aria-label="Canvas"
          data-camera={JSON.stringify(camera.camera)}
          onKeyDown={camera.onKeyDown}
          onLostPointerCapture={camera.onLostPointerCapture}
          onPointerCancel={camera.onPointerCancel}
          onPointerDown={camera.onPointerDown}
          onPointerMove={camera.onPointerMove}
          onPointerUp={camera.onPointerUp}
          ref={measureRef}
          tabIndex={0}
        >
          <button type="button">Node control</button>
        </div>
      );
    }
    act(() => root.render(<Harness />));
    return container.querySelector<HTMLDivElement>("[aria-label='Canvas']")!;
  }

  function cameraOf(viewport: HTMLDivElement): { x: number; y: number; scale: number } {
    return JSON.parse(viewport.dataset.camera ?? "{}");
  }

  it("pans normal wheel input and zooms modifier wheel around the pointer", () => {
    const viewport = render();
    const before = cameraOf(viewport);
    const pan = new WheelEvent("wheel", { deltaY: 40, cancelable: true, bubbles: true });
    act(() => viewport.dispatchEvent(pan));
    const afterPan = cameraOf(viewport);
    expect(afterPan.y).toBe(before.y - 40);
    expect(pan.defaultPrevented).toBe(true);

    const anchor = { x: 350 - 100, y: 230 - 50 };
    const worldBefore = { x: (anchor.x - afterPan.x) / afterPan.scale, y: (anchor.y - afterPan.y) / afterPan.scale };
    act(() =>
      viewport.dispatchEvent(
        new WheelEvent("wheel", {
          clientX: 350,
          clientY: 230,
          deltaY: -80,
          ctrlKey: true,
          cancelable: true,
          bubbles: true,
        }),
      ),
    );
    const afterZoom = cameraOf(viewport);
    expect(afterZoom.scale).toBeGreaterThan(afterPan.scale);
    expect((anchor.x - afterZoom.x) / afterZoom.scale).toBeCloseTo(worldBefore.x);
    expect((anchor.y - afterZoom.y) / afterZoom.scale).toBeCloseTo(worldBefore.y);
  });

  it("ignores controls and waits for a four-pixel blank-space drag before capture", () => {
    const viewport = render();
    const before = cameraOf(viewport);
    const button = viewport.querySelector("button")!;
    act(() => button.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, cancelable: true, bubbles: true })));
    expect(cameraOf(viewport)).toEqual(before);

    act(() => viewport.dispatchEvent(pointer("pointerdown", 1, 200, 200)));
    act(() => viewport.dispatchEvent(pointer("pointermove", 1, 202, 202)));
    expect(capture).not.toHaveBeenCalled();
    act(() => viewport.dispatchEvent(pointer("pointermove", 1, 205, 200)));
    expect(capture).toHaveBeenCalledWith(1);
    expect(cameraOf(viewport).x).toBe(before.x + 5);
    act(() => viewport.dispatchEvent(pointer("pointercancel", 1, 205, 200)));
    expect(viewport.classList.contains("is-dragging")).toBe(false);
    act(() => viewport.dispatchEvent(pointer("pointerdown", 2, 200, 200)));
    act(() => viewport.dispatchEvent(pointer("pointermove", 2, 205, 200)));
    const beforeLostCapture = cameraOf(viewport);
    act(() => viewport.dispatchEvent(pointer("lostpointercapture", 2, 205, 200)));
    act(() => viewport.dispatchEvent(pointer("pointermove", 2, 250, 200)));
    expect(cameraOf(viewport)).toEqual(beforeLostCapture);
    expect(viewport.classList.contains("is-dragging")).toBe(false);
  });

  it("zooms and translates two touch pointers from their midpoint", () => {
    const viewport = render();
    const before = cameraOf(viewport);
    act(() => viewport.dispatchEvent(pointer("pointerdown", 1, 200, 200, "touch")));
    act(() => viewport.dispatchEvent(pointer("pointerdown", 2, 300, 200, "touch")));
    act(() => viewport.dispatchEvent(pointer("pointermove", 2, 400, 200, "touch")));

    const after = cameraOf(viewport);
    expect(after.scale).toBeGreaterThan(before.scale);
    expect(capture).toHaveBeenCalledWith(1);
    expect(capture).toHaveBeenCalledWith(2);
    act(() => viewport.dispatchEvent(pointer("pointerup", 2, 400, 200, "touch")));
    act(() => viewport.dispatchEvent(pointer("pointercancel", 1, 200, 200, "touch")));
    expect(viewport.classList.contains("is-dragging")).toBe(false);
  });

  it("fits after the first positive measurement and shifts by half a resize", () => {
    const viewport = render();
    expect(cameraOf(viewport)).toEqual({ x: 400, y: 300, scale: 0.8 });
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 800 },
    });
    act(() => TestResizeObserver.latest?.callback([], TestResizeObserver.latest as unknown as ResizeObserver));
    expect(cameraOf(viewport)).toEqual({ x: 500, y: 400, scale: 0.8 });
  });

  it("fits and refits against the layout selected for the measured viewport", () => {
    const responsiveLayout: CanvasLayout = {
      nodes: [],
      bounds: { left: -100, top: -20, right: 300, bottom: 180 },
      wires: [],
      ports: [],
    };
    const viewport = render(false, undefined, () => responsiveLayout);
    expect(cameraOf(viewport)).toEqual({ x: 300, y: 220, scale: 1 });
    act(() => {
      viewport.focus();
      viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true, cancelable: true }));
    });
    expect(cameraOf(viewport)).toEqual({ x: 300, y: 220, scale: 1 });
  });

  it("restores a supplied camera without fitting the view", () => {
    const viewport = render(false, { x: 123, y: 234, scale: 1.2 });
    expect(cameraOf(viewport)).toEqual({ x: 123, y: 234, scale: 1.2 });
  });
  it("keeps a group grid aligned with the origin when the viewport grows", () => {
    const viewport = render(false, { x: 0, y: 0, scale: 1 }, undefined, "origin");
    expect(cameraOf(viewport)).toEqual({ x: 0, y: 0, scale: 1 });
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 900 },
    });
    act(() => TestResizeObserver.latest?.callback([], TestResizeObserver.latest as unknown as ResizeObserver));
    expect(cameraOf(viewport)).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("applies keyboard controls only when the viewport itself is focused and cleans observers", () => {
    const viewport = render();
    const before = cameraOf(viewport);
    act(() =>
      viewport
        .querySelector("button")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(cameraOf(viewport)).toEqual(before);
    act(() => {
      viewport.focus();
      viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(cameraOf(viewport).x).toBe(before.x - 40);
    act(() =>
      viewport.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", isComposing: true, bubbles: true, cancelable: true }),
      ),
    );
    expect(cameraOf(viewport).x).toBe(before.x - 40);
    expect(TestResizeObserver.latest?.observed).toBe(viewport);
    act(() => root.unmount());
    expect(TestResizeObserver.latest?.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not handle camera input during an active write", () => {
    const viewport = render(true);
    const before = cameraOf(viewport);
    const wheel = new WheelEvent("wheel", { deltaY: 80, cancelable: true, bubbles: true });
    act(() => viewport.dispatchEvent(wheel));
    act(() => {
      viewport.focus();
      viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
      viewport.dispatchEvent(pointer("pointerdown", 1, 200, 200));
      viewport.dispatchEvent(pointer("pointermove", 1, 220, 200));
    });
    expect(cameraOf(viewport)).toEqual(before);
    expect(wheel.defaultPrevented).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });
});
