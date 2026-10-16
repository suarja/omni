import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { BINDINGS_IPC_CHANNELS } from "../../src/shared/bindings-ipc";
import {
  applyPreview,
  applyRun,
  handlers,
  removePreview,
  removeRun,
  restorePreview,
  restoreRun,
  root,
  run,
  saveBindings,
  type Binding,
  type Handler,
} from "./apply-ipc-helpers";

async function createProjects(): Promise<Parameters<typeof applyPreview>[0][]> {
  const userDataPath = await root("maintenance-data");
  const sourceRoot = await root("maintenance-source");
  const projectRoots = [await root("maintenance-first"), await root("maintenance-second")];
  await mkdir(join(sourceRoot, "packages/tools/skills/demo"), { recursive: true });
  await writeFile(join(sourceRoot, "packages/tools/skills/demo/SKILL.md"), "v1\n");
  for (const projectRoot of projectRoots) await run("git", ["init", "-q", projectRoot]);
  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => userDataPath) },
    dialog: { showOpenDialog: vi.fn() },
    ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  }));
  const paths = [...projectRoots];
  const registry = await import("../../src/main/registry-ipc");
  const grants = registry.registerRegistryIpcHandlers(() => undefined, {
    userDataPath,
    directoryPicker: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [paths.shift()!] })) },
  });
  const sourceResult = await grants.registerSourceByPath(sourceRoot, "Personal");
  if (sourceResult.status !== "ready") throw new Error("Maintenance source could not be registered.");
  const bindings = await import("../../src/main/bindings-ipc");
  bindings.registerBindingsIpcHandlers(() => undefined, grants, { userDataPath });
  const apply = await import("../../src/main/apply-ipc");
  apply.registerApplyIpcHandlers(() => undefined, grants, { userDataPath });
  const projects: Parameters<typeof applyPreview>[0][] = [];
  for (const [index, projectRoot] of projectRoots.entries()) {
    const result = (await handlers.get("omni:registry:register-project")!({}, {})) as {
      status: string;
      entry: { ref: { id: string } };
      grantHandle: string;
    };
    expect(result.status).toBe("ready");
    const projectGrant = grants.get(result.grantHandle);
    if (!projectGrant) throw new Error("Maintenance project grant is unavailable.");
    const binding: Binding = {
      bindingId: `maintenance-${index}-claude-code`,
      sourceId: sourceResult.entry.ref.id,
      packageId: "packages/tools",
      artifactPath: "skills/demo",
      kind: "skill",
      projectId: result.entry.ref.id,
      harnessId: "claude-code",
      boundHash: "0".repeat(64),
      createdAt: "2026-10-03T00:00:00.000Z",
    };
    projects.push({
      userDataPath,
      sourceRoot,
      projectRoot,
      source: { id: sourceResult.entry.ref.id, grantHandle: sourceResult.grantHandle },
      project: { id: result.entry.ref.id, grantHandle: result.grantHandle },
      binding,
      projectGrant,
    });
  }
  return projects;
}

it("updates two projects, preserves a local conflict, and restores update and removal independently", async () => {
  const [first, second] = await createProjects();
  const projectBindings = [first, second].flatMap(({ binding }, index) => [
    binding,
    { ...binding, bindingId: `maintenance-${index}-codex`, harnessId: "codex" as const },
  ]);
  await saveBindings(projectBindings);
  for (const project of [first, second]) {
    expect((await applyRun((await applyPreview(project)).planId)).status).toBe("applied");
  }

  const localPath = join(second.projectRoot, ".agents/skills/demo/SKILL.md");
  await writeFile(localPath, "local owner edit\n");
  await writeFile(join(first.sourceRoot, "packages/tools/skills/demo/SKILL.md"), "v2\n");
  const secondPreview = await applyPreview(second);
  expect(secondPreview.actions).toEqual(
    expect.arrayContaining([expect.objectContaining({ state: "conflict", needsResolution: true })]),
  );
  expect((await applyRun(secondPreview.planId)).status).toBe("blocked");
  expect(await readFile(join(second.projectRoot, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("v1\n");
  expect(await readFile(localPath, "utf8")).toBe("local owner edit\n");

  const firstUpdate = await applyRun((await applyPreview(first)).planId);
  expect(firstUpdate.status).toBe("applied");
  expect(firstUpdate.receipt.files).toHaveLength(2);
  const secondUpdate = await applyRun((await applyPreview(second, [second.binding.bindingId])).planId);
  expect(secondUpdate.status).toBe("applied");
  expect(secondUpdate.receipt.files).toHaveLength(1);
  expect(secondUpdate.receipt.project.id).toBe(second.project.id);
  expect(firstUpdate.receipt.project.id).toBe(first.project.id);
  for (const project of [first, second]) {
    expect(await readFile(join(project.projectRoot, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("v2\n");
  }

  expect((await restoreRun((await restorePreview(firstUpdate.receipt.operationId)).planId)).status).toBe("applied");
  expect(await readFile(join(first.projectRoot, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("v1\n");
  expect(await readFile(join(first.projectRoot, ".agents/skills/demo/SKILL.md"), "utf8")).toBe("v1\n");
  expect(await readFile(join(second.projectRoot, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("v2\n");

  const removed = await removeRun((await removePreview(second)).planId);
  expect(removed.status).toBe("applied");
  await expect(readFile(join(second.projectRoot, ".claude/skills/demo/SKILL.md"))).rejects.toThrow();
  expect((await restoreRun((await restorePreview(removed.receipt.operationId)).planId)).status).toBe("applied");
  expect(await readFile(join(second.projectRoot, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("v2\n");
  expect(await readFile(localPath, "utf8")).toBe("local owner edit\n");
  const result = (await handlers.get(BINDINGS_IPC_CHANNELS.list)!({}, {})) as { bindings: readonly Binding[] };
  expect(result.bindings.map(({ bindingId }) => bindingId).sort()).toEqual(
    projectBindings.map(({ bindingId }) => bindingId).sort(),
  );
});
