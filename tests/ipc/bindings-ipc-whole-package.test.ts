import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BINDINGS_IPC_CHANNELS } from "../../src/shared/bindings-ipc";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const roots: string[] = [];

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `omni-${prefix}-`));
  roots.push(root);
  return root;
}

async function loadFixture(): Promise<{
  sourceId: string;
  sourceGrant: string;
  projectId: string;
  projectGrant: string;
  sourceRoot: string;
  projectRoot: string;
}> {
  const userDataPath = await createRoot("whole-package-data");
  const sourceRoot = await createRoot("whole-package-source");
  const projectRoot = await createRoot("whole-package-project");
  const skillRoot = join(sourceRoot, "tools/skills/review");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "review skill\n", "utf8");
  const secondSkillRoot = join(sourceRoot, "tools/skills/plan");
  await mkdir(secondSkillRoot, { recursive: true });
  await writeFile(join(secondSkillRoot, "SKILL.md"), "plan skill\n", "utf8");
  await mkdir(join(sourceRoot, "tools/hooks"), { recursive: true });
  await writeFile(join(sourceRoot, "tools/hooks/hooks.json"), "{}\n", "utf8");

  handlers.clear();
  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => userDataPath) },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [projectRoot] })) },
    ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  }));
  const registry = await import("../../src/main/registry-ipc");
  const grants = registry.registerRegistryIpcHandlers(() => undefined, { userDataPath });
  const source = await grants.registerSourceByPath(sourceRoot, "Personal");
  if (source.status !== "ready") throw new Error("Source fixture could not be registered.");
  const project = await handlerFor("omni:registry:register-project")({}, {});
  if ((project as { status: string }).status !== "ready") throw new Error("Project fixture could not be registered.");
  const projectValue = project as { entry: { ref: { id: string } }; grantHandle: string };
  const bindingIpc = await import("../../src/main/bindings-ipc");
  bindingIpc.registerBindingsIpcHandlers(() => undefined, grants, { userDataPath });
  return {
    sourceId: source.entry.ref.id,
    sourceGrant: source.grantHandle,
    projectId: projectValue.entry.ref.id,
    projectGrant: projectValue.grantHandle,
    sourceRoot,
    projectRoot,
  };
}

function handlerFor(channel: string): Handler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}.`);
  return handler;
}

function invoke(channel: string, request: unknown = {}): Promise<unknown> {
  return handlerFor(channel)({}, request);
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("electron");
  handlers.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bindings IPC whole-package preview", () => {
  it("previews one unit per artifact and merges the actions into one plan per project", async () => {
    const fixture = await loadFixture();
    const request = {
      source: { id: fixture.sourceId, grantHandle: fixture.sourceGrant },
      packageId: "tools",
      projects: [{ projectId: fixture.projectId, grantHandle: fixture.projectGrant, harnessIds: ["claude-code"] }],
    };
    const preview = (await invoke(BINDINGS_IPC_CHANNELS.preview, request)) as {
      status: string;
      units: readonly { kind: string; artifactPath: string }[];
      plans: readonly { projectId: string; status: string; actions: readonly { kind: string; state: string }[] }[];
    };

    expect(preview.status).toBe("ready");
    expect(preview.units.map((unit) => unit.kind).sort()).toEqual(["hook", "skill", "skill"]);
    expect(preview.plans).toHaveLength(1);
    expect(preview.plans[0]?.projectId).toBe(fixture.projectId);
    // Two skills add, and the hook is always blocked (no deterministic hook target yet).
    const states = preview.plans[0]?.actions.map((action) => action.state).sort();
    expect(states).toEqual(["add", "add", "blocked"]);
    expect(JSON.stringify(preview)).not.toContain(fixture.sourceRoot);
    expect(JSON.stringify(preview)).not.toContain(fixture.projectRoot);
  });

  it("keeps the single-artifact preview unchanged when artifactPath is given", async () => {
    const fixture = await loadFixture();
    const preview = (await invoke(BINDINGS_IPC_CHANNELS.preview, {
      source: { id: fixture.sourceId, grantHandle: fixture.sourceGrant },
      packageId: "tools",
      artifactPath: "tools/skills/review/SKILL.md",
      projects: [{ projectId: fixture.projectId, grantHandle: fixture.projectGrant, harnessIds: ["claude-code"] }],
    })) as { units: readonly { kind: string; artifactPath: string }[] };
    expect(preview.units).toEqual([
      expect.objectContaining({ kind: "skill", artifactPath: "tools/skills/review/SKILL.md" }),
    ]);
  });

  it("fails safely when the package has no assignable artifacts", async () => {
    const fixture = await loadFixture();
    await expect(
      invoke(BINDINGS_IPC_CHANNELS.preview, {
        source: { id: fixture.sourceId, grantHandle: fixture.sourceGrant },
        packageId: "missing",
        projects: [],
      }),
    ).rejects.toThrow(/no assignable artifacts/i);
  });
});
