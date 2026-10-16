import { createHash } from "node:crypto";
import { mkdtemp, readFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPERATIONS_IPC_CHANNELS,
  parseApplyOperationResponse,
  parsePreviewMarketplaceResponse,
} from "../../src/shared/operations-ipc";
import { REGISTRY_IPC_CHANNELS } from "../../src/shared/registry-ipc";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const roots: string[] = [];
let showOpenDialog: ReturnType<typeof vi.fn>;

async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `omni-${prefix}-`));
  roots.push(path);
  return path;
}

async function load(options: { userDataPath: string; parent: string; writeFile?: typeof writeFile }): Promise<void> {
  handlers.clear();
  showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [options.parent] }));
  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => options.userDataPath) },
    dialog: { showOpenDialog },
    ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  }));
  const registry = await import("../../src/main/registry-ipc");
  const services = registry.registerRegistryIpcHandlers(() => undefined, { userDataPath: options.userDataPath });
  const operations = await import("../../src/main/operations-ipc");
  operations.registerOperationsIpcHandlers(() => undefined, services, {
    userDataPath: options.userDataPath,
    fileWriter: options.writeFile,
  });
}

function invoke(channel: string, request: unknown = {}): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}.`);
  return handler({}, request);
}

async function pickedParent(): Promise<{ parentToken: string; displayParent: string }> {
  return (await invoke(OPERATIONS_IPC_CHANNELS.pickParent)) as { parentToken: string; displayParent: string };
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("electron");
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("marketplace operation IPC boundary", () => {
  it("rejects an apply whose selected marketplace binding changed after preview", async () => {
    const userDataPath = await root("apply-stale-data");
    const sourceRoot = await root("apply-stale-source");
    const projectRoot = await root("apply-stale-project");
    await mkdir(join(sourceRoot, "packages/tools/skills/demo"), { recursive: true });
    const sourceFile = join(sourceRoot, "packages/tools/skills/demo/SKILL.md");
    await writeFile(sourceFile, "before\n", "utf8");
    vi.doMock("electron", () => ({
      app: { getPath: vi.fn(() => userDataPath) },
      dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [projectRoot] })) },
      ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
    }));
    const registryModule = await import("../../src/main/registry-ipc");
    const registry = registryModule.registerRegistryIpcHandlers(() => undefined, { userDataPath });
    const source = await registry.registerSourceByPath(sourceRoot, "Personal");
    expect(source.status).toBe("ready");
    const project = await invoke(REGISTRY_IPC_CHANNELS.registerProject, {});
    expect(project).toMatchObject({ status: "ready" });
    const projectId = (project as { entry: { ref: { id: string } } }).entry.ref.id;
    const bindingsModule = await import("../../src/main/bindings-store");
    const bindings = bindingsModule.createBindingsStore(bindingsModule.bindingsFilePath(userDataPath));
    const sourceId = (source as { entry: { ref: { id: string } } }).entry.ref.id;
    const binding = {
      bindingId: "selected-binding",
      sourceId,
      packageId: "packages/tools",
      artifactPath: "skills/demo",
      kind: "skill" as const,
      projectId,
      harnessId: "claude-code" as const,
      boundHash: "0".repeat(64),
      createdAt: "2026-09-14T00:00:00.000Z",
    };
    await bindings.save([binding]);
    const operations = await import("../../src/main/operations-ipc");
    operations.registerOperationsIpcHandlers(() => undefined, registry, { userDataPath });

    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "apply-plan",
      projectId,
      bindingIds: [binding.bindingId],
    })) as { status: string; plan: { planId: string } };
    expect(preview.status).toBe("ready");
    await writeFile(sourceFile, "changed after preview\n", "utf8");

    const result = await invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId });

    expect(result).toMatchObject({
      status: "failed",
      receipt: { status: "failed", diagnostic: expect.stringContaining("changed after preview") },
    });
    const history = (await invoke(OPERATIONS_IPC_CHANNELS.list)) as {
      receipts: readonly { operationId: string; status: string }[];
    };
    expect(history.receipts).toContainEqual(
      expect.objectContaining({
        operationId: (result as { receipt: { operationId: string } }).receipt.operationId,
        status: "failed",
      }),
    );
    await expect(stat(join(projectRoot, ".claude/skills/demo/SKILL.md"))).rejects.toThrow();
  });

  it("previews exact bounded actions without returning an absolute path", async () => {
    const userDataPath = await root("operations-data");
    const parent = await root("operations-parent");
    await load({ userDataPath, parent });
    const picked = await pickedParent();
    const response = await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "create-marketplace",
      parentToken: picked.parentToken,
      name: "My Market",
    });

    expect(response).toMatchObject({
      status: "ready",
      plan: { kind: "create-marketplace", displayTarget: "my-market", git: { mode: "init-and-commit" } },
    });
    expect((response as { plan: { actions: unknown[] } }).plan.actions).toEqual(
      expect.arrayContaining([
        { kind: "create-directory", relativePath: "." },
        { kind: "create-directory", relativePath: "packages" },
        { kind: "create-directory", relativePath: "packages/my-market" },
        { kind: "write-file", relativePath: "omni.marketplace.json", byteLength: expect.any(Number) },
        { kind: "write-file", relativePath: "packages/my-market/omni.plugin.json", byteLength: expect.any(Number) },
        { kind: "create-directory", relativePath: ".claude-plugin" },
        { kind: "create-directory", relativePath: ".agents" },
        { kind: "create-directory", relativePath: ".agents/plugins" },
        {
          kind: "write-file",
          relativePath: ".claude-plugin/marketplace.json",
          byteLength: expect.any(Number),
          manifest: true,
        },
        {
          kind: "write-file",
          relativePath: ".agents/plugins/marketplace.json",
          byteLength: expect.any(Number),
          manifest: true,
        },
        {
          kind: "write-file",
          relativePath: "packages/my-market/.claude-plugin/plugin.json",
          byteLength: expect.any(Number),
          manifest: true,
        },
        {
          kind: "write-file",
          relativePath: "packages/my-market/.codex-plugin/plugin.json",
          byteLength: expect.any(Number),
          manifest: true,
        },
      ]),
    );
    expect(JSON.stringify(response)).not.toContain(parent);
    expect(parsePreviewMarketplaceResponse(response)).toMatchObject({ status: "ready" });
  });

  it("blocks unsafe names, non-empty targets and userData parents, but permits another personal marketplace", async () => {
    const userDataPath = await root("operations-block-data");
    const parent = await root("operations-block-parent");
    await load({ userDataPath, parent });
    const picked = await pickedParent();
    await expect(
      invoke(OPERATIONS_IPC_CHANNELS.preview, {
        kind: "create-marketplace",
        parentToken: picked.parentToken,
        name: "../escape",
      }),
    ).resolves.toMatchObject({ status: "blocked", reason: "invalid-name" });

    const target = join(parent, "occupied");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "existing.txt"), "local", "utf8");
    const occupied = await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "create-marketplace",
      parentToken: picked.parentToken,
      name: "occupied",
    });
    expect(occupied).toMatchObject({ status: "blocked", reason: "target-not-empty" });

    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [userDataPath] });
    const pickedUserData = (await invoke(OPERATIONS_IPC_CHANNELS.pickParent)) as { parentToken: string };
    expect(
      await invoke(OPERATIONS_IPC_CHANNELS.preview, {
        kind: "create-marketplace",
        parentToken: pickedUserData.parentToken,
        name: "inside",
      }),
    ).toMatchObject({ status: "blocked", reason: "parent-inside-user-data" });

    const personalRoot = await root("operations-existing-personal");
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [personalRoot] });
    await invoke("omni:registry:register-source", { ownership: "personal" });
    expect(
      await invoke(OPERATIONS_IPC_CHANNELS.preview, {
        kind: "create-marketplace",
        parentToken: picked.parentToken,
        name: "another",
      }),
    ).toMatchObject({ status: "ready", plan: { kind: "create-marketplace" } });
  });

  it("applies the previewed files with mode 0644, commits once, registers, and lists receipts newest first", async () => {
    const userDataPath = await root("operations-apply-data");
    const parent = await root("operations-apply-parent");
    await load({ userDataPath, parent });
    const picked = await pickedParent();
    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "create-marketplace",
      parentToken: picked.parentToken,
      name: "Created Market",
    })) as { plan: { planId: string } };
    const applied = await invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId });
    expect(applied).toMatchObject({
      status: "applied",
      receipt: {
        status: "applied",
        git: { mode: "init-and-commit", commit: expect.stringMatching(/^[0-9a-f]{40}$/) },
        registered: { sourceId: expect.any(String) },
        manifests: expect.arrayContaining([
          expect.objectContaining({ relativePath: ".claude-plugin/marketplace.json" }),
          expect.objectContaining({ relativePath: ".agents/plugins/marketplace.json" }),
          expect.objectContaining({ relativePath: "packages/created-market/.claude-plugin/plugin.json" }),
          expect.objectContaining({ relativePath: "packages/created-market/.codex-plugin/plugin.json" }),
        ]),
      },
    });
    const target = join(parent, "created-market");
    expect(await readFile(join(target, "omni.marketplace.json"), "utf8")).toContain('"format": "omni.marketplace/1"');
    expect(await readFile(join(target, "packages", "created-market", "omni.plugin.json"), "utf8")).toContain(
      '"format": "omni.plugin/1"',
    );
    expect(await readFile(join(target, ".claude-plugin", "marketplace.json"), "utf8")).toContain('"plugins": []');
    expect(await readFile(join(target, ".agents", "plugins", "marketplace.json"), "utf8")).toContain('"plugins": []');
    expect(
      await readFile(join(target, "packages", "created-market", ".claude-plugin", "plugin.json"), "utf8"),
    ).toContain('"name": "Created Market"');
    expect(
      await readFile(join(target, "packages", "created-market", ".codex-plugin", "plugin.json"), "utf8"),
    ).toContain('"name": "Created Market"');
    expect((await stat(join(target, "omni.marketplace.json"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(target, "packages", "created-market", "omni.plugin.json"))).mode & 0o777).toBe(0o644);
    const gitHead = (await import("node:child_process"))
      .execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: target, encoding: "utf8" })
      .trim();
    expect(gitHead).toBe("1");
    const listed = await invoke(OPERATIONS_IPC_CHANNELS.list);
    expect(listed).toMatchObject({ status: "ready", receipts: [{ status: "applied" }] });
    expect(JSON.stringify(listed)).not.toContain(parent);
    expect(parseApplyOperationResponse(applied)).toMatchObject({ status: "applied" });
  });

  it("does not write Git metadata inside an enclosing repository", async () => {
    const userDataPath = await root("operations-enclosing-data");
    const parent = await root("operations-enclosing-parent");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", parent]);
    await load({ userDataPath, parent });
    const picked = await pickedParent();
    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "create-marketplace",
      parentToken: picked.parentToken,
      name: "Nested",
    })) as { plan: { planId: string } };
    expect(await invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId })).toMatchObject({
      status: "applied",
      receipt: { git: { mode: "enclosing-repository" } },
    });
    expect(await stat(join(parent, "nested", ".git")).catch(() => undefined)).toBeUndefined();
  });

  it("rolls back created files and directories after an injected write failure", async () => {
    const userDataPath = await root("operations-rollback-data");
    const parent = await root("operations-rollback-parent");
    let writes = 0;
    const failingWrite = (async (...args: Parameters<typeof writeFile>) => {
      writes += 1;
      if (writes === 2) throw new Error("injected failure");
      return writeFile(...args);
    }) as typeof writeFile;
    await load({ userDataPath, parent, writeFile: failingWrite });
    const picked = await pickedParent();
    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "create-marketplace",
      parentToken: picked.parentToken,
      name: "Rollback",
    })) as { plan: { planId: string } };
    const result = await invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId });
    expect(result).toMatchObject({
      status: "failed",
      receipt: {
        status: "failed",
        actions: expect.arrayContaining([
          expect.objectContaining({ relativePath: "packages/rollback/omni.plugin.json", status: "failed" }),
        ]),
      },
    });
    await expect(stat(join(parent, "rollback"))).rejects.toThrow();
    expect((await readdir(parent)).filter((name) => name !== ".git")).toEqual([]);
  });

  it("guards every operation handler and rejects absolute response fields", async () => {
    const userDataPath = await root("operations-guard-data");
    const parent = await root("operations-guard-parent");
    await load({ userDataPath, parent });
    const guard = vi.fn(() => {
      throw new Error("untrusted");
    });
    const operations = await import("../../src/main/operations-ipc");
    const registry = await import("../../src/main/registry-ipc");
    operations.registerOperationsIpcHandlers(
      guard,
      registry.registerRegistryIpcHandlers(() => undefined, { userDataPath }),
      { userDataPath },
    );
    await expect(invoke(OPERATIONS_IPC_CHANNELS.list)).rejects.toThrow("untrusted");
    expect(() =>
      parsePreviewMarketplaceResponse({ status: "blocked", reason: "x", diagnostic: "/private/secret" }),
    ).toThrow(/safe/i);
    expect(createHash("sha256").update(basename(parent)).digest("hex")).toHaveLength(64);
  });
});
