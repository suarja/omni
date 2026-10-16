// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { LoadingItem } from "../../src/renderer/components/ui/LoadingItem";

const uiStyles = readFileSync("src/renderer/components/ui/ui.css", "utf8");

function render(element: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => root.render(element));
  return { container, root };
}

describe("LoadingItem (D2)", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
  });

  it("renders a dim row with the caller's localized label", () => {
    rendered = render(<LoadingItem label="Chargement…" />);
    const item = rendered.container.querySelector(".ui-item");
    expect(item?.classList.contains("ui-item--dim")).toBe(true);
    expect(item?.classList.contains("ui-loading-item")).toBe(true);
    expect(item?.textContent).toBe("Chargement…");
  });

  it("is not clickable and carries no chevron", () => {
    rendered = render(<LoadingItem label="Loading…" />);
    const item = rendered.container.querySelector(".ui-item");
    expect(item?.tagName).toBe("DIV");
    expect(rendered.container.querySelector(".ui-item__chevron")).toBeNull();
  });

  it("exposes a stable data-testid for hosts to assert against", () => {
    rendered = render(<LoadingItem label="Loading…" />);
    expect(rendered.container.querySelector("[data-testid='loading-item']")).not.toBeNull();
  });

  it("pulses via a CSS animation only — no spinner, no JS timer", () => {
    expect(uiStyles).toMatch(/@keyframes ui-loading-pulse\s*\{/);
    expect(uiStyles).toContain(".ui-loading-item .ui-item__name { animation: ui-loading-pulse");
    // No spinner primitive is pulled in.
    expect(uiStyles).not.toMatch(/\.ui-loading-item[^}]*spinner/);
  });
});
