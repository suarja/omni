import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Binding } from "../../src/domain/assignment-plan";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { createOperationStore } from "../../src/main/operation-store";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { hashGrantedPath } from "../../src/main/granted-hashing";
import { root } from "../ipc/apply-ipc-helpers";
import {
  claudeSkill,
  projectSkill,
  sourcePackage,
  sourceSkill,
  seedFixture,
  registerOperations,
  treeDigest,
} from "./skill-adoption-fixture";

async function fixture() {
  const seeded = await seedFixture();
  const hashed = await hashGrantedPath(seeded.projectGrant, projectSkill);
  if (hashed.status !== "hashed") throw new Error("Ownership evidence is unavailable.");
  const binding = {
    bindingId: "legacy-codex",
    sourceId: seeded.source.id,
    packageId: sourcePackage,
    artifactPath: sourceSkill,
    kind: "skill" as const,
    projectId: seeded.project.id,
    harnessId: "codex" as const,
    boundHash: hashed.contentHash,
    ownedHash: hashed.contentHash,
    createdAt: "1970-01-01T00:00:00.000Z",
  };
  const bindings = createBindingsStore(bindingsFilePath(seeded.userDataPath));
  const relationships = createSkillRelationshipStore(join(seeded.userDataPath, "omni", "skill-relationships.json"));
  const history = createOperationStore(join(seeded.userDataPath, "omni", "operations.json"));
  return { ...seeded, binding, bindingStore: bindings, relationships, history };
}

describe("legacy Binding compatibility at startup", () => {
  it("normalizes old and new references, skips inaccessible and contradictory locations, and keeps other copies managed", async () => {
    const f = await fixture();
    const secondRoot = await root("bridge-valid");
    const second = await f.registerProjectRoot(secondRoot);
    await cp(join(f.projectRoot, projectSkill), join(secondRoot, projectSkill), { recursive: true });
    await cp(join(f.projectRoot, claudeSkill), join(secondRoot, claudeSkill), { recursive: true });
    const missingRoot = await root("bridge-missing");
    const missing = await f.registerProjectRoot(missingRoot);
    await rm(missingRoot, { recursive: true });
    const otherPackage = "plugins/other";
    await mkdir(join(f.sourceRoot, otherPackage, sourceSkill), { recursive: true });
    await cp(join(f.sourceRoot, sourcePackage, sourceSkill), join(f.sourceRoot, otherPackage, sourceSkill), {
      recursive: true,
    });
    await writeFile(
      join(f.sourceRoot, otherPackage, "omni.plugin.json"),
      JSON.stringify({ format: "omni.plugin/1", id: "other", name: "Other", version: "0.1.0", artifacts: [] }),
    );
    const manifestPath = join(f.sourceRoot, "omni.marketplace.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.packages.push({ path: otherPackage });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const oldClaude = { ...f.binding, bindingId: "old-claude", harnessId: "claude-code" as const };
    const bindings: Binding[] = [
      { ...f.binding, packageId: "tools" },
      oldClaude,
      {
        ...oldClaude,
        bindingId: "new-claude",
        artifactPath: `${sourcePackage}/${sourceSkill}/SKILL.md`,
        createdAt: "2026-10-11T00:00:00.000Z",
      },
      { ...f.binding, bindingId: "second-codex", projectId: second.id },
      { ...oldClaude, bindingId: "second-claude", projectId: second.id },
      { ...oldClaude, bindingId: "real-conflict", projectId: second.id, packageId: otherPackage },
      { ...oldClaude, bindingId: "missing-old", projectId: missing.id },
      {
        ...oldClaude,
        bindingId: "missing-new",
        projectId: missing.id,
        artifactPath: `${sourcePackage}/${sourceSkill}/SKILL.md`,
      },
      { ...f.binding, bindingId: "missing-package", packageId: "gone", artifactPath: "skills/gone" },
      { ...f.binding, bindingId: "missing-skill", artifactPath: "skills/removed" },
    ];
    await f.bindingStore.save(bindings);
    const before = await treeDigest(f.projectRoot);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const operations = await registerOperations(f, f.history);
    const state = await f.relationships.read();
    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("Relationships are unavailable.");
    expect(state.state.uses).toHaveLength(3);
    expect(state.state.skills).toHaveLength(2);
    expect(
      state.state.uses.every(({ source }) => source.packageId === sourcePackage && source.artifactPath === sourceSkill),
    ).toBe(true);
    expect(await treeDigest(f.projectRoot)).toEqual(before);
    expect(await f.bindingStore.read()).toMatchObject({ bindings });
    const diagnostic = operations.skillManagement.readLegacyBridgeDiagnostic?.();
    expect(diagnostic).toMatchObject({ linkedCopies: 3, duplicateBindings: 1 });
    expect(diagnostic?.skippedLocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: expect.objectContaining({ projectId: missing.id }),
          code: "project-unavailable",
        }),
        expect.objectContaining({
          location: expect.objectContaining({ projectId: second.id, harnessId: "claude-code" }),
          code: "source-conflict",
        }),
        expect.objectContaining({ code: "package-unavailable", bindingIds: ["missing-package"] }),
        expect.objectContaining({ code: "skill-unavailable", bindingIds: ["missing-skill"] }),
      ]),
    );
    expect(log).toHaveBeenCalled();
    await writeFile(join(f.sourceRoot, sourcePackage, sourceSkill, "notes.md"), "Current source.\n");
    const preview = await operations.skillManagement.preview(
      {
        kind: "maintain-current",
        source: { sourceId: f.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
      },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Propagation preview is unavailable.");
    expect(preview.propagation?.targets.map(({ state }) => state)).toEqual(["eligible", "eligible", "eligible"]);
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result.status, JSON.stringify(result.issues)).toBe("applied");
    for (const [projectRoot, folder] of [
      [f.projectRoot, projectSkill],
      [f.projectRoot, claudeSkill],
      [secondRoot, projectSkill],
    ])
      expect(await readFile(join(projectRoot!, folder!, "notes.md"), "utf8")).toBe("Current source.\n");
    const inverse = await operations.skillManagement.preview(
      { kind: "restore", operationId: result.operationId },
      { kind: "desktop" },
    );
    expect(inverse.status).toBe("ready");
    if (inverse.status !== "ready") throw new Error("Propagation restore is unavailable.");
    expect(
      (
        await operations.skillManagement.apply(inverse.intentId, {
          kind: "desktop",
          effectFingerprint: inverse.effectFingerprint,
          approvedAt: new Date().toISOString(),
        })
      ).status,
    ).toBe("restored");
    expect(await treeDigest(f.projectRoot)).toEqual(before);
    const restoredBindings = await f.bindingStore.read();
    const byId = (a: Binding, b: Binding): number => a.bindingId.localeCompare(b.bindingId);
    expect(restoredBindings.status === "ready" && [...restoredBindings.bindings].sort(byId)).toEqual(
      [...bindings].sort(byId),
    );
    await operations.skillManagement.initialize();
    const again = await f.relationships.read();
    expect(again.status === "ready" && again.state.uses.length).toBe(3);
    const history = await f.history.read();
    expect(
      history.status === "ready" && history.receipts.filter(({ kind }) => kind === "bridge-skill-uses").length,
    ).toBe(1);
    log.mockRestore();
  });

  it("keeps initialization and skill management available when the bridge history cannot be read", async () => {
    const f = await fixture();
    await f.bindingStore.save([f.binding]);
    const history = {
      ...f.history,
      async read() {
        return { status: "corrupt" as const, diagnostic: "Unreadable history", recoveryAvailable: false };
      },
    };
    const operations = await registerOperations(f, history);
    expect(operations.skillManagement.readLegacyBridgeDiagnostic?.()?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "history-unavailable" })]),
    );
    expect(await operations.skillManagement.listRecoveries()).toEqual([]);
    const preview = await operations.skillManagement.preview(
      {
        kind: "maintain-current",
        source: { sourceId: f.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
      },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
  });
  it.each(["project-archived", "project-inaccessible", "source-archived"] as const)(
    "counts %s without failing initialization",
    async (reason) => {
      const f = await fixture();
      await f.bindingStore.save([f.binding]);
      const registry = {
        ...f.registry,
        async listRegistry() {
          const loaded = await f.registry.listRegistry();
          if (loaded.status !== "ready") return loaded;
          return {
            ...loaded,
            registry: {
              ...loaded.registry,
              projects: loaded.registry.projects.map((project) =>
                reason.startsWith("project-")
                  ? {
                      ...project,
                      ...(reason === "project-archived"
                        ? { archivedAt: "2026-10-11T00:00:00.000Z" }
                        : { availability: "inaccessible" as const }),
                    }
                  : project,
              ),
              sources: loaded.registry.sources.map((source) =>
                reason === "source-archived" ? { ...source, archivedAt: "2026-10-11T00:00:00.000Z" } : source,
              ),
            },
          };
        },
      };
      const operations = await registerOperations(f, f.history, undefined, registry);
      const diagnostic = operations.skillManagement.readLegacyBridgeDiagnostic?.();
      expect(diagnostic?.issues).toEqual([]);
      expect(diagnostic?.skippedLocations).toHaveLength(1);
      expect(diagnostic?.skippedLocations[0]?.code).toBe(
        reason.startsWith("project-") ? "project-unavailable" : "source-unavailable",
      );
      expect(await f.history.read()).toEqual({ status: "ready", receipts: [] });
    },
  );

  it("continues other projects when fresh access throws for one location", async () => {
    const f = await fixture();
    const secondRoot = await root("bridge-accessible");
    const second = await f.registerProjectRoot(secondRoot);
    await cp(join(f.projectRoot, projectSkill), join(secondRoot, projectSkill), { recursive: true });
    await f.bindingStore.save([f.binding, { ...f.binding, bindingId: "second-binding", projectId: second.id }]);
    const registry = {
      ...f.registry,
      async getGrantForEntry(ref: Parameters<typeof f.registry.getGrantForEntry>[0]) {
        if (ref.kind === "project" && ref.id === f.project.id) throw new Error("Project access was denied.");
        return f.registry.getGrantForEntry(ref);
      },
    };
    const operations = await registerOperations(f, f.history, undefined, registry);
    const state = await f.relationships.read();
    expect(state.status === "ready" && state.state.uses.map(({ bindingId }) => bindingId)).toEqual(["second-binding"]);
    expect(operations.skillManagement.readLegacyBridgeDiagnostic?.()?.skippedLocations).toEqual([
      expect.objectContaining({
        code: "observation-failed",
        bindingIds: [f.binding.bindingId],
        message: "Project access was denied.",
      }),
    ]);
  });
});
