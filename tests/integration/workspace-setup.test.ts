import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalJsonRegistryStore } from "../../src/adapters/registry/local-json";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { createOperationStore } from "../../src/main/operation-store";
import { createInstallAgentsOperations } from "../../src/main/operations-install-agents";
import { bundleRoot, readBundle } from "../../src/main/omni-skills-bundle";
import { parseRegistryState } from "../../src/domain/project-source-registry";
import { REGISTRY_IPC_CHANNELS } from "../../src/shared/registry-ipc";
import type { GitCli } from "../../src/main/git-cli";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;
type DirectorySelection = Readonly<{ canceled: boolean; filePaths: readonly string[] }>;

const handlers = new Map<string, Handler>();
const roots: string[] = [];
const registryPath = (userDataPath: string): string => join(userDataPath, "omni", "project-source-registry.json");

async function createRoots(): Promise<
  Readonly<{
    root: string;
    userDataPath: string;
    homeDir: string;
    parent: string;
    project: string;
  }>
> {
  const root = await mkdtemp(join(tmpdir(), "omni-s02-workspace-setup-"));
  roots.push(root);
  const result = {
    root,
    userDataPath: join(root, "user-data"),
    homeDir: join(root, "home"),
    parent: join(root, "marketplaces"),
    project: join(root, "project"),
  };
  await Promise.all(
    Object.values(result)
      .filter((path) => path !== root)
      .map((path) => mkdir(path, { recursive: true })),
  );
  return result;
}

function createPicker(selections: readonly DirectorySelection[]) {
  const pending = [...selections];
  return {
    showOpenDialog: vi.fn(async () => pending.shift() ?? { canceled: true, filePaths: [] }),
  };
}

async function loadRegistry(options: {
  userDataPath: string;
  projectPicker: ReturnType<typeof createPicker>;
  now: () => number;
}): Promise<
  Readonly<{
    services: import("../../src/main/registry-ipc").RegistryIpcServices;
    store: ReturnType<typeof createLocalJsonRegistryStore>;
  }>
> {
  handlers.clear();
  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => options.userDataPath) },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  }));
  const registryModule = await import("../../src/main/registry-ipc");
  const store = createLocalJsonRegistryStore(registryPath(options.userDataPath));
  const services = registryModule.registerRegistryIpcHandlers(() => undefined, {
    userDataPath: options.userDataPath,
    registryStore: store,
    directoryPicker: options.projectPicker,
    now: options.now,
  });
  return { services, store };
}

function invoke(channel: string, request: unknown = {}): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}.`);
  return handler({}, request);
}

function gitDisabled(): GitCli {
  return {
    remoteUrl: async () => undefined,
    push: async () => {
      throw new Error("Unexpected push in this test.");
    },
    isGitAvailable: async () => false,
    enclosingRepository: async () => ({ status: "unavailable", diagnostic: "Git is unavailable." }),
    initAndCommit: async () => ({ status: "failed", diagnostic: "Git is unavailable." }),
    commitAll: async () => ({ status: "failed", diagnostic: "Git is unavailable." }),
    hasChanges: async () => false,
    isRepositoryRoot: async () => false,
    headCommit: async () => undefined,
  };
}

async function loadMarketplace(
  services: import("../../src/main/registry-ipc").RegistryIpcServices,
  options: {
    userDataPath: string;
    parentPicker: ReturnType<typeof createPicker>;
    now: () => number;
  },
) {
  const module = await import("../../src/main/operations-create-marketplace");
  return module.createMarketplaceOperations(services, {
    userDataPath: options.userDataPath,
    directoryPicker: options.parentPicker,
    gitCli: gitDisabled(),
    now: options.now,
  });
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("electron");
  handlers.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canvas workspace setup reception", () => {
  it("creates a marketplace, observes a real project, and reopens both registrations", async () => {
    const paths = await createRoots();
    const projectFile = join(paths.project, "README.md");
    await writeFile(projectFile, "Owner-authored project bytes\n", "utf8");
    await writeFile(join(paths.project, "foreign.txt"), "Keep this file\n", "utf8");
    const beforeProject = await Promise.all([
      readFile(projectFile, "utf8"),
      readFile(join(paths.project, "foreign.txt"), "utf8"),
    ]);
    const bindings = createBindingsStore(bindingsFilePath(paths.userDataPath));
    const beforeBindings = await bindings.read();
    expect(beforeBindings).toEqual({ status: "ready", bindings: [] });

    let timestamp = Date.UTC(2026, 9, 4, 12, 0, 0);
    const now = (): number => timestamp++;
    const projectPicker = createPicker([{ canceled: false, filePaths: [paths.project] }]);
    const parentPicker = createPicker([{ canceled: false, filePaths: [paths.parent] }]);
    const { services, store } = await loadRegistry({ userDataPath: paths.userDataPath, projectPicker, now });
    const marketplace = await loadMarketplace(services, {
      userDataPath: paths.userDataPath,
      parentPicker,
      now,
    });
    const picked = await marketplace.pickParent();
    expect(picked.status).toBe("picked");
    if (picked.status !== "picked") return;

    const preview = await marketplace.preview({
      kind: "create-marketplace",
      parentToken: picked.parentToken,
      name: "Personal",
    });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    expect(preview.plan).toMatchObject({ kind: "create-marketplace", displayTarget: "personal" });

    const applied = await marketplace.apply({ planId: preview.plan.planId });
    expect(applied.status).toBe("applied");
    expect(applied.receipt).toMatchObject({
      kind: "create-marketplace",
      status: "applied",
      registered: { sourceId: expect.any(String) },
    });
    const sourceId = applied.receipt.registered?.sourceId;
    expect(sourceId).toBeTruthy();
    const sourceState = await store.read();
    expect(sourceState.status).toBe("ready");
    if (sourceState.status !== "ready") return;
    expect(sourceState.state.sources.map(({ id }) => id)).toEqual([sourceId]);
    expect(sourceState.state.projects).toEqual([]);

    const registered = await invoke(REGISTRY_IPC_CHANNELS.registerProject);
    expect(registered).toMatchObject({ status: "ready", outcome: "created", entry: { ref: { kind: "project" } } });
    expect(JSON.stringify(registered)).not.toContain(paths.project);
    const registration = registered as { entry: { ref: { id: string } }; grantHandle: string };
    const observed = (await invoke(REGISTRY_IPC_CHANNELS.observeProject, {
      projectId: registration.entry.ref.id,
      grantHandle: registration.grantHandle,
    })) as { status: string; observation?: { subject: { kind: string; id: string } } };
    expect(observed).toMatchObject({
      status: "observed",
      observation: { subject: { kind: "project", id: registration.entry.ref.id } },
    });

    vi.resetModules();
    const restarted = await loadRegistry({
      userDataPath: paths.userDataPath,
      projectPicker: createPicker([]),
      now,
    });
    const reopened = await restarted.services.listRegistry();
    expect(reopened).toMatchObject({
      status: "ready",
      registry: {
        projects: [{ ref: { kind: "project", id: registration.entry.ref.id } }],
        sources: [{ ref: { kind: "source", id: sourceId } }],
      },
    });
    await expect(
      restarted.services.observeRegisteredEntry({ kind: "project", id: registration.entry.ref.id }),
    ).resolves.toMatchObject({
      status: "observed",
      observation: { subject: { kind: "project", id: registration.entry.ref.id } },
    });

    const afterProject = await Promise.all([
      readFile(projectFile, "utf8"),
      readFile(join(paths.project, "foreign.txt"), "utf8"),
    ]);
    expect(afterProject).toEqual(beforeProject);
    expect(await bindings.read()).toEqual(beforeBindings);
    const persisted = parseRegistryState(
      JSON.parse(await readFile(registryPath(paths.userDataPath), "utf8")) as unknown,
    );
    expect(persisted.projects.map(({ id }) => id)).toEqual([registration.entry.ref.id]);
    expect(persisted.sources.map(({ id }) => id)).toEqual([sourceId]);
    expect(await realpath(join(paths.parent, "personal"))).toBe(join(await realpath(paths.parent), "personal"));
  });

  it("keeps registrations and non-owned bytes on cancellation, aliases, classification conflict, and stale apply", async () => {
    const paths = await createRoots();
    const externalRoot = join(paths.root, "external-source");
    await mkdir(externalRoot);
    const protectedFile = join(externalRoot, "foreign.txt");
    await writeFile(protectedFile, "Preserve external content\n", "utf8");
    let timestamp = Date.UTC(2026, 9, 4, 12, 1, 0);
    const now = (): number => timestamp++;
    const projectPicker = createPicker([
      { canceled: false, filePaths: [paths.project] },
      { canceled: false, filePaths: [paths.project] },
      { canceled: true, filePaths: [] },
      { canceled: false, filePaths: [externalRoot] },
    ]);
    const { services, store } = await loadRegistry({ userDataPath: paths.userDataPath, projectPicker, now });
    const firstProject = await invoke(REGISTRY_IPC_CHANNELS.registerProject);
    expect(firstProject).toMatchObject({ status: "ready", outcome: "created" });
    const aliasProject = await invoke(REGISTRY_IPC_CHANNELS.registerProject);
    expect(aliasProject).toMatchObject({ status: "ready", outcome: "existing" });
    expect((aliasProject as { entry: { ref: { id: string } } }).entry.ref.id).toBe(
      (firstProject as { entry: { ref: { id: string } } }).entry.ref.id,
    );
    const beforeCancel = await readFile(registryPath(paths.userDataPath), "utf8");
    await expect(invoke(REGISTRY_IPC_CHANNELS.registerProject)).resolves.toEqual({ status: "cancelled" });
    expect(await readFile(registryPath(paths.userDataPath), "utf8")).toBe(beforeCancel);

    const registeredExternal = await invoke(REGISTRY_IPC_CHANNELS.registerSource, { ownership: "external" });
    expect(registeredExternal).toMatchObject({ status: "ready", entry: { ownership: "external" } });
    const beforeConflict = await readFile(registryPath(paths.userDataPath), "utf8");
    await expect(services.registerSourceByPath(externalRoot, "External source")).resolves.toMatchObject({
      status: "classification-conflict",
      requestedOwnership: "personal",
    });
    expect(await readFile(registryPath(paths.userDataPath), "utf8")).toBe(beforeConflict);

    const parentPicker = createPicker([{ canceled: false, filePaths: [paths.parent] }]);
    const marketplace = await loadMarketplace(services, { userDataPath: paths.userDataPath, parentPicker, now });
    const picked = await marketplace.pickParent();
    expect(picked.status).toBe("picked");
    if (picked.status !== "picked") return;
    const preview = await marketplace.preview({
      kind: "create-marketplace",
      parentToken: picked.parentToken,
      name: "stale-market",
    });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    const target = join(paths.parent, "stale-market");
    await mkdir(target);
    await writeFile(join(target, "foreign.txt"), "Keep late-arriving content\n", "utf8");
    const result = await marketplace.apply({ planId: preview.plan.planId });
    expect(result).toMatchObject({ status: "failed", receipt: { status: "failed" } });
    await expect(readFile(join(target, "foreign.txt"), "utf8")).resolves.toBe("Keep late-arriving content\n");
    await expect(readFile(protectedFile, "utf8")).resolves.toBe("Preserve external content\n");
    const final = await store.read();
    expect(final.status).toBe("ready");
    if (final.status !== "ready") return;
    expect(final.state.projects).toHaveLength(1);
    expect(final.state.sources).toHaveLength(1);
    expect(final.state.sources[0]?.ownership).toBe("external");
  });

  it("keeps a project registration after its root disappears before the first read", async () => {
    const paths = await createRoots();
    const projectPicker = createPicker([{ canceled: false, filePaths: [paths.project] }]);
    const now = (): number => Date.UTC(2026, 9, 4, 12, 2, 0);
    const { services, store } = await loadRegistry({ userDataPath: paths.userDataPath, projectPicker, now });
    const registered = (await invoke(REGISTRY_IPC_CHANNELS.registerProject)) as {
      status: string;
      entry: { ref: { id: string } };
      grantHandle: string;
    };
    expect(registered.status).toBe("ready");
    await rm(paths.project, { recursive: true, force: true });
    await expect(
      invoke(REGISTRY_IPC_CHANNELS.observeProject, {
        projectId: registered.entry.ref.id,
        grantHandle: registered.grantHandle,
      }),
    ).resolves.toMatchObject({ status: "missing", subject: { kind: "project", id: registered.entry.ref.id } });
    const persisted = await store.read();
    expect(persisted).toMatchObject({ status: "ready", state: { projects: [{ id: registered.entry.ref.id }] } });
  });

  it("applies optional Claude Code setup only inside the explicit disposable home", async () => {
    const paths = await createRoots();
    const claudeDirectory = join(paths.homeDir, ".claude");
    const unrelatedSkillDirectory = join(claudeDirectory, "skills", "foreign-skill");
    const cliPath = join(paths.root, "omni-mcp.js");
    const settingsPath = join(paths.homeDir, ".claude.json");
    const skillPath = join(unrelatedSkillDirectory, "SKILL.md");
    await mkdir(unrelatedSkillDirectory, { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ mcpServers: { pencil: { command: "pencil" } } }, null, 2));
    await writeFile(skillPath, "---\nname: foreign-skill\n---\nPreserve this skill.\n");
    await writeFile(cliPath, "temporary MCP entry point\n");
    const beforeSkill = await readFile(skillPath, "utf8");

    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const operations = createInstallAgentsOperations({
      homeDir: paths.homeDir,
      userDataPath: paths.userDataPath,
      cliPath,
      appPath: process.cwd(),
      isPackaged: false,
      bundle,
      operationStore: createOperationStore(join(paths.userDataPath, "omni", "operations.json")),
      now: () => Date.UTC(2026, 9, 4, 12, 3, 0),
    });
    const preview = await operations.preview({ kind: "install-agents", harnesses: ["claude-code"] });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied).toMatchObject({ status: "applied", receipt: { kind: "install-agents", registered: null } });

    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(settings.mcpServers.pencil).toEqual({ command: "pencil" });
    expect(settings.mcpServers.omni).toBeDefined();
    await expect(readFile(skillPath, "utf8")).resolves.toBe(beforeSkill);
  });
});
