// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { Card } from "../../src/renderer/components/ui/Card";
import { ItemList, ListItem } from "../../src/renderer/components/ui/ItemList";
import * as CardModule from "../../src/renderer/components/ui/Card";

const uiStyles = readFileSync("src/renderer/components/ui/ui.css", "utf8");

function render(element: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => root.render(element));
  return { container, root };
}

describe("ItemList grammar (D1)", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    vi.restoreAllMocks();
  });

  it("removed the CardRow export: a nested row is a ListItem inside a nested ItemList", () => {
    expect((CardModule as Readonly<Record<string, unknown>>).CardRow).toBeUndefined();
    expect(Object.keys(CardModule).sort()).toEqual(["Card", "CardFoot", "CardHeader"]);
  });

  it("defaults to the standalone surface", () => {
    rendered = render(
      <ItemList>
        <ListItem name="Skill" />
      </ItemList>,
    );
    const list = rendered.container.querySelector(".ui-item-list");
    expect(list?.classList.contains("ui-item-list--nested")).toBe(false);
    expect(list?.classList.contains("ui-item-list--tree")).toBe(false);
  });

  it("marks a list nested explicitly, without requiring a Card", () => {
    rendered = render(
      <ItemList variant="nested">
        <ListItem name="Skill" />
      </ItemList>,
    );
    expect(rendered.container.querySelector(".ui-item-list--nested")).not.toBeNull();
  });

  it("nests a plain ItemList automatically inside a Card, so no host is missed", () => {
    rendered = render(
      <Card>
        <ItemList>
          <ListItem name="Skill" />
        </ItemList>
      </Card>,
    );
    // The row sits inside .ui-card .ui-item-list, which the CSS grammar (D1) always treats as
    // nested even without an explicit variant — this is the structural trigger for that rule.
    expect(rendered.container.querySelector(".ui-card .ui-item-list .ui-item")).not.toBeNull();
    expect(uiStyles).toContain(".ui-card .ui-item-list .ui-item");
  });

  it("gives a tree list an indent, a guide line, and one aligned side column per depth", () => {
    rendered = render(
      <ItemList variant="tree">
        <ListItem name="Root" />
      </ItemList>,
    );
    expect(rendered.container.querySelector(".ui-item-list--tree")).not.toBeNull();
    expect(uiStyles).toContain("padding-left: calc(20px * var(--tree-depth, 0) + 16px);");
    expect(uiStyles).toMatch(/\.ui-item-list--tree \.ui-item::before\s*\{[^}]*background: var\(--color-border\);/s);
    expect(uiStyles).toContain(".ui-item-list--tree .ui-item__side { min-width: 96px; }");
    // The old margin-left/width shrink hack is gone.
    expect(uiStyles).not.toContain("margin-left: calc(var(--tree-depth");
  });

  it("keeps nested rows flat — no border, no gradient, no radius — with a background-only hover", () => {
    rendered = render(
      <Card>
        <ItemList variant="nested">
          <ListItem name="Skill" onClick={vi.fn()} />
        </ItemList>
      </Card>,
    );
    expect(rendered.container.querySelector(".ui-item-list--nested .ui-item")?.tagName).toBe("BUTTON");
    expect(uiStyles).toMatch(/\.ui-item-list--nested \.ui-item,[\s\S]*?\{\s*padding: 12px 16px;/);
    expect(uiStyles).toContain("font-weight: var(--font-weight-medium);");
  });

  it("gives dashed, selected, and dim variants their existing classes", () => {
    rendered = render(
      <ItemList>
        <ListItem dim name="Dim" />
        <ListItem name="Selected" selected />
        <ListItem name="Dashed" variant="dashed" />
      </ItemList>,
    );
    const items = rendered.container.querySelectorAll(".ui-item");
    expect(items[0]?.classList.contains("ui-item--dim")).toBe(true);
    expect(items[1]?.classList.contains("is-selected")).toBe(true);
    expect(items[2]?.classList.contains("ui-item--dashed")).toBe(true);
  });
});
