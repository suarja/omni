import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BINDINGS_IPC_CHANNELS,
  parseBindingsPreviewRequest,
  parseBindingsPreviewResponse,
} from "../../src/shared/bindings-ipc";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const roots: string[] = [];
let projectPicker: ReturnType<typeof vi.fn>;

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
  unitHash: string;
}> {
  const userDataPath = await createRoot("bindings-data");
  const sourceRoot = await createRoot("bindings-source");
  const projectRoot = await createRoot("bindings-project");
  const skillRoot = join(sourceRoot, "packages/tools/skills/review");
  await mkdir(join(sourceRoot, "packages/tools/hooks"), { recursive: true });
  await writeFile(join(sourceRoot, "packages/tools/hooks/hooks.json"), "{}\n", "utf8");
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "review skill\n", "utf8");
  await writeFile(join(skillRoot, "references/note.md"), "note\n", "utf8");
  const unitHash = createHash("sha256")
    .update(
      [
        `SKILL.md:${createHash("sha256").update("review skill\n", "utf8").digest("hex")}`,
        `references/note.md:${createHash("sha256").update("note\n", "utf8").digest("hex")}`,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");

  handlers.clear();
  projectPicker = vi.fn(async () => ({ canceled: false, filePaths: [projectRoot] }));
  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => userDataPath) },
    dialog: { showOpenDialog: projectPicker },
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
    unitHash,
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

describe("bindings IPC boundary", () => {
  it("previews add, unbound-copy conflict, managed conflict, linked, and blocked without absolute paths", async () => {
    const fixture = await loadFixture();
    const request = {
      source: { id: fixture.sourceId, grantHandle: fixture.sourceGrant },
      packageId: "packages/tools",
      artifactPath: "skills/review",
      projects: [{ projectId: fixture.projectId, grantHandle: fixture.projectGrant, harnessIds: ["claude-code"] }],
    } as const;
    const preview = (await invoke(BINDINGS_IPC_CHANNELS.preview, request)) as {
      status: string;
      plans: [{ actions: [{ state: string; relativePath: string }] }];
    };
    expect(preview.plans[0].actions[0]).toMatchObject({ state: "add", relativePath: ".claude/skills/review" });
    expect(JSON.stringify(preview)).not.toContain(fixture.projectRoot);
    expect(JSON.stringify(preview)).not.toContain(fixture.sourceRoot);

    await mkdir(join(fixture.projectRoot, ".claude/skills/review/references"), { recursive: true });
    await writeFile(join(fixture.projectRoot, ".claude/skills/review/SKILL.md"), "review skill\n", "utf8");
    await writeFile(join(fixture.projectRoot, ".claude/skills/review/references/note.md"), "note\n", "utf8");
    const unboundCopy = (await invoke(BINDINGS_IPC_CHANNELS.preview, request)) as {
      plans: [{ actions: [{ state: string; reason?: string }] }];
    };
    expect(unboundCopy.plans[0].actions[0].state).toBe("conflict");
    expect(unboundCopy.plans[0].actions[0].reason).toBe(
      "An existing unbound project copy cannot be adopted in this operation.",
    );

    await writeFile(join(fixture.projectRoot, ".claude/skills/review/references/note.md"), "edited\n", "utf8");
    const binding = {
      bindingId: "binding-one",
      sourceId: fixture.sourceId,
      packageId: request.packageId,
      artifactPath: request.artifactPath,
      kind: "skill",
      projectId: fixture.projectId,
      harnessId: "claude-code",
      boundHash: fixture.unitHash,
      createdAt: "2026-09-13T10:00:00.000Z",
    };
    await invoke(BINDINGS_IPC_CHANNELS.save, { bindings: [binding] });
    const conflict = (await invoke(BINDINGS_IPC_CHANNELS.preview, request)) as {
      plans: [{ actions: [{ state: string }] }];
    };
    expect(conflict.plans[0].actions[0].state).toBe("conflict");

    await rm(join(fixture.projectRoot, ".claude/skills/review"), { recursive: true, force: true });
    await mkdir(join(fixture.projectRoot, ".agents/skills"), { recursive: true });
    await symlink(
      join(fixture.projectRoot, ".agents/skills/review"),
      join(fixture.projectRoot, ".claude/skills/review"),
      "dir",
    );
    await mkdir(join(fixture.projectRoot, ".agents/skills/review/references"), { recursive: true });
    await writeFile(join(fixture.projectRoot, ".agents/skills/review/SKILL.md"), "review skill\n", "utf8");
    await writeFile(join(fixture.projectRoot, ".agents/skills/review/references/note.md"), "note\n", "utf8");
    const linked = (await invoke(BINDINGS_IPC_CHANNELS.preview, request)) as {
      plans: [{ actions: [{ state: string }] }];
    };
    expect(linked.plans[0].actions[0].state).toBe("linked");

    const hook = (await invoke(BINDINGS_IPC_CHANNELS.preview, { ...request, artifactPath: "hooks/hooks.json" })) as {
      plans: [{ actions: [{ state: string; reason?: string }] }];
    };
    expect(hook.plans[0].actions[0]).toMatchObject({ state: "blocked", reason: "provider action (M4)" });
  });

  it("denies escape and mismatched grants, then lists and removes saved bindings", async () => {
    const fixture = await loadFixture();
    const request = {
      source: { id: fixture.sourceId, grantHandle: fixture.sourceGrant },
      packageId: "packages/tools",
      artifactPath: "skills/review",
      projects: [{ projectId: fixture.projectId, grantHandle: fixture.projectGrant, harnessIds: ["claude-code"] }],
    } as const;
    await expect(invoke(BINDINGS_IPC_CHANNELS.preview, { ...request, artifactPath: "../outside" })).rejects.toThrow();
    await expect(
      invoke(BINDINGS_IPC_CHANNELS.preview, { ...request, source: { ...request.source, grantHandle: "wrong-grant" } }),
    ).resolves.toEqual({ status: "denied" });
    await expect(
      invoke(BINDINGS_IPC_CHANNELS.preview, {
        ...request,
        projects: [{ ...request.projects[0], grantHandle: "wrong-grant" }],
      }),
    ).resolves.toEqual({ status: "denied" });

    const binding = {
      bindingId: "binding-roundtrip",
      sourceId: fixture.sourceId,
      packageId: request.packageId,
      artifactPath: request.artifactPath,
      kind: "skill",
      projectId: fixture.projectId,
      harnessId: "claude-code",
      boundHash: fixture.unitHash,
      createdAt: "2026-09-13T10:00:00.000Z",
    };
    await expect(invoke(BINDINGS_IPC_CHANNELS.save, { bindings: [binding] })).resolves.toMatchObject({
      status: "ready",
      bindings: [binding],
    });
    await expect(invoke(BINDINGS_IPC_CHANNELS.list)).resolves.toMatchObject({ status: "ready", bindings: [binding] });
    await expect(invoke(BINDINGS_IPC_CHANNELS.remove, { bindingId: binding.bindingId })).resolves.toMatchObject({
      status: "ready",
      bindings: [],
    });
  });

  it("keeps request and response parsers allowlisted", () => {
    expect(
      parseBindingsPreviewRequest({
        source: { id: "source-one", grantHandle: "grant-one" },
        packageId: "package-one",
        artifactPath: "skills/review",
        projects: [],
      }),
    ).toMatchObject({ packageId: "package-one" });
    expect(() =>
      parseBindingsPreviewRequest({
        source: { id: "source-one", grantHandle: "grant-one" },
        packageId: "package-one",
        artifactPath: "skills/review",
        projects: [],
        absolutePath: "/private",
      }),
    ).toThrow(/unexpected field/i);
    expect(
      parseBindingsPreviewResponse({
        status: "ready",
        units: [{ kind: "skill", id: "review", artifactPath: "skills/review", contentHash: "a".repeat(64) }],
        plans: [],
      }),
    ).toEqual({
      status: "ready",
      units: [{ kind: "skill", id: "review", artifactPath: "skills/review", contentHash: "a".repeat(64) }],
      plans: [],
    });
  });
});
