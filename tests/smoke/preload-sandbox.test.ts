import { afterEach, describe, expect, it, vi } from "vitest";

describe("sandboxed preload boundary", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("electron");
    vi.doUnmock("node:crypto");
  });

  it("validates plugin descriptions and the single-agent removal before crossing IPC", async () => {
    const expose = vi.fn();
    const invoke = vi.fn(async () => ({ status: "blocked", reason: "fixture", diagnostic: "No write." }));
    vi.doMock("electron", () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke } }));
    await import("../../src/preload/index");
    const api = expose.mock.calls[0]![1] as import("../../src/shared/ipc").DesktopApi;
    await expect(
      api.previewOperation!({ kind: "describe-plugin", packageId: "packages/tools", description: "" }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    await expect(
      api.previewOperation!({ kind: "describe-plugin", packageId: "packages/tools", description: "Review tools." }),
    ).resolves.toMatchObject({ status: "blocked" });
    invoke.mockClear();
    await expect(
      api.previewSkillOperation!({
        intent: {
          kind: "project-skill",
          projectId: "project-a",
          rowId: "review",
          action: "remove-agent",
          harnessIds: ["codex", "claude-code"],
        },
      }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce({
      status: "blocked",
      intentId: "11111111-1111-4111-8111-111111111111",
      reason: "fixture",
      details: [],
    } as never);
    await expect(
      api.previewSkillOperation!({
        intent: {
          kind: "project-skill",
          projectId: "project-a",
          rowId: "review",
          action: "remove-agent",
          harnessIds: ["codex"],
        },
      }),
    ).resolves.toMatchObject({ status: "blocked" });
    expect(invoke).toHaveBeenCalledWith("omni:skill-management:preview", {
      intent: {
        kind: "project-skill",
        projectId: "project-a",
        rowId: "review",
        action: "remove-agent",
        harnessIds: ["codex"],
      },
    });
  });

  it("validates notification request ids and unsubscribes the open-request event", async () => {
    const expose = vi.fn();
    const on = vi.fn();
    const removeListener = vi.fn();
    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld: expose },
      ipcRenderer: { on, removeListener },
    }));
    await import("../../src/preload/index");
    const api = expose.mock.calls[0]![1];
    const listener = vi.fn();
    const unsubscribe = api.onOpenAgentRequest(listener);
    expect(on).toHaveBeenCalledWith("omni:agents:open-request", expect.any(Function));
    const receive = on.mock.calls[0]![1];
    receive({}, { requestId: "request-one" });
    receive({}, { requestId: "../invalid" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("request-one");
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith("omni:agents:open-request", receive);
  });

  it("subscribes to review changes without exposing Electron event objects", async () => {
    const expose = vi.fn();
    const on = vi.fn();
    const removeListener = vi.fn();
    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld: expose },
      ipcRenderer: { invoke: vi.fn(), on, removeListener },
    }));
    await import("../../src/preload/index");
    const api = expose.mock.calls[0]![1] as { onReviewChanged: (listener: () => void) => () => void };
    const listener = vi.fn();
    const unsubscribe = api.onReviewChanged(listener);
    expect(on).toHaveBeenCalledWith("omni:review-changed", expect.any(Function));
    on.mock.calls[0]![1]({ secretElectronObject: true }, "ignored payload");
    expect(listener).toHaveBeenCalledWith();
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith("omni:review-changed", on.mock.calls[0]![1]);
  });

  it("validates project skill requests before IPC and rejects malformed project skill responses", async () => {
    const expose = vi.fn();
    const view = {
      projectId: "project-a",
      skills: [],
      activeSkillCount: { "claude-code": 0, codex: 0 },
      startupCost: { "claude-code": 0, codex: 0 },
      diagnostics: [],
    };
    const invoke = vi.fn(async () => view);
    vi.doMock("electron", () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke } }));
    await import("../../src/preload/index");
    const api = expose.mock.calls[0]![1] as import("../../src/shared/skill-management-ipc").SkillManagementDesktopApi;
    await expect(api.readProjectSkills("../project")).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    await expect(api.readProjectSkills("project-a")).resolves.toEqual(view);
    expect(invoke).toHaveBeenCalledWith("omni:skill-management:project-skills", { projectId: "project-a" });
    invoke.mockResolvedValueOnce({ ...view, activeSkillCount: { "claude-code": -1, codex: 0 } });
    await expect(api.readProjectSkills("project-a")).rejects.toThrow();
  });

  it("exposes the bridge without requiring unavailable Node modules", async () => {
    const exposeInMainWorld = vi.fn();

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke: vi.fn() },
    }));
    vi.doMock("node:crypto", () => {
      throw new Error("node:crypto is unavailable in a sandboxed preload");
    });

    await import("../../src/preload/index");

    const api = exposeInMainWorld.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(api).toBeDefined();
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
        beginAgentApply: expect.any(Function),
        endAgentApply: expect.any(Function),
        hashArtifacts: expect.any(Function),
        getOperationPaths: expect.any(Function),
        getReceiptDiff: expect.any(Function),
        listOperations: expect.any(Function),
        listRegistry: expect.any(Function),
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
        getSettings: expect.any(Function),
        setSettings: expect.any(Function),
        previewApply: expect.any(Function),
        runApply: expect.any(Function),
        previewRemove: expect.any(Function),
        runRemove: expect.any(Function),
        previewRestoreApply: expect.any(Function),
        runRestoreApply: expect.any(Function),
        simulateActivity: expect.any(Function),
        openTerminal: expect.any(Function),
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
    expect(Object.keys(api ?? {}).sort()).toEqual(
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
        "getActivitySnapshot",
        "getAcademyFirstLaunch",
        "getAcademyLesson",
        "getAcademyScreenshot",
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
        "hashArtifacts",
        "listAgentJobs",
        "listAgentRequests",
        "listAcademyLessons",
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
        "readWorkspaceSkillUses",
        "readProjectSkills",
        "readSkillPropagationCandidates",
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
        "removeBinding",
        "removeAiConnection",
        "removeAiKey",
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
  });
});

describe("agent maintenance preload contract", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("electron");
  });
  it("validates state and retry targets for both new channels", async () => {
    const expose = vi.fn();
    const invoke = vi.fn(async () => ({ updating: [], failures: [] }));
    vi.doMock("electron", () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke } }));
    await import("../../src/preload/index");
    const api = expose.mock.calls[0]![1] as import("../../src/shared/agent-maintenance-ipc").AgentMaintenanceDesktopApi;
    await expect(api.getAgentMaintenance()).resolves.toEqual({ updating: [], failures: [] });
    expect(invoke).toHaveBeenLastCalledWith("omni:agents:maintenance", {});
    await api.retryAgentUpdate({ harness: "codex" });
    expect(invoke).toHaveBeenLastCalledWith("omni:agents:retry-update", { harness: "codex" });
    invoke.mockClear();
    await expect(api.retryAgentUpdate({ harness: "unknown" } as never)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce({ updating: ["other"], failures: [] } as never);
    await expect(api.getAgentMaintenance()).rejects.toThrow();
  });
});
