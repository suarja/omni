import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RegistryIpcServices } from "../../src/main/registry-ipc";
import type { SkillManagedResolutionRequest } from "../../src/shared/skill-reconciliation-request";
import { handlers } from "../ipc/apply-ipc-helpers";
import {
  sourcePackage,
  sourceSkill,
  projectSkill,
  seedFixture,
  observedSkillId,
  registerOperations,
} from "../integration/skill-adoption-fixture";

afterEach(() => vi.resetModules());

async function adoptedFixture() {
  const fixture = await seedFixture();
  const skillId = await observedSkillId(fixture);
  await registerOperations(fixture);
  const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
  const adoption = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
    {},
    {
      intent: {
        kind: "reconcile",
        request: {
          choice: "adopt-exact",
          skillId,
          source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
          locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
        },
      },
    },
  )) as { status: string; intentId: string; effectFingerprint: string };
  expect(adoption.status).toBe("ready");
  const applied = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
    {},
    { intentId: adoption.intentId, effectFingerprint: adoption.effectFingerprint },
  )) as { status: string };
  expect(applied.status).toBe("applied");
  return { fixture, skillId };
}

describe("readSkillResolutionSnapshot", () => {
  it("refuses a managed resolution whose source is now a storefront", async () => {
    const { fixture, skillId } = await adoptedFixture();
    const { readSkillResolutionSnapshot } = await import("../../src/main/skill-management/resolution-reader");
    const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
    const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
    const { createSkillBaseStore } = await import("../../src/main/skill-reconciliation/bases");
    const registry: RegistryIpcServices = {
      ...fixture.registry,
      listRegistry: async () => {
        const view = await fixture.registry.listRegistry();
        if (view.status !== "ready") return view;
        return {
          ...view,
          registry: {
            ...view.registry,
            sources: view.registry.sources.map((source) => ({ ...source, role: "storefront" as const })),
          },
        };
      },
    };
    const snapshot = await readSkillResolutionSnapshot(
      {
        choice: "use-canonical",
        skillId,
        locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
      },
      {
        registry,
        relationships: createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json")),
        bindings: createBindingsStore(bindingsFilePath(fixture.userDataPath)),
        bases: createSkillBaseStore(fixture.userDataPath),
      },
    );
    expect(snapshot).toMatchObject({ status: "blocked", code: "storefront-target" });
  });
  it("reviews one exact adopted project child, managed use, Binding, immutable base and current owned source", async () => {
    const { fixture, skillId } = await adoptedFixture();
    const { readSkillResolutionSnapshot } = await import("../../src/main/skill-management/resolution-reader");
    const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
    const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
    const { createSkillBaseStore } = await import("../../src/main/skill-reconciliation/bases");
    const location = { projectId: fixture.project.id, harnessId: "codex" as const, folderPath: projectSkill };
    const request: SkillManagedResolutionRequest = { choice: "use-canonical", skillId, locations: [location] };
    const snapshot = await readSkillResolutionSnapshot(request, {
      registry: fixture.registry,
      relationships: createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json")),
      bindings: createBindingsStore(bindingsFilePath(fixture.userDataPath)),
      bases: createSkillBaseStore(fixture.userDataPath),
    });
    expect(snapshot.status).toBe("ready");
    if (snapshot.status !== "ready") return;
    expect(snapshot.use).toMatchObject({ skillId, location, bindingId: snapshot.binding.bindingId });
    expect(snapshot.binding).toMatchObject({
      projectId: fixture.project.id,
      harnessId: "codex",
      sourceId: fixture.source.id,
    });
    expect(snapshot.localTree.revision.hash).toBe(snapshot.sourceTree?.revision.hash);
    expect(snapshot.base.revision.hash).toBe(snapshot.localTree.revision.hash);
  });

  it("allows record-only Keep local while the linked source is unavailable and blocks canonical replacement", async () => {
    const { fixture, skillId } = await adoptedFixture();
    const { readSkillResolutionSnapshot } = await import("../../src/main/skill-management/resolution-reader");
    const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
    const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
    const { createSkillBaseStore } = await import("../../src/main/skill-reconciliation/bases");
    const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
    const bindings = createBindingsStore(bindingsFilePath(fixture.userDataPath));
    const bases = createSkillBaseStore(fixture.userDataPath);
    const original = fixture.registry;
    const offlineRegistry = {
      issue: (...values: Parameters<RegistryIpcServices["issue"]>) => original.issue(...values),
      get: (...values: Parameters<RegistryIpcServices["get"]>) => original.get(...values),
      getGrantForEntry: (...values: Parameters<RegistryIpcServices["getGrantForEntry"]>) =>
        original.getGrantForEntry(...values),
      listRegistry: async () => {
        const view = await original.listRegistry();
        if (view.status !== "ready") return view;
        return { ...view, registry: { ...view.registry, sources: [] } };
      },
      observeEntryWithGrant: (...values: Parameters<RegistryIpcServices["observeEntryWithGrant"]>) =>
        original.observeEntryWithGrant(...values),
    } as RegistryIpcServices;
    const location = { projectId: fixture.project.id, harnessId: "codex" as const, folderPath: projectSkill };
    const dependencies = { registry: offlineRegistry, relationships, bindings, bases };
    const keepLocal = await readSkillResolutionSnapshot(
      { choice: "keep-local", skillId, locations: [location] },
      dependencies,
    );
    expect(keepLocal.status).toBe("ready");
    if (keepLocal.status === "ready") expect(keepLocal).not.toHaveProperty("sourceTree");
    expect(
      await readSkillResolutionSnapshot({ choice: "use-canonical", skillId, locations: [location] }, dependencies),
    ).toMatchObject({ status: "needs-input", code: "source-unavailable" });
  });

  it("withholds review when the immutable managed base is missing", async () => {
    const { fixture, skillId } = await adoptedFixture();
    const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
    const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
    const { createSkillBaseStore } = await import("../../src/main/skill-reconciliation/bases");
    const { readSkillResolutionSnapshot } = await import("../../src/main/skill-management/resolution-reader");
    const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
    const saved = await relationships.read();
    if (saved.status !== "ready") throw new Error("The relationship store was unavailable.");
    const baseId = saved.state.uses[0]!.baseRevisionId;
    await rm(join(fixture.userDataPath, "omni/skill-bases", baseId), { recursive: true, force: true });
    const location = { projectId: fixture.project.id, harnessId: "codex" as const, folderPath: projectSkill };
    const result = await readSkillResolutionSnapshot(
      { choice: "keep-local", skillId, locations: [location] },
      {
        registry: fixture.registry,
        relationships,
        bindings: createBindingsStore(bindingsFilePath(fixture.userDataPath)),
        bases: createSkillBaseStore(fixture.userDataPath),
      },
    );
    expect(result).toMatchObject({ status: "needs-input", code: "base-unavailable" });
  });
});
