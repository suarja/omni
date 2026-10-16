// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resourceFixture, snapshot } from "../fixtures/resource-catalogue";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { I18nProvider } from "../../src/renderer/i18n";

describe("resizable resource sheets", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { value: vi.fn(), configurable: true });
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { value: () => false, configurable: true });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { value: vi.fn(), configurable: true });
    container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={{
              readArtifact: vi.fn(async () => ({
                status: "read" as const,
                content: "# Real document",
                byteLength: 15,
                truncated: false,
              })),
            }}
            context={{ kind: "entry", entry: resourceFixture.sourceRef }}
            onEnsureGrant={vi.fn(async () => "grant")}
            onNavigate={vi.fn()}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
            snapshot={snapshot}
          />
        </I18nProvider>,
      ),
    );
    click('button[aria-label="Information for pstack"]');
    if (handle()) key("Home");
  });
  afterEach(() => {
    if (handle()) key("Home");
    act(() => root.unmount());
    vi.restoreAllMocks();
  });
  function click(selector: string): void {
    act(() => container.querySelector<HTMLButtonElement>(selector)?.click());
  }
  function handle(): HTMLElement | null {
    return container.querySelector('[role="separator"][aria-label="Resize sheet"]');
  }
  function key(value: string): void {
    act(() => handle()?.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
  }
  function width(): number {
    return Number(handle()?.getAttribute("aria-valuenow"));
  }
  function pointer(type: string, clientX: number, pointerId = 1, button = 0): void {
    const event = new MouseEvent(type, { clientX, button, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    act(() => handle()?.dispatchEvent(event));
  }

  it("opens details at a wider default with a keyboard accessible left edge", () => {
    expect(handle()).not.toBeNull();
    expect(width()).toBe(520);
    expect(handle()?.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle()?.tabIndex).toBe(0);
    expect(document.activeElement).toBe(container.querySelector(".canvas-sheet-header button"));
  });
  it("widens towards the canvas with Left and narrows with Right", () => {
    key("ArrowLeft");
    expect(width()).toBe(544);
    key("ArrowRight");
    expect(width()).toBe(520);
  });
  it("preserves modified arrow shortcuts for navigation", () => {
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true });
    act(() => handle()?.dispatchEvent(event));
    expect(width()).toBe(520);
    expect(event.defaultPrevented).toBe(false);
  });
  it("keeps the chosen width when the same sheet is closed and reopened", () => {
    key("ArrowLeft");
    click(".canvas-sheet-header button");
    click('button[aria-label="Information for pstack"]');
    expect(width()).toBe(544);
  });
  it("bounds dragging and stops accepting pointer movement when released", () => {
    expect(handle()).not.toBeNull();
    const capture = vi.fn();
    Object.defineProperty(handle(), "setPointerCapture", { value: capture, configurable: true });
    Object.defineProperty(handle(), "hasPointerCapture", { value: () => false, configurable: true });
    pointer("pointerdown", 1060);
    pointer("pointermove", 900);
    expect(width()).toBe(680);
    expect(capture).toHaveBeenCalledWith(1);
    pointer("pointermove", -2000);
    expect(width()).toBe(800);
    pointer("pointermove", 2000);
    expect(width()).toBe(320);
    pointer("pointerup", 2000);
    pointer("pointermove", 900);
    expect(width()).toBe(320);
  });
  it("ignores secondary buttons and pointers outside the active drag", () => {
    expect(handle()).not.toBeNull();
    Object.defineProperty(handle(), "setPointerCapture", { value: vi.fn(), configurable: true });
    pointer("pointerdown", 1000, 1, 2);
    pointer("pointermove", 500);
    expect(width()).toBe(520);
    pointer("pointerdown", 1000);
    pointer("pointermove", 500, 2);
    expect(width()).toBe(520);
    pointer("pointercancel", 1000);
    pointer("pointermove", 500);
    expect(width()).toBe(520);
  });
  it("restores the default width with Home or a double click", () => {
    key("End");
    expect(width()).toBe(800);
    key("Home");
    expect(width()).toBe(520);
    key("ArrowLeft");
    act(() => handle()?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(width()).toBe(520);
  });
  it("disables resizing on a narrow window and restores the desktop preference", () => {
    key("End");
    act(() => {
      Object.defineProperty(window, "innerWidth", { value: 900, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(width()).toBe(620);
    act(() => {
      Object.defineProperty(window, "innerWidth", { value: 320, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(handle()?.hidden).toBe(true);
    expect(handle()?.tabIndex).toBe(-1);
    key("ArrowLeft");
    act(() => {
      Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(width()).toBe(800);
    expect(handle()?.hidden).toBe(false);
  });
  it("opens the document with its own wider default", async () => {
    const documentButton = [...container.querySelectorAll<HTMLButtonElement>(".canvas-sheet-tabs button")].find(
      (button) => button.textContent === "Document",
    );
    await act(async () => documentButton?.click());
    expect(width()).toBe(520);
    expect(container.querySelector(".canvas-document h1")?.textContent).toBe("Real document");
  });
});
