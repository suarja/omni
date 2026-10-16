// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createResourceCatalogue, type ResourceRecord } from "../../src/domain/resource-catalogue";
import { CanvasSearch } from "../../src/renderer/canvas/CanvasSearch";
import { I18nProvider } from "../../src/renderer/i18n";
import { snapshot } from "../fixtures/resource-catalogue";

describe("canvas search keyboard selection", () => {
  let root: Root;
  let container: HTMLDivElement;
  const records = createResourceCatalogue(snapshot).search("review");
  let select: ReturnType<typeof vi.fn<(record: ResourceRecord) => void>>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    select = vi.fn();
  });
  afterEach(() => act(() => root.unmount()));

  function render(items: readonly ResourceRecord[] = records): void {
    act(() =>
      root.render(
        <I18nProvider initialLanguage="en">
          <CanvasSearch records={items} onSelect={select} onClose={vi.fn()} />
        </I18nProvider>,
      ),
    );
  }
  function press(key: string, isComposing = false): void {
    act(() =>
      container
        .querySelector("input")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key, isComposing, bubbles: true, cancelable: true })),
    );
  }

  it("selects qualified resources with arrows and Enter while focus stays in the input", () => {
    render();
    const input = container.querySelector("input");
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain(records[0].relativePath);
    press("ArrowDown");
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain(records[1].relativePath);
    expect(document.activeElement).toBe(input);
    press("ArrowUp");
    press("Enter");
    expect(select).toHaveBeenCalledWith(records[0]);
    press("ArrowDown");
    press("Enter");
    expect(select).toHaveBeenLastCalledWith(records[1]);
  });

  it("keeps selection valid when results disappear and does not submit an empty search", () => {
    render();
    press("ArrowDown");
    render(records.slice(0, 1));
    press("Enter");
    expect(select).toHaveBeenLastCalledWith(records[0]);
    select.mockClear();
    render([]);
    press("ArrowDown");
    press("Enter");
    expect(select).not.toHaveBeenCalled();
    expect(container.querySelector("input")?.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("does not open a resource while the user is composing text", () => {
    render();
    press("Enter", true);
    expect(select).not.toHaveBeenCalled();
  });
});
