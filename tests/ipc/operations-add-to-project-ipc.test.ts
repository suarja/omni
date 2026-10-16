import { describe, expect, it } from "vitest";

import { parseAddToProjectRequest } from "../../src/shared/operations-add-to-project-ipc";
import { parsePreviewMarketplaceResponse } from "../../src/shared/operations-ipc";

describe("add-to-project operation IPC boundary", () => {
  it("accepts the composite restore operation kind", () => {
    expect(
      parsePreviewMarketplaceResponse({
        status: "ready",
        plan: {
          planId: "restore-plan",
          kind: "restore-add-to-project",
          displayTarget: "quality → ui → Demo",
          actions: [],
          git: { mode: "unavailable", warnings: [] },
        },
      }),
    ).toMatchObject({ status: "ready", plan: { kind: "restore-add-to-project" } });
  });

  it("parses one package destination and selected harnesses", () => {
    expect(
      parseAddToProjectRequest({
        kind: "add-to-project",
        entry: { ownerRepo: "anthropics/skills", skill: "frontend-design" },
        projectId: "project-one",
        grantHandle: "project-grant",
        packageId: "packages/ui",
        harnessIds: ["claude-code"],
      }),
    ).toEqual({
      kind: "add-to-project",
      entry: { ownerRepo: "anthropics/skills", skill: "frontend-design" },
      projectId: "project-one",
      grantHandle: "project-grant",
      packageId: "packages/ui",
      harnessIds: ["claude-code"],
    });
  });

  it("requires exactly one package destination and rejects duplicate harnesses", () => {
    expect(() =>
      parseAddToProjectRequest({
        kind: "add-to-project",
        entry: { ownerRepo: "anthropics/skills", skill: "frontend-design" },
        projectId: "project-one",
        grantHandle: "project-grant",
        packageId: "packages/ui",
        newPackageName: "UI",
        harnessIds: ["claude-code"],
      }),
    ).toThrow(/one package destination/i);
    expect(() =>
      parseAddToProjectRequest({
        kind: "add-to-project",
        entry: { ownerRepo: "anthropics/skills", skill: "frontend-design" },
        projectId: "project-one",
        grantHandle: "project-grant",
        newPackageName: "UI",
        harnessIds: ["claude-code", "claude-code"],
      }),
    ).toThrow(/unique/i);
    expect(() =>
      parseAddToProjectRequest({
        kind: "add-to-project",
        entry: { ownerRepo: "anthropics/skills", skill: "frontend-design" },
        projectId: "project-one",
        grantHandle: "project-grant",
        packageId: "../escape",
        harnessIds: ["claude-code"],
      }),
    ).toThrow(/safe|relative/i);
  });

  it("strictly parses the import and assignment sections of one composite plan", () => {
    expect(
      parsePreviewMarketplaceResponse({
        status: "ready",
        plan: {
          planId: "composite-plan",
          kind: "add-to-project",
          displayTarget: "frontend-design → ui → Demo",
          actions: [],
          git: { mode: "commit", warnings: [] },
          steps: [
            {
              kind: "import",
              plan: {
                planId: "import-plan",
                kind: "import-artifact",
                displayTarget: "packages/ui",
                actions: [],
                git: { mode: "commit", warnings: [] },
              },
            },
            {
              kind: "assign",
              plan: {
                projectId: "project-one",
                planId: "assignment-plan",
                status: "ready",
                actions: [],
              },
            },
          ],
        },
      }),
    ).toMatchObject({
      status: "ready",
      plan: { kind: "add-to-project", steps: [{ kind: "import" }, { kind: "assign" }] },
    });
  });
});
