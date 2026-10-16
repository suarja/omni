import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REGISTRY_IPC_CHANNELS,
  parseRegistryEntryRequest,
  parseRegisterSourceRequest,
  parseRegistryViewResponse,
} from "../../src/shared/registry-ipc";
import { parseInventorySnapshot } from "../../src/shared/inventory-dto";
import type { InventoryScanRequest } from "../../src/application/inventory";
import type { InventorySnapshot } from "../../src/domain/inventory";
import { assertTrustedSender } from "../../src/main/renderer-security";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;

const handlers = new Map<string, Handler>();
const temporaryRoots: string[] = [];
let showOpenDialog: ReturnType<typeof vi.fn>;

function snapshot(request: InventoryScanRequest): InventorySnapshot {
  return {
    rootHandle: request.rootHandle,
    displayRoot: request.displayRoot,
    observedAt: "2026-09-09T10:00:00.000Z",
    harnesses: [],
    artifacts: [],
    diagnostics: [],
    gitScopes: [],
  };
}

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `omni-${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

async function loadHandlers(options: {
  userDataPath: string;
  runtime?: { scanInventory(request: InventoryScanRequest): Promise<InventorySnapshot> };
  guard?: (event: unknown) => void;
}): Promise<void> {
  handlers.clear();
  showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => options.userDataPath) },
    dialog: { showOpenDialog },
    ipcMain: {
      handle: vi.fn((channel: string, handler: Handler) => {
        handlers.set(channel, handler);
      }),
    },
  }));

  const module = await import("../../src/main/registry-ipc");
  module.registerRegistryIpcHandlers(options.guard ?? (() => undefined), {
    userDataPath: options.userDataPath,
    runtime: options.runtime,
  });
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
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project and source registry IPC boundary", () => {
  it("refuses a second workshop on registration and on lifecycle reactivation", async () => {
    const userDataPath = await createRoot("workshop-guard-data");
    const first = await createRoot("workshop-one");
    const second = await createRoot("workshop-two");
    await loadHandlers({ userDataPath });
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [first] });
    const registered = (await invoke(REGISTRY_IPC_CHANNELS.registerSource, { ownership: "personal" })) as {
      entry: { ref: { id: string } };
      registryRevision: number;
    };
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [second] });
    await expect(invoke(REGISTRY_IPC_CHANNELS.registerSource, { ownership: "personal" })).resolves.toMatchObject({
      status: "workshop-conflict",
      reason: "active-workshop-exists",
      workshopId: registered.entry.ref.id,
    });
    await invoke(REGISTRY_IPC_CHANNELS.archiveEntry, {
      kind: "source",
      id: registered.entry.ref.id,
      expectedRevision: registered.registryRevision,
    });
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [second] });
    const replacement = (await invoke(REGISTRY_IPC_CHANNELS.registerSource, { ownership: "personal" })) as {
      entry: { ref: { id: string } };
      registryRevision: number;
    };
    await expect(
      invoke(REGISTRY_IPC_CHANNELS.reactivateEntry, {
        kind: "source",
        id: registered.entry.ref.id,
        expectedRevision: replacement.registryRevision,
      }),
    ).resolves.toMatchObject({ status: "workshop-conflict", workshopId: replacement.entry.ref.id });
  });
  it("keeps inventory DTO parsing available to registry observation", () => {
    expect(
      parseInventorySnapshot(
        snapshot({
          approvedRoot: "/private/project",
          rootHandle: "grant-1",
          displayRoot: "project",
          scope: "project",
        }),
      ),
    ).toEqual(
      snapshot({
        approvedRoot: "/private/project",
        rootHandle: "grant-1",
        displayRoot: "project",
        scope: "project",
      }),
    );
    expect(() =>
      parseInventorySnapshot({
        ...snapshot({
          approvedRoot: "/private/project",
          rootHandle: "grant-1",
          displayRoot: "project",
          scope: "project",
        }),
        rootHandle: "/private/project",
      }),
    ).toThrow(/opaque/i);
  });

  it("parses allowlisted requests and rejects renderer-owned fields", () => {
    expect(parseRegistryEntryRequest({ kind: "project", id: "project-one" })).toEqual({
      kind: "project",
      id: "project-one",
    });
    expect(parseRegisterSourceRequest({ ownership: "external" })).toEqual({
      ownership: "external",
    });
    expect(() => parseRegistryEntryRequest({ kind: "project", id: "one", canonicalPath: "/private" })).toThrow(
      /unexpected field/i,
    );
    expect(() => parseRegisterSourceRequest({ ownership: "personal", root: "/private" })).toThrow(/unexpected field/i);
  });

  it("keeps picker cancellation side-effect free", async () => {
    const userDataPath = await createRoot("registry-cancel");
    await loadHandlers({ userDataPath });

    await expect(invoke(REGISTRY_IPC_CHANNELS.registerProject)).resolves.toEqual({
      status: "cancelled",
    });
    await expect(invoke(REGISTRY_IPC_CHANNELS.listRegistry)).resolves.toMatchObject({
      status: "ready",
      registry: { revision: 0, projects: [], sources: [] },
    });
  });

  it("returns a safe inaccessible result when the picked directory disappears", async () => {
    const userDataPath = await createRoot("registry-pick-missing");
    const missingRoot = join(userDataPath, "missing-selection");
    await loadHandlers({ userDataPath });
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [missingRoot] });

    await expect(invoke(REGISTRY_IPC_CHANNELS.registerProject)).resolves.toEqual({
      status: "inaccessible",
      diagnostic: "The selected directory is missing.",
    });
  });

  it("registers, opens, and observes a real project without returning its path", async () => {
    const userDataPath = await createRoot("registry-project");
    const projectRoot = await createRoot("project");
    const seen: InventoryScanRequest[] = [];
    await loadHandlers({
      userDataPath,
      runtime: {
        async scanInventory(request) {
          seen.push(request);
          return snapshot(request);
        },
      },
    });
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [projectRoot] });

    const registered = await invoke(REGISTRY_IPC_CHANNELS.registerProject);
    expect(registered).toMatchObject({
      status: "ready",
      outcome: "created",
      entry: { ref: { kind: "project" }, availability: "available" },
      grantHandle: expect.any(String),
    });
    expect(registered).toMatchObject({ entry: { displayRoot: basename(projectRoot) } });
    expect(JSON.stringify(registered)).not.toContain(projectRoot);
    expect(JSON.stringify(registered)).not.toContain("canonicalPath");
    const listed = await invoke(REGISTRY_IPC_CHANNELS.listRegistry);
    expect(parseRegistryViewResponse(listed)).toMatchObject({
      registry: { projects: [{ displayRoot: basename(projectRoot) }] },
    });
    const parsed = parseRegistryViewResponse(listed);
    if (parsed.status !== "ready") throw new Error("The registered project must be listed.");
    for (const displayRoot of ["~/Projects/notes-app", "notes-app"])
      expect(
        parseRegistryViewResponse({
          ...parsed,
          registry: { ...parsed.registry, projects: [{ ...parsed.registry.projects[0], displayRoot }] },
        }),
      ).toMatchObject({ registry: { projects: [{ displayRoot }] } });
    for (const displayRoot of [
      "/Volumes/projects/notes-app",
      "C:/projects/notes-app",
      "~/../notes-app",
      "~/App\nnotes-app",
      "~/App\0notes-app",
    ])
      expect(() =>
        parseRegistryViewResponse({
          ...parsed,
          registry: { ...parsed.registry, projects: [{ ...parsed.registry.projects[0], displayRoot }] },
        }),
      ).toThrow(/display root/i);

    const projectId = (registered as { entry: { ref: { id: string } } }).entry.ref.id;
    const open = await invoke(REGISTRY_IPC_CHANNELS.openEntry, {
      kind: "project",
      id: projectId,
    });
    expect(open).toMatchObject({ status: "granted", entry: { ref: { id: projectId } } });
    const grantHandle = (open as { grantHandle: string }).grantHandle;

    const observed = await invoke(REGISTRY_IPC_CHANNELS.observeProject, {
      projectId,
      grantHandle,
    });
    expect(observed).toMatchObject({
      status: "observed",
      observation: { subject: { kind: "project", id: projectId } },
    });
    expect(seen[0]).toMatchObject({
      approvedRoot: await realpath(projectRoot),
      rootHandle: grantHandle,
      scope: "project",
    });
    expect(JSON.stringify(observed)).not.toContain(projectRoot);
  });

  it("binds a source grant to its source entry and rejects cross-entry observation", async () => {
    const userDataPath = await createRoot("registry-source");
    const sourceRoot = await createRoot("source");
    const projectRoot = await createRoot("project");
    await loadHandlers({ userDataPath, runtime: { scanInventory: async (request) => snapshot(request) } });
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [sourceRoot] });
    const source = await invoke(REGISTRY_IPC_CHANNELS.registerSource, { ownership: "external" });
    const sourceId = (source as { entry: { ref: { id: string } } }).entry.ref.id;
    const sourceGrant = await invoke(REGISTRY_IPC_CHANNELS.openEntry, { kind: "source", id: sourceId });
    const sourceHandle = (sourceGrant as { grantHandle: string }).grantHandle;

    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [projectRoot] });
    const project = await invoke(REGISTRY_IPC_CHANNELS.registerProject);
    const projectId = (project as { entry: { ref: { id: string } } }).entry.ref.id;

    await expect(
      invoke(REGISTRY_IPC_CHANNELS.observeProject, {
        projectId,
        grantHandle: sourceHandle,
      }),
    ).rejects.toThrow(/invalid|entry/i);
  });

  it("archives and reactivates without deleting the directory or accepting stale revisions", async () => {
    const userDataPath = await createRoot("registry-lifecycle");
    const projectRoot = await createRoot("project");
    const canonicalRoot = await realpath(projectRoot);
    await loadHandlers({ userDataPath });
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [projectRoot] });
    const registered = await invoke(REGISTRY_IPC_CHANNELS.registerProject);
    const projectId = (registered as { entry: { ref: { id: string } } }).entry.ref.id;
    const listed = await invoke(REGISTRY_IPC_CHANNELS.listRegistry);
    const revision = (listed as { registry: { revision: number } }).registry.revision;

    const archived = await invoke(REGISTRY_IPC_CHANNELS.archiveEntry, {
      kind: "project",
      id: projectId,
      expectedRevision: revision,
    });
    expect(archived).toMatchObject({
      status: "ready",
      registry: { projects: [{ ref: { id: projectId }, archivedAt: expect.any(String) }] },
    });
    await expect(
      invoke(REGISTRY_IPC_CHANNELS.archiveEntry, {
        kind: "project",
        id: projectId,
        expectedRevision: revision,
      }),
    ).resolves.toMatchObject({ status: "revision-conflict" });

    const archivedRevision = (archived as { registry: { revision: number } }).registry.revision;
    await expect(
      invoke(REGISTRY_IPC_CHANNELS.reactivateEntry, {
        kind: "project",
        id: projectId,
        expectedRevision: archivedRevision,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      registry: { projects: [{ ref: { id: projectId } }] },
    });
    const active = await invoke(REGISTRY_IPC_CHANNELS.listRegistry);
    expect((active as { registry: { projects: [{ archivedAt?: string }] } }).registry.projects[0]).not.toHaveProperty(
      "archivedAt",
    );
    await expect(realpath(projectRoot)).resolves.toBe(canonicalRoot);
  });

  it("keeps a missing registered root visible instead of deleting its record", async () => {
    const userDataPath = await createRoot("registry-missing");
    const projectRoot = await createRoot("project");
    await loadHandlers({ userDataPath });
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [projectRoot] });
    const registered = await invoke(REGISTRY_IPC_CHANNELS.registerProject);
    const projectId = (registered as { entry: { ref: { id: string } } }).entry.ref.id;
    await rm(projectRoot, { recursive: true, force: true });

    await expect(invoke(REGISTRY_IPC_CHANNELS.openEntry, { kind: "project", id: projectId })).resolves.toMatchObject({
      status: "missing",
      entry: { ref: { id: projectId } },
    });
    await expect(invoke(REGISTRY_IPC_CHANNELS.listRegistry)).resolves.toMatchObject({
      status: "ready",
      registry: { projects: [{ ref: { id: projectId }, availability: "missing" }] },
    });
  });

  it("keeps unavailable registrations visible and fails closed on corrupt storage", async () => {
    const userDataPath = await createRoot("registry-unavailable");
    const missingRoot = join(userDataPath, "missing-project");
    await mkdir(join(userDataPath, "omni"), { recursive: true });
    await writeFile(join(userDataPath, "omni", "project-source-registry.json"), "not-json", "utf8");
    await loadHandlers({ userDataPath });

    await expect(invoke(REGISTRY_IPC_CHANNELS.listRegistry)).resolves.toMatchObject({
      status: "corrupt",
      recoveryAvailable: false,
    });
    await expect(invoke(REGISTRY_IPC_CHANNELS.registerProject)).resolves.toMatchObject({
      status: "corrupt",
    });
    expect(missingRoot).toContain("missing-project");
  });

  it("guards every registry handler through the trusted sender check", async () => {
    const userDataPath = await createRoot("registry-guard");
    const guard = vi.fn(() => {
      throw new Error("untrusted");
    });
    await loadHandlers({ userDataPath, guard });

    await expect(handlerFor(REGISTRY_IPC_CHANNELS.listRegistry)({ senderFrame: { url: "evil:" } }, {})).rejects.toThrow(
      "untrusted",
    );
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it("accepts only the trusted main frame, never a same-origin child frame", () => {
    const mainFrame = { url: "file:///app/renderer/index.html" };
    const policy = {
      packagedUrl: mainFrame.url,
    };
    const trustedEvent = {
      senderFrame: mainFrame,
      sender: { mainFrame },
    };
    expect(() => assertTrustedSender(trustedEvent as never, policy)).not.toThrow();

    const childFrame = { url: mainFrame.url };
    expect(() =>
      assertTrustedSender(
        {
          senderFrame: childFrame,
          sender: { mainFrame },
        } as never,
        policy,
      ),
    ).toThrow(/untrusted renderer/i);
  });
});
