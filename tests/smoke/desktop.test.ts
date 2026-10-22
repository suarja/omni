import { afterEach, describe, expect, it, vi } from "vitest";

import { getDesktopApi } from "../../src/renderer/App";
import type { DesktopApi } from "../../src/shared/ipc";
import { ARTIFACT_IPC_CHANNELS } from "../../src/shared/artifact-ipc";
import { REGISTRY_IPC_CHANNELS } from "../../src/shared/registry-ipc";
import { OPERATIONS_IPC_CHANNELS } from "../../src/shared/operations-ipc";
import { BINDINGS_IPC_CHANNELS } from "../../src/shared/bindings-ipc";
import { ACTIVITY_IPC_CHANNELS } from "../../src/shared/activity-ipc";
import { APPLY_IPC_CHANNELS } from "../../src/shared/apply-ipc";
import { SETTINGS_IPC_CHANNELS } from "../../src/shared/settings-ipc";

describe("desktop preload contract", () => {
  let previousWindow: PropertyDescriptor | undefined;

  afterEach(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    previousWindow = undefined;
    vi.resetModules();
    vi.doUnmock("electron");
    vi.doUnmock("../../src/main/external-library/service");
    vi.doUnmock("../../src/main/external-library/scheduler");
    vi.doUnmock("../../src/main/login-item");
  });

  it("exposes only the declared desktop operations through preload", async () => {
    const exposeInMainWorld = vi.fn();
    const invoke = vi.fn((channel: string): Promise<unknown> => {
      if (channel === REGISTRY_IPC_CHANNELS.listRegistry) {
        return Promise.resolve({ status: "ready", registry: { revision: 0, projects: [], sources: [] } });
      }
      if (
        channel === REGISTRY_IPC_CHANNELS.inspectProject ||
        channel === REGISTRY_IPC_CHANNELS.registerInspectedProject ||
        channel === REGISTRY_IPC_CHANNELS.registerProject ||
        channel === REGISTRY_IPC_CHANNELS.registerSource
      ) {
        return Promise.resolve({ status: "cancelled" });
      }
      if (channel === REGISTRY_IPC_CHANNELS.openEntry) {
        return Promise.resolve({
          status: "inaccessible",
          entry: {
            ref: { kind: "project", id: "project-one" },
            displayName: "Project One",
            displayRoot: "project-one",
            availability: "missing",
          },
          diagnostic: "The registered root is missing.",
        });
      }
      if (channel === REGISTRY_IPC_CHANNELS.observeProject || channel === REGISTRY_IPC_CHANNELS.observeSource) {
        return Promise.resolve({
          status: "inaccessible",
          subject: {
            kind: channel === REGISTRY_IPC_CHANNELS.observeProject ? "project" : "source",
            id: "entry-one",
          },
          diagnostic: "The registered root is inaccessible.",
        });
      }
      if (channel === REGISTRY_IPC_CHANNELS.archiveEntry || channel === REGISTRY_IPC_CHANNELS.reactivateEntry) {
        return Promise.resolve({ status: "ready", registry: { revision: 1, projects: [], sources: [] } });
      }
      if (channel === ARTIFACT_IPC_CHANNELS.readArtifact) {
        return Promise.resolve({ status: "read", content: "test", byteLength: 4, truncated: false });
      }
      if (channel === OPERATIONS_IPC_CHANNELS.pickParent) return Promise.resolve({ status: "cancelled" });
      if (channel === OPERATIONS_IPC_CHANNELS.preview)
        return Promise.resolve({ status: "blocked", reason: "test", diagnostic: "Test preview blocked." });
      if (channel === OPERATIONS_IPC_CHANNELS.apply)
        return Promise.resolve({
          status: "failed",
          receipt: {
            operationId: "op-one",
            kind: "create-marketplace",
            status: "failed",
            appliedAt: "2026-09-12T10:00:00.000Z",
            displayTarget: "test",
            actions: [],
            git: { mode: "unavailable" },
            registered: null,
          },
        });
      if (channel === OPERATIONS_IPC_CHANNELS.list) return Promise.resolve({ status: "ready", receipts: [] });
      if (channel === OPERATIONS_IPC_CHANNELS.paths)
        return Promise.resolve({ store: { displayRoot: "~/.config/omni/operations.json" } });
      if (
        channel === BINDINGS_IPC_CHANNELS.list ||
        channel === BINDINGS_IPC_CHANNELS.save ||
        channel === BINDINGS_IPC_CHANNELS.remove
      )
        return Promise.resolve({ status: "ready", bindings: [] });
      if (channel === BINDINGS_IPC_CHANNELS.preview)
        return Promise.resolve({
          status: "ready",
          units: [{ kind: "skill", id: "preview", artifactPath: "skills/preview", contentHash: "0".repeat(64) }],
          plans: [],
        });
      if (channel === ACTIVITY_IPC_CHANNELS.snapshot)
        return Promise.resolve({ status: "ready", snapshot: { processes: [], worktrees: [] } });
      if (channel === ACTIVITY_IPC_CHANNELS.preview)
        return Promise.resolve({ status: "blocked", reason: "test", diagnostic: "Test preview blocked." });
      if (channel === ACTIVITY_IPC_CHANNELS.apply)
        return Promise.resolve({
          status: "failed",
          receipt: {
            operationId: "activity-op",
            kind: "stop-process",
            status: "failed",
            appliedAt: "2026-09-12T10:00:00.000Z",
            displayTarget: "node",
            actions: [],
            git: { mode: "unavailable" },
            registered: null,
          },
        });
      if (channel === ACTIVITY_IPC_CHANNELS.simulate) return Promise.resolve({ status: "unavailable" });
      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke },
    }));

    await import("../../src/preload/index");
    const api = exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi | undefined;
    expect(api).toBeDefined();
    if (!api) throw new Error("The preload API was not exposed.");
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(exposeInMainWorld).toHaveBeenCalledWith(
      "omni",
      expect.objectContaining({
        archiveEntry: expect.any(Function),
        listAgentRequests: expect.any(Function),
        resolveAgentRequest: expect.any(Function),
        declineAgentRequest: expect.any(Function),
        getAgentStatus: expect.any(Function),
        getAgentMaintenance: expect.any(Function),
        retryAgentUpdate: expect.any(Function),
        rotateAgentToken: expect.any(Function),
        setGuardProjectMode: expect.any(Function),
        applyOperation: expect.any(Function),
        hashArtifacts: expect.any(Function),
        getOperationPaths: expect.any(Function),
        getReceiptDiff: expect.any(Function),
        listRegistry: expect.any(Function),
        listOperations: expect.any(Function),
        observeProject: expect.any(Function),
        observeSource: expect.any(Function),
        openEntry: expect.any(Function),
        pickOperationParent: expect.any(Function),
        previewOperation: expect.any(Function),
        reactivateEntry: expect.any(Function),
        inspectProject: expect.any(Function),
        registerInspectedProject: expect.any(Function),
        registerProject: expect.any(Function),
        registerSource: expect.any(Function),
        readArtifact: expect.any(Function),
        listBindings: expect.any(Function),
        previewBindings: expect.any(Function),
        saveBindings: expect.any(Function),
        removeBinding: expect.any(Function),
        getActivitySnapshot: expect.any(Function),
        getListeningPorts: expect.any(Function),
        previewActivity: expect.any(Function),
        applyActivity: expect.any(Function),
        simulateActivity: expect.any(Function),
        openTerminal: expect.any(Function),
        getSettings: expect.any(Function),
        setSettings: expect.any(Function),
        previewApply: expect.any(Function),
        runApply: expect.any(Function),
        previewRemove: expect.any(Function),
        runRemove: expect.any(Function),
        previewRestoreApply: expect.any(Function),
        runRestoreApply: expect.any(Function),
        getStackProfile: expect.any(Function),
        searchCatalogue: expect.any(Function),
        getCatalogueEntry: expect.any(Function),
        prepareCatalogueImport: expect.any(Function),
        runInferenceCommand: expect.any(Function),
        dryRunInference: expect.any(Function),
        listAcademyLessons: expect.any(Function),
        getAcademyLesson: expect.any(Function),
        getAcademyFirstLaunch: expect.any(Function),
        getAiConnection: expect.any(Function),
        setAiConnection: expect.any(Function),
        removeAiConnection: expect.any(Function),
        setAiKey: expect.any(Function),
        removeAiKey: expect.any(Function),
        testAiConnection: expect.any(Function),
        listAiModels: expect.any(Function),
        listAiPresets: expect.any(Function),
        setAiFunctions: expect.any(Function),
        getAiUsage: expect.any(Function),
        startAgentJob: expect.any(Function),
        listAgentJobs: expect.any(Function),
        stopAgentJob: expect.any(Function),
      }),
    );

    expect(Object.keys(api).sort()).toEqual(
      [
        "applyActivity",
        "applyOperation",
        "applySkillOperation",
        "archiveEntry",
        "beginAgentApply",
        "compareSkillCopies",
        "declineAgentRequest",
        "dryRunInference",
        "endAgentApply",
        "getAcademyFirstLaunch",
        "getAcademyLesson",
        "getAcademyScreenshot",
        "getActivitySnapshot",
        "getAgentStatus",
        "getAgentMaintenance",
        "retryAgentUpdate",
        "getAiConnection",
        "getAiUsage",
        "getCatalogueEntry",
        "getListeningPorts",
        "getOperationPaths",
        "getReceiptDiff",
        "getSettings",
        "getLoginItem",
        "getAppUpdates",
        "setAppUpdates",
        "onAppUpdatesChanged",
        "restartForUpdate",
        "getStackProfile",
        "getWorkshopDelivery",
        "hashArtifacts",
        "listAcademyLessons",
        "listAgentJobs",
        "listAgentRequests",
        "listAiModels",
        "listAiPresets",
        "listBindings",
        "listOperations",
        "listRegistry",
        "listExternalSources",
        "readExternalSource",
        "compareExternalUse",
        "listExternalSourcesOnMac",
        "addExternalSource",
        "discoverExternalSource",
        "prepareExternalSkillImport",
        "readExternalSkillDocument",
        "openExternalSourceRepository",
        "checkExternalLibrary",
        "acknowledgeRemovedExternalUse",
        "listSkillOperationRecoveries",
        "observeProject",
        "observeSkillCopies",
        "observeSource",
        "onOpenAgentRequest",
        "onReviewChanged",
        "openEntry",
        "openTerminal",
        "pickOperationParent",
        "prepareCatalogueImport",
        "previewActivity",
        "previewApply",
        "previewBindings",
        "previewOperation",
        "previewRemove",
        "previewRestoreApply",
        "previewSkillOperation",
        "reactivateEntry",
        "readArtifact",
        "readSkillPropagationCandidates",
        "readWorkspaceSkillUses",
        "readProjectSkills",
        "readSkillOperationResult",
        "readSkillVariantOrigin",
        "refreshAgentRequest",
        "refreshSkillOperation",
        "inspectProject",
        "inspectStorefront",
        "linkStorefront",
        "readStorefrontDrift",
        "readStorefrontDetails",
        "readStorefrontCapabilities",
        "readPublicationContentChecks",
        "openStorefrontRepository",
        "registerInspectedProject",
        "registerProject",
        "registerSource",
        "removeAiConnection",
        "removeAiKey",
        "removeBinding",
        "resolveAgentRequest",
        "rotateAgentToken",
        "runApply",
        "runInferenceCommand",
        "runRemove",
        "runRestoreApply",
        "saveBindings",
        "searchCatalogue",
        "setAiConnection",
        "setAiFunctions",
        "setAiKey",
        "setGuardProjectMode",
        "setSettings",
        "setLoginItem",
        "simulateActivity",
        "startAgentJob",
        "stopAgentJob",
        "testAiConnection",
      ].sort(),
    );

    previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { omni: api } });

    await expect(api.listRegistry()).resolves.toMatchObject({ status: "ready", registry: { revision: 0 } });
    await expect(api.inspectProject!()).resolves.toEqual({ status: "cancelled" });
    await expect(api.registerInspectedProject!({ grantHandle: "picked-grant" })).resolves.toEqual({
      status: "cancelled",
    });
    await expect(api.registerProject()).resolves.toEqual({ status: "cancelled" });
    await expect(api.registerSource({ ownership: "personal" })).resolves.toEqual({ status: "cancelled" });
    await expect(api.openEntry({ kind: "project", id: "project-one" })).resolves.toMatchObject({
      status: "inaccessible",
    });
    await expect(api.observeProject({ projectId: "entry-one", grantHandle: "grant-project" })).resolves.toMatchObject({
      status: "inaccessible",
    });
    await expect(api.observeSource({ sourceId: "entry-one", grantHandle: "grant-source" })).resolves.toMatchObject({
      status: "inaccessible",
    });
    await expect(api.archiveEntry({ kind: "project", id: "project-one", expectedRevision: 0 })).resolves.toMatchObject({
      status: "ready",
    });
    await expect(
      api.reactivateEntry({ kind: "project", id: "project-one", expectedRevision: 1 }),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      api.readArtifact!({
        kind: "project",
        id: "project-one",
        grantHandle: "grant-project",
        relativePath: "AGENTS.md",
      }),
    ).resolves.toEqual({ status: "read", content: "test", byteLength: 4, truncated: false });
    await expect(api.pickOperationParent!()).resolves.toEqual({ status: "cancelled" });
    await expect(
      api.previewOperation!({ kind: "create-marketplace", parentToken: "parent-token", name: "test" }),
    ).resolves.toMatchObject({ status: "blocked" });
    await expect(
      api.previewOperation!({
        kind: "describe-plugin",
        packageId: "packages/tools",
        description: "Tools for reviewing changes.",
      }),
    ).resolves.toMatchObject({ status: "blocked" });
    expect(invoke).toHaveBeenCalledWith(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "describe-plugin",
      packageId: "packages/tools",
      description: "Tools for reviewing changes.",
    });
    await expect(
      api.previewOperation!({
        kind: "import-artifact",
        source: { kind: "project", id: "project-one", grantHandle: "grant-project" },
        relativePath: ".agents/skills/review",
        target: { newPackageName: "tools", description: "Tools for reviewing changes." },
      }),
    ).resolves.toMatchObject({ status: "blocked" });
    await expect(api.applyOperation!({ planId: "plan-one" })).resolves.toMatchObject({ status: "failed" });
    await expect(api.listOperations!()).resolves.toEqual({ status: "ready", receipts: [] });
    await expect(api.getOperationPaths!()).resolves.toEqual({
      store: { displayRoot: "~/.config/omni/operations.json" },
    });
    await expect(api.listBindings!()).resolves.toEqual({ status: "ready", bindings: [] });
    await expect(
      api.previewBindings!({
        source: { id: "source-one", grantHandle: "grant-source" },
        packageId: "package-one",
        artifactPath: "skills/review",
        projects: [],
      }),
    ).resolves.toEqual({
      status: "ready",
      units: [{ kind: "skill", id: "preview", artifactPath: "skills/preview", contentHash: "0".repeat(64) }],
      plans: [],
    });
    await expect(api.saveBindings!({ bindings: [] })).resolves.toEqual({ status: "ready", bindings: [] });
    await expect(api.removeBinding!({ bindingId: "binding-one" })).resolves.toEqual({ status: "ready", bindings: [] });
    await expect(api.getActivitySnapshot!()).resolves.toMatchObject({
      status: "ready",
      snapshot: { processes: [], worktrees: [] },
    });
    await expect(api.previewActivity!({ kind: "stop-process", pid: 1 })).resolves.toMatchObject({ status: "blocked" });
    await expect(api.applyActivity!({ planId: "plan-one" })).resolves.toMatchObject({ status: "failed" });
    await expect(api.simulateActivity!({ kind: "runaway-process" })).resolves.toEqual({ status: "unavailable" });
    expect(getDesktopApi()).toBe(api);
    expect(invoke.mock.calls).toEqual([
      [REGISTRY_IPC_CHANNELS.listRegistry, {}],
      [REGISTRY_IPC_CHANNELS.inspectProject, {}],
      [REGISTRY_IPC_CHANNELS.registerInspectedProject, { grantHandle: "picked-grant" }],
      [REGISTRY_IPC_CHANNELS.registerProject, {}],
      [REGISTRY_IPC_CHANNELS.registerSource, { ownership: "personal" }],
      [REGISTRY_IPC_CHANNELS.openEntry, { kind: "project", id: "project-one" }],
      [REGISTRY_IPC_CHANNELS.observeProject, { projectId: "entry-one", grantHandle: "grant-project" }],
      [REGISTRY_IPC_CHANNELS.observeSource, { sourceId: "entry-one", grantHandle: "grant-source" }],
      [REGISTRY_IPC_CHANNELS.archiveEntry, { kind: "project", id: "project-one", expectedRevision: 0 }],
      [REGISTRY_IPC_CHANNELS.reactivateEntry, { kind: "project", id: "project-one", expectedRevision: 1 }],
      [
        ARTIFACT_IPC_CHANNELS.readArtifact,
        { kind: "project", id: "project-one", grantHandle: "grant-project", relativePath: "AGENTS.md" },
      ],
      [OPERATIONS_IPC_CHANNELS.pickParent, {}],
      [OPERATIONS_IPC_CHANNELS.preview, { kind: "create-marketplace", parentToken: "parent-token", name: "test" }],
      [
        OPERATIONS_IPC_CHANNELS.preview,
        { kind: "describe-plugin", packageId: "packages/tools", description: "Tools for reviewing changes." },
      ],
      [
        OPERATIONS_IPC_CHANNELS.preview,
        {
          kind: "import-artifact",
          source: { kind: "project", id: "project-one", grantHandle: "grant-project" },
          relativePath: ".agents/skills/review",
          target: { newPackageName: "tools", description: "Tools for reviewing changes." },
        },
      ],
      [OPERATIONS_IPC_CHANNELS.apply, { planId: "plan-one" }],
      [OPERATIONS_IPC_CHANNELS.list, {}],
      [OPERATIONS_IPC_CHANNELS.paths, {}],
      [BINDINGS_IPC_CHANNELS.list, {}],
      [
        BINDINGS_IPC_CHANNELS.preview,
        {
          source: { id: "source-one", grantHandle: "grant-source" },
          packageId: "package-one",
          artifactPath: "skills/review",
          projects: [],
        },
      ],
      [BINDINGS_IPC_CHANNELS.save, { bindings: [] }],
      [BINDINGS_IPC_CHANNELS.remove, { bindingId: "binding-one" }],
      [ACTIVITY_IPC_CHANNELS.snapshot, {}],
      [ACTIVITY_IPC_CHANNELS.preview, { kind: "stop-process", pid: 1 }],
      [ACTIVITY_IPC_CHANNELS.apply, { planId: "plan-one" }],
      [ACTIVITY_IPC_CHANNELS.simulate, { kind: "runaway-process" }],
    ]);
  });

  it.each([
    [true, false],
    [false, false],
    [true, true],
  ])("respects the single-instance lock (%s) and quiet login launch (%s)", async (hasLock, quietLogin) => {
    const whenReady = vi.fn(() => Promise.resolve());
    const appOn = vi.fn();
    const appQuit = vi.fn();
    const setPath = vi.fn();
    const libraryStart = vi.fn(async () => undefined),
      libraryStop = vi.fn();
    const readyCallbacks: Array<() => void> = [];
    vi.doMock("../../src/main/external-library/service", () => ({ createExternalLibraryService: vi.fn(() => ({})) }));
    vi.doMock("../../src/main/external-library/scheduler", () => ({
      createExternalLibraryScheduler: vi.fn(() => ({ start: libraryStart, stop: libraryStop })),
    }));
    const showWindow = vi.fn();
    const focusWindow = vi.fn();
    const BrowserWindow = vi.fn(() => ({
      show: showWindow,
      focus: focusWindow,
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      webContents: {
        setWindowOpenHandler: vi.fn(),
        on: vi.fn(),
        once: vi.fn((_name: string, callback: () => void) => readyCallbacks.push(callback)),
      },
      loadFile: vi.fn(() => Promise.resolve()),
    }));
    (BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }).getAllWindows = vi.fn(() => []);
    const registerRegistryIpcHandlers = vi.fn();
    const registerArtifactIpcHandlers = vi.fn();
    const registerOperationsIpcHandlers = vi.fn(() => ({
      skillManagement: { initialize: vi.fn(async () => undefined) },
    }));
    const registerBindingsIpcHandlers = vi.fn();
    const registerActivityIpcHandlers = vi.fn();
    const registerApplyIpcHandlers = vi.fn();
    const registerSettingsIpcHandlers = vi.fn();
    const maintenanceStart = vi.fn(async () => undefined);
    const registerAgentMaintenanceIpc = vi.fn();
    vi.doMock("../../src/main/agent-maintenance", () => ({
      createAgentMaintenance: vi.fn(() => ({ start: maintenanceStart })),
      registerAgentMaintenanceIpc,
    }));
    const gatewayStart = vi.fn(() => Promise.resolve());
    vi.doMock("../../src/main/login-item", () => ({
      createLoginItemService: () => ({
        initialize: async () => {},
        wasOpenedAtLogin: () => quietLogin,
        get: async () => ({ available: false, openAtLogin: false, status: "unavailable" }),
        set: vi.fn(),
      }),
    }));
    const createAgentGateway = vi.fn(() => ({
      socketPath: "/tmp/omni-test-agent.sock",
      start: gatewayStart,
      stop: vi.fn(() => Promise.resolve()),
      tokenManager: { ensure: vi.fn(), rotate: vi.fn(), tokenCreatedAt: vi.fn() },
    }));

    vi.doMock("electron", () => ({
      safeStorage: {
        isEncryptionAvailable: vi.fn(() => true),
        encryptString: vi.fn((value: string) => Buffer.from(value)),
        decryptString: vi.fn((value: Buffer) => value.toString()),
      },
      app: {
        whenReady,
        setBadgeCount: vi.fn(),
        isPackaged: false,
        setPath,
        requestSingleInstanceLock: vi.fn(() => hasLock),
        on: appOn,
        once: vi.fn(),
        quit: appQuit,
        getPath: vi.fn(() => "/tmp/omni-test-user-data"),
        getVersion: vi.fn(() => "0.1.0-test"),
      },
      ipcMain: { handle: vi.fn() },
      BrowserWindow,
    }));
    vi.doMock("../../src/main/omni-guard-runtime", () => ({ ensureOmniGuardRuntime: vi.fn(async () => undefined) }));
    vi.doMock("../../src/main/guard-ipc", () => ({
      registerGuardIpcHandlers: vi.fn(),
      refreshGuardConfig: vi.fn(async () => undefined),
    }));
    vi.doMock("../../src/main/review-events", () => ({ watchReviewChanges: vi.fn(() => vi.fn()) }));
    vi.doMock("../../src/main/registry-ipc", () => ({ registerRegistryIpcHandlers }));
    vi.doMock("../../src/main/artifact-ipc", () => ({ registerArtifactIpcHandlers }));
    vi.doMock("../../src/main/operations-ipc", () => ({ registerOperationsIpcHandlers }));
    vi.doMock("../../src/main/bindings-ipc", () => ({ registerBindingsIpcHandlers }));
    vi.doMock("../../src/main/activity-ipc", () => ({ registerActivityIpcHandlers }));
    vi.doMock("../../src/main/apply-ipc", () => ({ registerApplyIpcHandlers }));
    vi.doMock("../../src/main/settings-ipc", () => ({ registerSettingsIpcHandlers }));
    vi.doMock("../../src/main/identity-ipc", () => ({ registerIdentityIpcHandlers: vi.fn() }));
    vi.doMock("../../src/main/omni-mcp-runtime", () => ({
      ensureOmniMcpRuntime: vi.fn(async () => undefined),
      writeDesktopManifest: vi.fn(async () => undefined),
    }));
    vi.doMock("../../src/main/agent-gateway/server", () => ({ createAgentGateway }));
    vi.doMock("../../src/main/renderer-security", () => ({
      assertTrustedSender: vi.fn(),
      createRendererPolicy: vi.fn(() => ({ packagedUrl: "file:///app/renderer/index.html" })),
      isTrustedRendererUrl: vi.fn(() => true),
    }));

    await import("../../src/main/index");
    if (!hasLock) {
      expect(appQuit).toHaveBeenCalledOnce();
      expect(whenReady).not.toHaveBeenCalled();
      expect(registerRegistryIpcHandlers).not.toHaveBeenCalled();
      expect(registerArtifactIpcHandlers).not.toHaveBeenCalled();
      expect(createAgentGateway).not.toHaveBeenCalled();
      return;
    }
    await vi.waitFor(() => expect(registerRegistryIpcHandlers).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(registerArtifactIpcHandlers).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(registerOperationsIpcHandlers).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(registerBindingsIpcHandlers).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(registerActivityIpcHandlers).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(registerApplyIpcHandlers).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(registerSettingsIpcHandlers).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(maintenanceStart).toHaveBeenCalledOnce());
    expect(registerAgentMaintenanceIpc).toHaveBeenCalledOnce();
    expect(gatewayStart).toHaveBeenCalledOnce();
    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({ show: false }));
    expect(showWindow).toHaveBeenCalledTimes(quietLogin ? 0 : 1);
    expect(focusWindow).not.toHaveBeenCalled();
    const activate = appOn.mock.calls.find(([event]) => event === "activate")![1];
    activate();
    expect(showWindow).toHaveBeenCalledTimes(quietLogin ? 1 : 2);
    expect(focusWindow).toHaveBeenCalledOnce();
    expect(libraryStart).not.toHaveBeenCalled();
    readyCallbacks[0]!();
    await vi.waitFor(() => expect(libraryStart).toHaveBeenCalledOnce());
  });
});
