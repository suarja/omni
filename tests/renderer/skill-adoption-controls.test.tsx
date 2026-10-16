// @vitest-environment jsdom
import { act } from "react";
import { expect, test, vi } from "vitest";
import { SkillCopiesSheet } from "../../src/renderer/canvas/SkillCopiesSheet";
import { snapshot as sourceSnapshot } from "../fixtures/resource-catalogue";
import { group, locationA, node, render } from "./skill-copy-comparison-fixtures";

test("the reader routes copy changes through the unified manager", async () => {
  const onCompare = vi.fn();
  const rendered = render(
    <SkillCopiesSheet
      api={null}
      group={group}
      initialTab="metadata"
      node={node}
      onCompare={onCompare}
      onClose={() => undefined}
      onEnsureGrant={async () => "grant"}
      snapshot={sourceSnapshot}
    />,
  );
  try {
    const manager = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Compare and manage",
    );
    expect(manager).toBeDefined();
    expect(rendered.container.querySelector('select[aria-label="Personal marketplace"]')).toBeNull();
    expect(rendered.container.querySelector('select[aria-label="Personal source and plugin"]')).toBeNull();
    expect(rendered.container.textContent).not.toContain("Review canonical link");
    await act(async () => manager!.click());
    expect(onCompare).toHaveBeenCalledWith(locationA, manager);
  } finally {
    act(() => rendered.root.unmount());
  }
});

test("grouping an unselected copy under a managed plugin does not claim it has a managed relationship", () => {
  const rendered = render(
    <SkillCopiesSheet
      api={null}
      group={{ ...group, category: "managed-plugin", locations: [group.locations[0]!] }}
      initialTab="metadata"
      node={node}
      onClose={() => undefined}
      onEnsureGrant={async () => "grant"}
      snapshot={sourceSnapshot}
    />,
  );
  try {
    const rows = [...rendered.container.querySelectorAll(".canvas-location-list li")];
    expect(rows.find((row) => row.textContent?.includes(".agents/skills/review"))?.textContent).toContain(
      "An explicit package relationship is recorded.",
    );
    expect(rows.find((row) => row.textContent?.includes(".claude/skills/review"))?.textContent).toContain(
      "No declared origin is recorded for this location.",
    );
  } finally {
    act(() => rendered.root.unmount());
  }
});
