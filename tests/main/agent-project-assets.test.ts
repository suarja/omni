import { describe, expect, it, vi } from "vitest";

import type { Binding } from "../../src/domain/assignment-plan";
import type { ObservedArtifact } from "../../src/domain/inventory";
import { createProjectAssetsReader } from "../../src/main/agent-gateway/router-project-assets";

const binding: Binding = {
  bindingId: "binding-one",
  sourceId: "personal",
  packageId: "design-revamp",
  artifactPath: "skills/design-bank",
  kind: "skill",
  projectId: "project-one",
  harnessId: "claude-code",
  boundHash: "hash",
  createdAt: "2026-10-03T00:00:00.000Z",
};

function artifact(relativePath: string, projectionPaths: readonly string[] = []): ObservedArtifact {
  return {
    id: relativePath,
    physicalIdentity: relativePath,
    relativePath,
    displayPath: relativePath,
    projectionPaths,
    kind: "skill",
    providerIds: [],
    scope: "project",
    confidence: "exact",
    symlinkState: "none",
  };
}

function reader(artifacts: readonly ObservedArtifact[], state: "current" | "update" | "conflict" = "current") {
  return createProjectAssetsReader({
    registry: {
      observeRegisteredEntry: vi.fn(async () => ({ status: "observed", observation: { inventory: { artifacts } } })),
    } as never,
    bindingsStore: {
      read: async () => ({
        status: "ready",
        bindings: [binding, { ...binding, bindingId: "other-project", projectId: "other" }],
      }),
    } as never,
    resolveBindingState: async () => state,
  });
}

describe("project asset classification", () => {
  it("lists the managed skill once while retaining local siblings and other harness copies", async () => {
    const read = reader([
      artifact(".claude/skills/design-bank/SKILL.md"),
      artifact(".claude/skills/design-bank-extra/SKILL.md"),
      artifact(".agents/skills/design-bank/SKILL.md"),
      artifact("local/SKILL.md"),
    ]);
    const result = await read({ projectId: "project-one" });
    expect(result.managed).toEqual([
      { bindingId: "binding-one", harness: "claude-code", artifactPath: "skills/design-bank", state: "current" },
    ]);
    expect(result.unmanaged.map((item) => item.relativePath)).toEqual([
      ".claude/skills/design-bank-extra/SKILL.md",
      ".agents/skills/design-bank/SKILL.md",
      "local/SKILL.md",
    ]);
  });

  it("retains a local conflict under its desired binding without classifying it twice", async () => {
    const result = await reader(
      [artifact(".claude/skills/design-bank/SKILL.md")],
      "conflict",
    )({ projectId: "project-one" });
    expect(result.managed[0]?.state).toBe("conflict");
    expect(result.unmanaged).toEqual([]);
  });

  it("recognizes physical inventory entries projected into a managed skill", async () => {
    const result = await reader([artifact("physical/SKILL.md", [".claude/skills/design-bank/SKILL.md"])])({
      projectId: "project-one",
    });
    expect(result.unmanaged).toEqual([]);
  });

  it("rejects an invalid project request before observation", async () => {
    await expect(reader([])({ projectId: "../outside" })).rejects.toThrow();
    await expect(reader([])({ projectId: "project-one", extra: true })).rejects.toThrow();
  });

  it("reports unavailable observations and binding state instead of empty assets", async () => {
    const read = createProjectAssetsReader({
      registry: { observeRegisteredEntry: async () => ({ status: "blocked" }) } as never,
      bindingsStore: {} as never,
      resolveBindingState: async () => "current",
    });
    await expect(read({ projectId: "project-one" })).rejects.toThrow(/observed/);
    const corrupt = createProjectAssetsReader({
      registry: {
        observeRegisteredEntry: async () => ({ status: "observed", observation: { inventory: { artifacts: [] } } }),
      } as never,
      bindingsStore: { read: async () => ({ status: "corrupt" }) } as never,
      resolveBindingState: async () => "current",
    });
    await expect(corrupt({ projectId: "project-one" })).rejects.toThrow(/Bindings/);
  });
});
