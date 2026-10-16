import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperationStore } from "../../src/main/operation-store";
import { createWriteSkillOperations } from "../../src/main/operations-write-skill";
import { createRestoreOperations } from "../../src/main/operations-restore";
import { parseWriteSkillRequest } from "../../src/shared/operations-write-skill-ipc";
import type { GitCli } from "../../src/main/git-cli";

const roots: string[] = [];
const git: GitCli = {
  remoteUrl: async () => undefined,
  push: async () => {
    throw new Error("Unexpected push in this test.");
  },
  isGitAvailable: vi.fn(async () => true),
  isRepositoryRoot: vi.fn(async () => true),
  commitAll: vi.fn(async () => ({ status: "committed" as const, commit: "a".repeat(40) })),
  headCommit: vi.fn(async () => "b".repeat(40)),
  hasChanges: vi.fn(async () => true),
  enclosingRepository: vi.fn(),
  initAndCommit: vi.fn(),
};
const request = {
  kind: "write-skill",
  sourceId: "personal",
  mode: "create",
  folderName: "show-work",
  newPackage: { name: "build-to-show", description: "Build posts and demos from shipped work." },
  files: [
    {
      path: "SKILL.md",
      content:
        "---\nname: show-work\ndescription: Use when sharing work you just shipped.\n---\n\n# Show work\n\n1. Read the changes.\n",
    },
  ],
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "omni-t4-write-"));
  roots.push(root);
  const marketplace = join(root, "marketplace"),
    userDataPath = join(root, "data");
  const manifests = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"];
  for (const path of manifests) {
    await mkdir(join(marketplace, path, ".."), { recursive: true });
    await writeFile(
      join(marketplace, path),
      JSON.stringify({ name: "my-skills", owner: { name: "Owner" }, plugins: [] }, null, 2) + "\n",
    );
  }
  await mkdir(join(userDataPath, "omni"), { recursive: true });
  await writeFile(
    join(userDataPath, "omni/project-source-registry.json"),
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      projects: [],
      sources: [
        {
          id: "personal",
          displayName: "My skills",
          ownership: "personal",
          locator: { kind: "local-directory", canonicalPath: marketplace },
          createdAt: "2026-10-12T00:00:00.000Z",
        },
      ],
    }),
  );
  const operationStore = createOperationStore(join(userDataPath, "omni/operations.json"));
  return {
    marketplace,
    manifests,
    operations: createWriteSkillOperations({ userDataPath, operationStore, git }),
    restore: createRestoreOperations({ userDataPath, operationStore, git }),
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

it("creates a skill and described plugin in one reversible plan, synchronizing both agents", async () => {
  const { marketplace, manifests, operations, restore } = await setup();
  const before = await Promise.all(manifests.map((path) => readFile(join(marketplace, path), "utf8")));
  const preview = await operations.preview(request);
  expect(preview.status).toBe("ready");
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  await expect(stat(join(marketplace, "packages"))).rejects.toThrow();
  expect(preview.plan.notes).toContain("New plugin build-to-show: Build posts and demos from shipped work.");
  const applied = await operations.apply({ planId: preview.plan.planId });
  expect(applied?.status).toBe("applied");
  if (applied?.status !== "applied") throw new Error("Expected applied creation.");
  expect(await readFile(join(marketplace, "packages/build-to-show/skills/show-work/SKILL.md"), "utf8")).toBe(
    request.files[0]!.content,
  );
  for (const path of ["omni.plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    expect(JSON.parse(await readFile(join(marketplace, "packages/build-to-show", path), "utf8"))).toMatchObject({
      name: "build-to-show",
      description: request.newPackage.description,
    });
  }
  for (const path of manifests)
    expect(JSON.parse(await readFile(join(marketplace, path), "utf8")).plugins).toEqual([
      expect.objectContaining({
        name: "build-to-show",
        source: path.startsWith(".claude")
          ? "./packages/build-to-show"
          : { source: "local", path: "./packages/build-to-show" },
        description: request.newPackage.description,
      }),
    ]);
  expect(JSON.parse(await readFile(join(marketplace, "omni.marketplace.json"), "utf8")).packages).toContainEqual({
    path: "packages/build-to-show",
  });
  expect(git.commitAll).toHaveBeenCalledTimes(1);
  const undo = await restore.preview({ kind: "restore-import", operationId: applied.receipt.operationId });
  if (undo.status !== "ready") throw new Error(undo.diagnostic);
  expect((await restore.apply({ planId: undo.plan.planId }))?.status).toBe("applied");
  await expect(stat(join(marketplace, "packages/build-to-show"))).rejects.toThrow();
  expect(await Promise.all(manifests.map((path) => readFile(join(marketplace, path), "utf8")))).toEqual(before);
});
it("requires exactly one destination and a described new plugin in create mode", () => {
  expect(parseWriteSkillRequest(request)).toMatchObject({ newPackage: request.newPackage });
  for (const value of [
    { ...request, packageId: "packages/existing" },
    { ...request, newPackage: undefined },
    { ...request, mode: "update" },
    { ...request, newPackage: { name: "demo" } },
    { ...request, newPackage: { name: "../escape", description: "Tools" } },
  ])
    expect(() => parseWriteSkillRequest(value)).toThrow();
});
it("blocks a marketplace-wide name conflict before creating a new plugin", async () => {
  const { marketplace, operations } = await setup();
  const first = await operations.preview(request);
  if (first.status !== "ready") throw new Error(first.diagnostic);
  await operations.apply({ planId: first.plan.planId });
  const second = await operations.preview({
    ...request,
    newPackage: { ...request.newPackage, name: "another-plugin" },
  });
  expect(second).toMatchObject({ status: "blocked", reason: "skill-checks-failed" });
  await expect(stat(join(marketplace, "packages/another-plugin"))).rejects.toThrow();
});
it("preserves a new plugin destination that appeared after preview", async () => {
  const { marketplace, operations } = await setup();
  const preview = await operations.preview(request);
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  await mkdir(join(marketplace, "packages/build-to-show"), { recursive: true });
  await writeFile(join(marketplace, "packages/build-to-show/keep.txt"), "Unrelated local work\n");
  expect((await operations.apply({ planId: preview.plan.planId }))?.status).toBe("failed");
  expect(await readFile(join(marketplace, "packages/build-to-show/keep.txt"), "utf8")).toBe("Unrelated local work\n");
  await expect(stat(join(marketplace, "packages/build-to-show/omni.plugin.json"))).rejects.toThrow();
});
