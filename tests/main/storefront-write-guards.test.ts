import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWriteSkillOperations } from "../../src/main/operations-write-skill";
import { createImportOperations } from "../../src/main/operations-import";
import { createDescribePluginOperations } from "../../src/main/operations-describe-plugin";
import { createCompatibleOperations } from "../../src/main/operations-compatible";
import { createAddToProjectOperations } from "../../src/main/operations-add-to-project";
import { createOperationStore } from "../../src/main/operation-store";
import { createSettingsStore } from "../../src/main/settings-store";
import { readSkillAdoptionSnapshot } from "../../src/main/skill-management/adoption-reader";
import { readSkillPropagationSnapshot } from "../../src/main/skill-management/propagation-reader";
import { readSkillVariantSnapshot } from "../../src/main/skill-management/variant-reader";
import type { RegistryIpcServices } from "../../src/main/registry-ipc";
import type { GitCli } from "../../src/main/git-cli";
import { createRegistryView, parseRegistryState } from "../../src/domain/project-source-registry";
import { readRegisteredSource } from "../../src/main/operations-paths";

const roots: string[] = [];
const source = { sourceId: "storefront", packageId: "plugins/demo", artifactPath: "skills/demo" };
const location = { projectId: "project", harnessId: "codex", folderPath: ".agents/skills/demo" } as const;
const skillId = "11111111-1111-4111-8111-111111111111";
async function fixture() {
  const userDataPath = await realpath(await mkdtemp(join(tmpdir(), "omni-storefront-guard-")));
  roots.push(userDataPath);
  const storefront = join(userDataPath, "storefront");
  await mkdir(storefront);
  const registration = {
    id: "storefront",
    displayName: "Storefront",
    ownership: "personal",
    role: "storefront",
    locator: { kind: "local-directory", canonicalPath: storefront },
    createdAt: "2026-10-12T10:00:00.000Z",
  };
  const state = parseRegistryState({
    schemaVersion: 1,
    revision: 0,
    sources: [registration],
    projects: [
      {
        id: "project",
        displayName: "Project",
        locator: { kind: "local-directory", canonicalPath: userDataPath },
        createdAt: registration.createdAt,
      },
    ],
  });
  await mkdir(join(userDataPath, "omni"));
  await writeFile(join(userDataPath, "omni/project-source-registry.json"), JSON.stringify(state));
  const effects = vi.fn(() => {
    throw new Error("No effect may run for a storefront target.");
  });
  const git = {
    remoteUrl: effects,
    push: effects,
    isGitAvailable: effects,
    enclosingRepository: effects,
    initAndCommit: effects,
    commitAll: effects,
    hasChanges: effects,
    isRepositoryRoot: effects,
    headCommit: effects,
  } as GitCli;
  const registry = {
    listRegistry: async () => ({ status: "ready", registry: createRegistryView(state) }),
    get: effects,
    getGrantForEntry: effects,
  } as unknown as RegistryIpcServices;
  const options = {
    userDataPath,
    operationStore: createOperationStore(join(userDataPath, "omni/operations")),
    git,
    settingsStore: createSettingsStore(join(userDataPath, "omni/settings.json")),
  };
  return { userDataPath, registry, options, effects };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("storefront skill destination guards", () => {
  it.each(["write-skill", "import-capture", "describe-plugin", "make-compatible", "add-to-project"] as const)(
    "refuses %s with a typed reason before any effect",
    async (family) => {
      const f = await fixture();
      const preview =
        family === "write-skill"
          ? createWriteSkillOperations(f.options).preview({
              kind: "write-skill",
              sourceId: "storefront",
              packageId: "plugins/demo",
              mode: "create",
              folderName: "demo",
              files: [{ path: "SKILL.md", content: "# Demo\n" }],
            })
          : family === "import-capture"
            ? createImportOperations(f.registry, f.options).preview({
                kind: "import-artifact",
                source: { kind: "project", id: "project", grantHandle: "grant" },
                relativePath: ".agents/skills/demo/SKILL.md",
                target: { packageId: "plugins/demo" },
              })
            : family === "describe-plugin"
              ? createDescribePluginOperations(f.options).preview({
                  kind: "describe-plugin",
                  packageId: "plugins/demo",
                  description: "Useful tools.",
                })
              : family === "make-compatible"
                ? createCompatibleOperations(f.registry, f.options).preview({
                    kind: "make-compatible",
                    sourceId: "storefront",
                    harness: "codex",
                  })
                : createAddToProjectOperations(f.registry, {
                    ...f.options,
                    registry: f.registry,
                    importOperations: { preview: f.effects, apply: f.effects },
                    prepareCatalogue: f.effects,
                  }).preview({
                    kind: "add-to-project",
                    entry: { ownerRepo: "fixture/tools", skill: "demo" },
                    projectId: "project",
                    grantHandle: "grant",
                    harnessIds: ["codex"],
                    packageId: "plugins/demo",
                  });
      await expect(preview).resolves.toMatchObject({ status: "blocked", reason: "storefront-target" });
      expect(f.effects).not.toHaveBeenCalled();
    },
  );
  it.each(["adoption", "propagation", "variant"] as const)(
    "refuses %s before observing or capturing files",
    async (family) => {
      const f = await fixture();
      const dependencies = { registry: f.registry };
      const preview =
        family === "adoption"
          ? readSkillAdoptionSnapshot(
              { choice: "adopt-exact", skillId, source, locations: [location] },
              dependencies as Parameters<typeof readSkillAdoptionSnapshot>[1],
            )
          : family === "propagation"
            ? readSkillPropagationSnapshot(
                { kind: "maintain-current", source },
                dependencies as Parameters<typeof readSkillPropagationSnapshot>[1],
              )
            : readSkillVariantSnapshot(
                {
                  choice: "keep-variant",
                  skillId,
                  locations: [location],
                  destination: { sourceId: "storefront", packageId: "plugins/demo", skillKey: "demo-copy" },
                },
                dependencies as Parameters<typeof readSkillVariantSnapshot>[1],
              );
      await expect(preview).resolves.toMatchObject({ status: "blocked", code: "storefront-target" });
      expect(f.effects).not.toHaveBeenCalled();
    },
  );
  it("refuses storefront source ids for every registered source write lookup", async () => {
    const f = await fixture();
    await expect(readRegisteredSource(f.userDataPath, "storefront", "personal")).rejects.toMatchObject({
      code: "storefront-target",
    });
  });
});
