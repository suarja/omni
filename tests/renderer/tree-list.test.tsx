// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IconWrap } from "../../src/renderer/components/ui/IconWrap";
import { TreeList, type TreeNode } from "../../src/renderer/components/ui/TreeList";

const nodes: readonly TreeNode[] = [
  {
    id: "root",
    item: { name: "Root", leading: <IconWrap name="agent" size="sm" /> },
    children: [
      {
        id: "child",
        item: { name: "Child", sub: "child command" },
        children: [{ id: "grandchild", item: { name: "Grandchild", sub: "grandchild command" } }],
      },
      { id: "sibling", item: { name: "Sibling" } },
    ],
  },
];

function render(selectedId = "root", onSelect = vi.fn()): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() =>
    root.render(<TreeList defaultExpandedDepth={2} nodes={nodes} onSelect={onSelect} selectedId={selectedId} />),
  );
  return { container, root };
}

describe("TreeList", () => {
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

  it("renders expanded nodes with depth indentation and no dividers", () => {
    rendered = render();
    expect(rendered.container.querySelectorAll("[data-tree-depth]")).toHaveLength(4);
    expect(
      rendered.container
        .querySelector("[data-testid='tree-item-grandchild']")
        ?.parentElement?.style.getPropertyValue("--tree-depth"),
    ).toBe("2");
    expect(rendered.container.querySelectorAll("hr, .ui-divider")).toHaveLength(0);
  });

  it("collapses and expands a branch with its chevron", () => {
    rendered = render();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[aria-label='Collapse child']")?.click());
    expect(rendered.container.querySelector("[data-testid='tree-item-grandchild']")).toBeNull();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[aria-label='Expand child']")?.click());
    expect(rendered.container.querySelector("[data-testid='tree-item-grandchild']")).not.toBeNull();
  });

  it("moves selection with arrow keys and collapses or expands with left and right", () => {
    const onSelect = vi.fn();
    rendered = render("root", onSelect);
    const rootItem = rendered.container.querySelector<HTMLElement>("[data-testid='tree-item-root']");
    expect(rootItem).not.toBeNull();
    act(() => rootItem?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith("child");
    act(() => rootItem?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(rendered.container.querySelector("[data-testid='tree-item-grandchild']")).not.toBeNull();
    const childItem = rendered.container.querySelector<HTMLElement>("[data-testid='tree-item-child']");
    act(() => childItem?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    act(() => childItem?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith("root");
  });
});
