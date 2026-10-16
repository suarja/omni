import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FileWriter } from "../../src/main/operation-files";
import type { RegistryGrant } from "../../src/main/registry-ipc";
import type { RegistryIpcServices } from "../../src/main/registry-ipc";
import type { BindingsIpcServices } from "../../src/main/bindings-ipc";
import type { ApplyRestoreBridge } from "../../src/main/apply-ipc";
import { assignmentCommitMessage } from "../../src/main/apply-engine";
import { hashGrantedPath } from "../../src/main/granted-hashing";
import { createSettingsStore, settingsFilePath } from "../../src/main/settings-store";
import { APPLY_IPC_CHANNELS, parseApplyPreviewRequest, parseApplyRunRequest } from "../../src/shared/apply-ipc";
import { BINDINGS_IPC_CHANNELS } from "../../src/shared/bindings-ipc";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES } from "../../src/shared/settings-ipc";

// Real git repositories on temp roots: generous timeout so parallel workers never flake.
vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

export const run = promisify(execFile);
export type Handler = (event: unknown, request?: unknown) => Promise<unknown>;
export type Binding = Readonly<{
  bindingId: string;
  sourceId: string;
  packageId: string;
  artifactPath: string;
  kind: "skill";
  projectId: string;
  harnessId: "claude-code" | "codex";
  boundHash: string;
  ownedHash?: string;
  createdAt: string;
}>;
type Fixture = Readonly<{
  userDataPath: string;
  sourceRoot: string;
  projectRoot: string;
  source: { id: string; grantHandle: string };
  project: { id: string; grantHandle: string };
  binding: Binding;
  projectGrant: RegistryGrant;
  registry: RegistryIpcServices;
  bindings: BindingsIpcServices;
  applyRestore: ApplyRestoreBridge;
  registerProjectRoot(path: string): Promise<Readonly<{ id: string; grantHandle: string }>>;
}>;
type ApplyProjectFixture = Pick<
  Fixture,
  "userDataPath" | "sourceRoot" | "projectRoot" | "source" | "project" | "binding" | "projectGrant"
>;
type FixtureOptions = Readonly<{
  repository?: boolean;
  commitChanges?: boolean;
  singleFile?: boolean;
  fileWriter?: FileWriter;
}>;

export const handlers = new Map<string, Handler>();
const roots: string[] = [];
let nextProjectRoot: string | undefined;
export const hash = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");

export async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `omni-apply-${prefix}-`));
  roots.push(path);
  return path;
}

export function retainFixture(
  fixture: Pick<Fixture, "userDataPath" | "sourceRoot" | "projectRoot"> & Readonly<{ extraRoots?: readonly string[] }>,
): void {
  for (const path of [fixture.userDataPath, fixture.sourceRoot, fixture.projectRoot, ...(fixture.extraRoots ?? [])]) {
    const index = roots.indexOf(path);
    if (index >= 0) roots.splice(index, 1);
  }
}

export async function setup(options: FixtureOptions = {}): Promise<Fixture> {
  const userDataPath = await root("data");
  const sourceRoot = await root("source");
  const projectRoot = await root("project");
  await mkdir(join(sourceRoot, "packages/tools/skills/demo"), { recursive: true });
  await writeFile(join(sourceRoot, "packages/tools/skills/demo/SKILL.md"), "v1\n", "utf8");
  if (!options.singleFile) await writeFile(join(sourceRoot, "packages/tools/skills/demo/notes.md"), "notes\n", "utf8");
  if (options.repository !== false) await run("git", ["init", "-q", projectRoot]);

  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => userDataPath) },
    dialog: { showOpenDialog: vi.fn() },
    ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  }));
  const registry = await import("../../src/main/registry-ipc");
  const grants = registry.registerRegistryIpcHandlers(() => undefined, {
    userDataPath,
    directoryPicker: {
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [nextProjectRoot ?? projectRoot] })),
    },
  });
  const source = await grants.registerSourceByPath(sourceRoot, "Personal");
  if (source.status !== "ready") throw new Error("Source fixture could not be registered.");
  const project = await handlers.get("omni:registry:register-project")?.({}, {});
  if (!project || (project as { status: string }).status !== "ready")
    throw new Error("Project fixture could not be registered.");
  const projectValue = project as { entry: { ref: { id: string } }; grantHandle: string };
  nextProjectRoot = undefined;
  const bindings = await import("../../src/main/bindings-ipc");
  const bindingsServices = bindings.registerBindingsIpcHandlers(() => undefined, grants, { userDataPath });
  const settingsStore = createSettingsStore(settingsFilePath(userDataPath));
  if (options.commitChanges === false)
    await settingsStore.set({
      commitChanges: false,
      agents: { approval: { personalMarketplace: "conversation", projects: "omni" }, guard: { warnProjectIds: [] } },
      ai: DEFAULT_AI_SETTINGS,
      features: DEFAULT_FEATURES,
      externalLibrary: { updates: "auto" as const },
    });
  const apply = await import("../../src/main/apply-ipc");
  const applyRestore = apply.registerApplyIpcHandlers(() => undefined, grants, {
    userDataPath,
    settingsStore,
    ...(options.fileWriter ? { fileWriter: options.fileWriter } : {}),
  });
  const binding: Binding = {
    bindingId: "demo-binding",
    sourceId: source.entry.ref.id,
    packageId: "packages/tools",
    artifactPath: "skills/demo",
    kind: "skill",
    projectId: projectValue.entry.ref.id,
    harnessId: "claude-code",
    boundHash: "0".repeat(64),
    createdAt: "2026-09-13T00:00:00.000Z",
  };
  const projectGrant = grants.get(projectValue.grantHandle);
  if (!projectGrant) throw new Error("Project grant fixture could not be loaded.");
  return {
    userDataPath,
    sourceRoot,
    projectRoot,
    source: { id: source.entry.ref.id, grantHandle: source.grantHandle },
    project: { id: projectValue.entry.ref.id, grantHandle: projectValue.grantHandle },
    binding,
    projectGrant,
    registry: grants,
    bindings: bindingsServices,
    applyRestore,
    registerProjectRoot: async (path) => {
      nextProjectRoot = path;
      try {
        const response = await handlers.get("omni:registry:register-project")?.({}, {});
        if (!response || (response as { status: string }).status !== "ready")
          throw new Error("Additional project fixture could not be registered.");
        const value = response as { entry: { ref: { id: string } }; grantHandle: string };
        return { id: value.entry.ref.id, grantHandle: value.grantHandle };
      } finally {
        nextProjectRoot = undefined;
      }
    },
  };
}

export async function saveBindings(bindings: readonly Binding[]): Promise<void> {
  await handlers.get(BINDINGS_IPC_CHANNELS.save)!({}, { bindings });
}

export async function applyPreview(fixture: ApplyProjectFixture, bindingIds?: readonly string[]): Promise<any> {
  return handlers.get(APPLY_IPC_CHANNELS.preview)!(
    {},
    {
      projectId: fixture.project.id,
      grantHandle: fixture.project.grantHandle,
      sourceGrantHandle: fixture.source.grantHandle,
      ...(bindingIds ? { bindingIds } : {}),
    },
  );
}

export async function applyRun(
  planId: string,
  resolutions: readonly { actionId: string; choice: "keep-mine" | "take-marketplace" }[] = [],
): Promise<any> {
  return handlers.get(APPLY_IPC_CHANNELS.run)!({}, { planId, resolutions });
}

export async function removePreview(fixture: ApplyProjectFixture, bindingId = fixture.binding.bindingId): Promise<any> {
  return handlers.get(APPLY_IPC_CHANNELS.removePreview)!({}, { bindingId, grantHandle: fixture.project.grantHandle });
}

export async function removeRun(planId: string): Promise<any> {
  return handlers.get(APPLY_IPC_CHANNELS.removeRun)!({}, { planId });
}

export async function restorePreview(operationId: string): Promise<any> {
  return handlers.get(APPLY_IPC_CHANNELS.restorePreview)!({}, { operationId });
}

export async function restoreRun(planId: string): Promise<any> {
  return handlers.get(APPLY_IPC_CHANNELS.restoreRun)!({}, { planId });
}

export async function applyInitial(
  fixture: ApplyProjectFixture,
  bindings: readonly Binding[] = [fixture.binding],
): Promise<any> {
  await saveBindings(bindings);
  const preview = await applyPreview(fixture);
  return applyRun(preview.planId);
}

export async function projectHash(fixture: Pick<Fixture, "projectGrant">): Promise<string> {
  const result = await hashGrantedPath(fixture.projectGrant, ".");
  if (result.status !== "hashed") throw new Error("Project hash fixture could not be calculated.");
  return result.contentHash;
}

export function expectNoAbsolutePaths(value: unknown, fixture: ApplyProjectFixture): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(fixture.projectRoot);
  expect(serialized).not.toContain(fixture.sourceRoot);
  expect(serialized).not.toMatch(/(?:[" ])\/(?:private|tmp|Users)\//);
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("electron");
  handlers.clear();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
