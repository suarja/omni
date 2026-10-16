// @vitest-environment jsdom
import { act } from "react";
import { expect, test, vi } from "vitest";

import { SkillCopiesSheet } from "../../src/renderer/canvas/SkillCopiesSheet";
import { skillVariantDestinations } from "../../src/renderer/canvas/skill-variant-destinations";
import { resourceFixture, snapshot } from "../fixtures/resource-catalogue";
import { group, locationA, node, render } from "./skill-copy-comparison-fixtures";

function snapshotWithObservedOmni(): typeof snapshot {
  const roots = snapshot.roots.map((root) => {
    if (
      root.entry.kind !== "source" ||
      root.entry.id !== resourceFixture.sourceRef.id ||
      root.evidence.status !== "observed"
    )
      return root;
    const packages = [
      ...(root.evidence.observation.inventory.packages ?? []),
      {
        id: "omni-tools",
        relativeRoot: "packages/tools",
        displayName: "Tools",
        format: "omni" as const,
        manifestPaths: ["packages/tools/omni.plugin.json"],
        artifactIds: [],
      },
    ];
    return {
      ...root,
      evidence: {
        ...root.evidence,
        observation: { ...root.evidence.observation, inventory: { ...root.evidence.observation.inventory, packages } },
      },
    };
  });
  return { ...snapshot, roots };
}

test("unmanaged copies route variant capture through the unified manager", async () => {
  const omni = snapshotWithObservedOmni();
  expect(skillVariantDestinations(omni)).toEqual([
    {
      sourceId: "source-one",
      sourceName: "Personal Skills",
      packageId: "omni-tools",
      packageName: "Tools",
    },
  ]);
  const rendered = render(
    <SkillCopiesSheet
      api={null}
      group={group}
      initialTab="metadata"
      node={node}
      onCompare={() => undefined}
      onClose={() => undefined}
      onEnsureGrant={async () => "grant"}
      snapshot={omni}
    />,
  );
  try {
    expect(rendered.container.querySelector('select[aria-label="Personal source and plugin"]')).toBeNull();
    expect(rendered.container.querySelector('input[aria-label="New skill key"]')).toBeNull();
    expect(rendered.container.textContent).toContain("Compare and manage");
  } finally {
    act(() => rendered.root.unmount());
  }
});
