// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCanvasRoot,
  project,
  registryView,
  renderResourceCanvas,
  resourceSnapshot,
  setupInputs,
} from "./workspace-setup-fixtures";

describe("canvas contextual menus", () => {
  let rendered: ReturnType<typeof createCanvasRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rendered = createCanvasRoot();
    const registry = registryView([project("project-one")]);
    act(() => renderResourceCanvas(rendered.root, setupInputs({ snapshot: resourceSnapshot(registry) })));
  });

  afterEach(() => {
    act(() => rendered.root.unmount());
    vi.restoreAllMocks();
  });

  function click(selector: string): void {
    act(() => rendered.container.querySelector<HTMLButtonElement>(selector)?.click());
  }

  it("opens Add without also opening the destination menu", () => {
    click('[data-testid="canvas-setup-menu-trigger"]');
    expect(rendered.container.querySelector('[data-testid="canvas-setup-menu"]')).not.toBeNull();
    expect(rendered.container.querySelector(".canvas-overflow")).toBeNull();
    expect(rendered.container.querySelector('[data-testid="canvas-more"]')).toBeNull();
  });

  it("keeps classic destinations absent and deferred destinations off by default", () => {
    expect(rendered.container.querySelector('[data-testid="canvas-more"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="canvas-destination-library"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="canvas-destination-projects"]')).toBeNull();
    click('[data-testid="canvas-setup-menu-trigger"]');
    expect(rendered.container.querySelector('[data-testid="canvas-setup-menu"]')).not.toBeNull();
  });

  it("closes the active menu with Escape", () => {
    click('[data-testid="canvas-setup-menu-trigger"]');
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(rendered.container.querySelector('[data-testid="canvas-setup-menu"]')).toBeNull();
    expect(rendered.container.querySelector(".canvas-overflow")).toBeNull();
  });
});
