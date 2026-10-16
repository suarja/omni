// @vitest-environment jsdom
import { act } from "react";
import { expect, test } from "vitest";
import { CopyManagementEffects } from "../../src/renderer/canvas/changes/CopyManagementEffects";
import type { SkillPreview } from "../../src/shared/skill-management-ipc";
import { locationA, render, snapshot, skillId } from "./skill-copy-comparison-fixtures";

test("effects show the target once and keep hashes behind closed Details", () => {
  const source = { sourceId: "source-one", packageId: "package-one", artifactPath: "skills/review" };
  const revision = { algorithm: "omni-tree-v1" as const, hash: "b".repeat(64), files: [] };
  const preview: SkillPreview = {
    status: "ready",
    intentId: "intent",
    planId: "plan",
    effectFingerprint: "a".repeat(64),
    scope: { targets: [] },
    steps: [
      {
        stepId: "step",
        scope: { targets: [] },
        bindingEffects: [],
        plan: {
          planId: "plan",
          kind: "link-skill",
          displayTarget: locationA.folderPath,
          actions: [],
          git: { mode: "disabled", warnings: [] },
        },
        files: [
          {
            rootId: locationA.projectId,
            relativePath: `${locationA.folderPath}/notes.md`,
            change: "change",
            beforeHash: "b".repeat(64),
            afterHash: "c".repeat(64),
            diff: "@@ -1 +1 @@\n-local\n+canonical\n",
          },
        ],
        unboundResolutionEvidence: {
          choice: "link-canonical",
          skillId,
          storeRevision: 1,
          record: { skillId, label: "review", evidence: "observed-equivalence", locations: [locationA] },
          source: { ref: source, rootIdentity: "d".repeat(64), revision },
          local: { location: locationA, rootIdentity: "e".repeat(64), revision },
          priorManagement: { use: "absent", binding: "absent", base: "unknown" },
        },
      },
    ],
  };
  const rendered = render(
    <CopyManagementEffects
      action="link"
      target={locationA}
      snapshot={snapshot}
      projectName="Project"
      source={source}
      preview={preview}
      error={null}
      busy={false}
      localNoWrite={false}
      restoreReview={false}
      reviewCurrent={true}
    />,
  );
  try {
    expect(
      [...rendered.container.querySelectorAll("dt")].filter((x) => x.textContent === "Selected project copy"),
    ).toHaveLength(1);
    const hash = [...rendered.container.querySelectorAll("code")].find((x) => x.textContent?.startsWith("bbbb"));
    expect(hash).toBeDefined();
    expect(hash!.closest("details")?.open).toBe(false);
    expect(rendered.container.textContent).toContain("canonical");
    expect(rendered.container.textContent).toContain("local");
  } finally {
    act(() => rendered.root.unmount());
  }
});
