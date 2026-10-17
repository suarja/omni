import { createMarketplaceConnectionOperations } from "./operations-connect-marketplace";
import { createStorefrontLinkOperations } from "./storefronts/link-operations";
import { createProjectRegistrationOperations } from "./operations-register-project";
import { createPublicationOperations } from "./storefronts/operations";
import type { GhCli } from "./gh-cli";
import { activeWorkshop } from "../domain/source-roles";
import { createProjectCaptureOperations } from "./operations-project-capture";
import { createSkillCaptureRestoreBridge } from "./skill-capture-restore-bridge";
import { createDescribePluginOperations } from "./operations-describe-plugin";
import { agentHomeDir } from "./agent-harnesses";
import { createDisconnectAgentsOperations } from "./operations-disconnect-agents";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { app, ipcMain } from "electron";

import type { RegistryIpcServices } from "./registry-ipc";
import { createOperationStore, type OperationStore } from "./operation-store";
import { systemGitCli, type GitCli } from "./git-cli";
import { createImportOperations } from "./operations-import";
import { createAddToProjectOperations, createCompositeRestoreOperations } from "./operations-add-to-project";
import { createCompatibleOperations } from "./operations-compatible";
import { createWriteSkillOperations } from "./operations-write-skill";
import { createRegisterMcpOperations } from "./operations-register-mcp";
import { createInstallAgentsOperations } from "./operations-install-agents";
import { createHarnessSettingOperations } from "./operations-harness-setting";
import { operationPaths } from "./operations-paths";
import { createRestoreOperations } from "./operations-restore";
import { createReceiptDiffOperations } from "./operations-receipt-diff";
import { bindingsFilePath, createBindingsStore } from "./bindings-store";
import { buildApplyPlan, executeApply, type ApplyPlan } from "./apply-engine";
import { registryState, engineOptions } from "./apply-ipc-helpers";
import { activeRegistration } from "./assignment-resolution";
import { createSettingsStore, settingsFilePath, type SettingsStore } from "./settings-store";
import { currentGrantRoot } from "./granted-hashing";
import { createMarketplaceOperations as createMarketplaceOperationsFactory } from "./operations-create-marketplace";
import type { ApplyRestoreBridge } from "./apply-ipc";
import { createSkillRecoveryAdapter } from "./skill-management/recovery";
import { createSkillOperationJournal } from "./skill-management/journal";
import { createMainSkillManagementService } from "./skill-management/service";
import { createExternalLibraryService, type ExternalLibraryService } from "./external-library/service";
import { createExternalSkillOperations } from "./external-library/operations";
import { createProjectSkillsAdapter } from "./skill-management/project-skills";
import { registerSkillManagementIpcHandlers } from "./skill-management/ipc";
import { createSkillAssignmentAdapter } from "./skill-management/assignment";
import { createSkillRemovalAdapter } from "./skill-management/removal";
import { createSkillAdoptionRecoveryAdapter } from "./skill-management/adoption-recovery";
import { createSkillResolutionAdapter } from "./skill-management/resolution";
import { createSkillResolutionRecoveryAdapter } from "./skill-management/resolution-recovery";
import { createSkillVariantCaptureAdapter } from "./skill-management/variant-capture";
import { createSkillVariantRecoveryAdapter } from "./skill-management/variant-recovery";
import { createSkillDetachmentComposition } from "./skill-management/detachment-composition";
import { createSkillDetachmentRecoveryAdapter } from "./skill-management/detachment-recovery";
import { createSkillPropagationAdapter } from "./skill-management/propagation-composition";
import { createSkillLinkAdapters } from "./skill-management/unbound-composition";
import { readSkillVariantOrigin } from "./skill-management/variant-origin-reader";
import { createSkillRelationshipStore } from "./skill-reconciliation/store";
import { createSkillBaseStore } from "./skill-reconciliation/bases";
import { createLegacyBindingBridge } from "./skill-management/legacy-binding-bridge";
import { createLegacyBindingRecovery } from "./skill-management/legacy-binding-recovery";
import { assertLegacyBindingsUnmanaged } from "./skill-management/legacy-binding-guard";
import type { BindingsIpcServices } from "./bindings-ipc";
import type { SkillManagementService } from "../application/skill-management";
import type { AgentRequestsStore } from "./agent-gateway/requests-store";
import {
  OPERATIONS_IPC_CHANNELS,
  parseApplyOperationRequest,
  parseEmptyOperationsRequest,
  parsePreviewOperationRequest,
  type ApplyOperationResponse,
  type OperationPlan,
  type OperationReceipt,
  type PreviewApplyPlanRequest,
  type PreviewMarketplaceResponse,
  parseReceiptDiffRequest,
  parseReceiptDiffResponse,
  type ReceiptDiffResponse,
} from "../shared/operations-ipc";
import { safeDiagnostic } from "./operations-ipc-helpers";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;
type Clock = () => number;
type FileWriter = (
  path: string,
  content: string | Uint8Array,
  options: { encoding: "utf8"; mode: number },
) => Promise<void>;
type StoredApplyPlan = Readonly<{ plan: ApplyPlan; request: PreviewApplyPlanRequest }>;

function block(reason: string, diagnostic: string): PreviewMarketplaceResponse {
  return { status: "blocked", reason, diagnostic };
}

type OperationsIpcOptions = Readonly<{
  externalLibrary?: ExternalLibraryService;
  now?: Clock;
  userDataPath?: string;
  operationStore?: OperationStore;
  gitCli?: GitCli;
  ghCli?: GhCli;
  fileWriter?: FileWriter;
  settingsStore?: SettingsStore;
  projectRegistrationPolicy?: import("./project-registration-path").RegistrationPathPolicy;
  homeDir?: string;
  cliPath?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  applyRestore?: ApplyRestoreBridge;
  bindings?: BindingsIpcServices;
  agentRequests?: AgentRequestsStore;
  onSkillProgress?: (intentId: string) => void;
}>;

export type OperationsIpcServices = Readonly<{
  externalLibrary?: ExternalLibraryService;
  previewOperation(request: unknown): Promise<PreviewMarketplaceResponse>;
  applyOperation(request: unknown): Promise<ApplyOperationResponse | undefined>;
  getReceiptDiff(request: unknown): Promise<ReceiptDiffResponse>;
  skillManagement: SkillManagementService;
}>;

export function registerOperationsIpcHandlers(
  assertTrustedSender: SenderGuard,
  registry: RegistryIpcServices,
  options: OperationsIpcOptions = {},
): OperationsIpcServices {
  options = {
    ...options,
    isPackaged: options.isPackaged ?? app.isPackaged,
    homeDir: agentHomeDir({ ...options, isPackaged: options.isPackaged ?? app.isPackaged }),
  };
  const now = options.now ?? Date.now;
  const userDataPath = resolve(options.userDataPath ?? app.getPath("userData"));
  const store = options.operationStore ?? createOperationStore(join(userDataPath, "omni", "operations.json"));
  const git = options.gitCli ?? systemGitCli;
  const settings = options.settingsStore ?? createSettingsStore(settingsFilePath(userDataPath));
  const externalLibrary =
    options.externalLibrary ??
    createExternalLibraryService({
      userDataPath,
      homeDir: options.homeDir,
      isPackaged: options.isPackaged,
      onChanged: () => options.onSkillProgress?.("external-library"),
    });
  const agentApplyPlans = new Map<string, StoredApplyPlan>();
  const bindingsStore = createBindingsStore(bindingsFilePath(userDataPath));
  const skillRelationships = createSkillRelationshipStore(join(userDataPath, "omni", "skill-relationships.json"));
  const skillBases = createSkillBaseStore(userDataPath);
  const skillJournal = createSkillOperationJournal(join(userDataPath, "omni", "skill-operations"));
  const legacyBridge = createLegacyBindingBridge({
    registry,
    bindings: bindingsStore,
    relationships: skillRelationships,
    bases: skillBases,
    operationStore: store,
    journal: skillJournal,
    now,
  });
  options.applyRestore?.onAssignmentCompleted?.(() => legacyBridge.run());
  const publicationOperations = createPublicationOperations({
    userDataPath,
    operationStore: store,
    git,
    gh: options.ghCli,
    now,
    homeDirectory: options.homeDir,
    fileWriter: options.fileWriter as import("./operation-files").FileWriter | undefined,
  });
  const describePluginOperations = createDescribePluginOperations({
    userDataPath,
    now,
    operationStore: store,
    git,
    settingsStore: settings,
    fileWriter: options.fileWriter as import("./operation-files").FileWriter | undefined,
  });
  const importOperations = createImportOperations(registry, {
    userDataPath,
    now,
    operationStore: store,
    git,
    fileWriter: options.fileWriter,
    settingsStore: settings,
  });
  const addToProjectOperations = createAddToProjectOperations(registry, {
    userDataPath,
    operationStore: store,
    git,
    registry,
    afterAssignment: () => legacyBridge.run(),
    fileWriter: options.fileWriter as import("./operation-files").FileWriter | undefined,
    importOperations,
    resourceOptions: {
      ...(options.isPackaged === undefined ? {} : { isPackaged: options.isPackaged }),
      ...(options.resourcesPath ? { resourcesPath: options.resourcesPath } : {}),
      ...(options.appPath ? { appPath: options.appPath } : {}),
    },
  });
  const compatibleOperations = createCompatibleOperations(registry, {
    userDataPath,
    now,
    operationStore: store,
    git,
    fileWriter: options.fileWriter,
    settingsStore: settings,
  });
  const writeSkillOperations = createWriteSkillOperations({
    userDataPath,
    now,
    operationStore: store,
    git,
    fileWriter: options.fileWriter,
  });
  const registerMcpOperations = createRegisterMcpOperations({
    userDataPath,
    now,
    operationStore: store,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.cliPath ? { cliPath: options.cliPath } : {}),
    ...(options.isPackaged === undefined ? {} : { isPackaged: options.isPackaged }),
    ...(options.resourcesPath ? { resourcesPath: options.resourcesPath } : {}),
    ...(options.appPath ? { appPath: options.appPath } : {}),
  });
  const disconnectAgentsOperations = createDisconnectAgentsOperations({
    ...options,
    userDataPath,
    operationStore: store,
  });
  const installAgentsOperations = createInstallAgentsOperations({
    userDataPath,
    operationStore: store,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.cliPath ? { cliPath: options.cliPath } : {}),
    ...(options.isPackaged === undefined ? {} : { isPackaged: options.isPackaged }),
    ...(options.resourcesPath ? { resourcesPath: options.resourcesPath } : {}),
    ...(options.appPath ? { appPath: options.appPath } : {}),
  });
  const harnessSettingOperations = createHarnessSettingOperations({
    userDataPath,
    now,
    operationStore: store,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  let restoreOperations: ReturnType<typeof createRestoreOperations>;
  const captureRestore = createSkillCaptureRestoreBridge(() => skillManagement, store);
  const compositeRestore = createCompositeRestoreOperations({
    operationStore: store,
    previewChild: (receipt) => {
      if (receipt.kind === "skill-management") return captureRestore.preview(receipt);
      if (receipt.kind !== "apply-plan")
        return restoreOperations.preview({ kind: "restore-import", operationId: receipt.operationId });
      if (!options.applyRestore)
        return Promise.resolve(
          block(
            "restore-child-unavailable",
            `Cannot restore ${receipt.displayTarget}: project restore bridge is unavailable.`,
          ),
        );
      return options.applyRestore.previewRestore({ operationId: receipt.operationId }).then((result) => {
        if (result.status === "blocked")
          return block(
            "restore-child-unavailable",
            `Cannot restore ${receipt.displayTarget}: ${result.diagnostic ?? result.reason}`,
          );
        return {
          status: "ready" as const,
          plan: {
            planId: result.planId,
            kind: "restore-apply" as const,
            displayTarget: receipt.displayTarget,
            actions: result.files.map((file) => ({
              kind: file.action === "delete" ? ("delete-file" as const) : ("write-file" as const),
              relativePath: file.relativePath,
            })),
            git: { mode: "unavailable" as const, warnings: [] },
          },
        };
      });
    },
    applyChild: (planId, kind) =>
      kind === "skill-management"
        ? captureRestore.apply(planId)
        : kind === "apply-plan"
          ? (options.applyRestore?.runRestore({ planId }) ??
            Promise.resolve({
              status: "blocked" as const,
              reason: "restore-child-unavailable",
              diagnostic: "The project restore bridge is unavailable.",
            }))
          : restoreOperations.apply({ planId }),
    now,
  });
  restoreOperations = createRestoreOperations({
    userDataPath,
    now,
    operationStore: store,
    git,
    composite: compositeRestore,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.cliPath ? { cliPath: options.cliPath } : {}),
    ...(options.isPackaged === undefined ? {} : { isPackaged: options.isPackaged }),
    ...(options.resourcesPath ? { resourcesPath: options.resourcesPath } : {}),
    ...(options.appPath ? { appPath: options.appPath } : {}),
  });
  const adoptionRecovery = createSkillAdoptionRecoveryAdapter({
    registry,
    relationships: skillRelationships,
    bindings: bindingsStore,
    bases: skillBases,
    operationStore: store,
    journal: skillJournal,
    now,
  });
  const resolution = createSkillResolutionAdapter({
    userDataPath,
    registry,
    relationships: skillRelationships,
    bindings: bindingsStore,
    bases: skillBases,
    operationStore: store,
    fileWriter: options.fileWriter as import("./operation-files").FileWriter | undefined,
    now,
  });
  const resolutionRecovery = createSkillResolutionRecoveryAdapter({
    userDataPath,
    registry,
    relationships: skillRelationships,
    bindings: bindingsStore,
    bases: skillBases,
    operationStore: store,
    journal: skillJournal,
    fileWriter: options.fileWriter as import("./operation-files").FileWriter | undefined,
    now,
  });
  const variantCapture = createSkillVariantCaptureAdapter({
    userDataPath,
    registry,
    relationships: skillRelationships,
    bindings: bindingsStore,
    operationStore: store,
    now,
  });
  const variantRecovery = createSkillVariantRecoveryAdapter({
    userDataPath,
    registry,
    relationships: skillRelationships,
    bindings: bindingsStore,
    bases: skillBases,
    operationStore: store,
    journal: skillJournal,
    now,
  });
  const { adoption, unboundResolution } = createSkillLinkAdapters({
    userDataPath,
    registry,
    relationships: skillRelationships,
    bindings: bindingsStore,
    bases: skillBases,
    operationStore: store,
    journal: skillJournal,
    ...(options.fileWriter ? { fileWriter: options.fileWriter as import("./operation-files").FileWriter } : {}),
    now,
  });
  const detachment = createSkillDetachmentComposition({
    registry,
    relationships: skillRelationships,
    bindings: bindingsStore,
    bases: skillBases,
    operationStore: store,
    ...(options.now ? { now } : {}),
  });
  const detachmentRecovery = createSkillDetachmentRecoveryAdapter({
    registry,
    relationships: skillRelationships,
    bindings: bindingsStore,
    bases: skillBases,
    operationStore: store,
    journal: skillJournal,
    ...(options.now ? { now } : {}),
  });
  const propagation = createSkillPropagationAdapter({
    userDataPath,
    registry,
    relationships: skillRelationships,
    bindings: bindingsStore,
    bases: skillBases,
    writeSkill: writeSkillOperations,
    operationStore: store,
    journal: skillJournal,
    now,
  });
  const projectSkills = createProjectSkillsAdapter({
    userDataPath,
    registry,
    relationships: skillRelationships,
    bindings: bindingsStore,
    bases: skillBases,
    operationStore: store,
    journal: skillJournal,
    now,
  });
  const skillManagement = createMainSkillManagementService({
    externalSkills: createExternalSkillOperations({
      userDataPath,
      registry,
      library: options.externalLibrary ?? externalLibrary,
      operationStore: store,
      journal: skillJournal,
      now,
      fileWriter: options.fileWriter as import("./operation-files").FileWriter | undefined,
    }),
    projectSkills,
    writeSkill: writeSkillOperations,
    restore: restoreOperations,
    operationStore: store,
    journal: skillJournal,
    ...(options.onSkillProgress ? { onProgress: options.onSkillProgress } : {}),
    recovery: createSkillRecoveryAdapter({
      userDataPath,
      registry,
      bindings: bindingsStore,
      operationStore: store,
      journal: skillJournal,
    }),
    adoption,
    adoptionRecovery,
    resolution,
    resolutionRecovery,
    variantCapture,
    variantRecovery,
    unboundResolution,
    detachment,
    detachmentRecovery,
    propagation,
    legacyBridge,
    legacyBridgeRecovery: createLegacyBindingRecovery({
      relationships: skillRelationships,
      operationStore: store,
      now,
    }),
    ...(options.applyRestore ? { applyRestore: options.applyRestore } : {}),
    ...(options.applyRestore && options.bindings
      ? {
          assignment: createSkillAssignmentAdapter({
            registry,
            bindings: options.bindings,
            applyRestore: options.applyRestore,
          }),
        }
      : {}),
    ...(options.applyRestore && options.bindings
      ? {
          removal: createSkillRemovalAdapter({
            registry,
            bindings: options.bindings,
            applyRestore: options.applyRestore,
            operationStore: store,
          }),
        }
      : {}),
    now,
  });
  registerSkillManagementIpcHandlers(assertTrustedSender, skillManagement, options.agentRequests, (source) =>
    readSkillVariantOrigin(source, { registry, now }),
  );
  const projectCaptures = createProjectCaptureOperations({
    registry,
    relationships: skillRelationships,
    bases: skillBases,
    service: skillManagement,
    imports: importOperations,
    store,
    now,
  });
  const receiptDiffOperations = createReceiptDiffOperations({
    userDataPath,
    operationStore: store,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  const marketplaceConnection = createMarketplaceConnectionOperations({
    userDataPath,
    store,
    now,
    onChanged: () => externalLibrary.refreshCopies(),
  });
  const storefrontLink = createStorefrontLinkOperations({ userDataPath, store, now });
  const projectRegistration = createProjectRegistrationOperations({
    registry,
    store,
    now,
    policy: options.projectRegistrationPolicy,
  });
  const createMarketplaceOperations = createMarketplaceOperationsFactory(registry, {
    userDataPath,
    now,
    operationStore: store,
    gitCli: git,
    ...(options.fileWriter ? { fileWriter: options.fileWriter } : {}),
  });
  const guard =
    <T>(handler: (request: unknown) => Promise<T>) =>
    async (event: Electron.IpcMainInvokeEvent, request: unknown): Promise<T> => {
      assertTrustedSender(event);
      try {
        return await handler(request);
      } catch (error: unknown) {
        throw new Error(safeDiagnostic(error));
      }
    };

  const previewOperation = async (rawRequest: unknown): Promise<PreviewMarketplaceResponse> => {
    const request = parsePreviewOperationRequest(rawRequest);
    if (request.kind === "connect-marketplace") return marketplaceConnection.preview(request);
    if (request.kind === "link-storefront") return storefrontLink.preview(request);
    if (request.kind === "register-project") return projectRegistration.preview(request);
    if (request.kind === "publish-plugin" || request.kind === "create-storefront" || request.kind === "retry-push")
      return publicationOperations.preview(request);
    if (request.kind === "restore-import") {
      const linkUndo = await storefrontLink.previewRestore(request.operationId);
      if (linkUndo) return linkUndo;
      const marketplaceUndo = await marketplaceConnection.previewRestore(request.operationId);
      if (marketplaceUndo) return marketplaceUndo;
      const projectUndo = await projectRegistration.previewRestore(request.operationId);
      if (projectUndo) return projectUndo;
      const publication = await publicationOperations.previewRestore(request);
      if (publication) return publication;
    }
    if (request.kind === "describe-plugin") return describePluginOperations.preview(request);
    if (request.kind === "create-marketplace") return createMarketplaceOperations.preview(request);
    if (request.kind === "apply-plan") return previewApplyPlan(request);
    if (request.kind === "make-compatible") return compatibleOperations.preview(request);
    if (request.kind === "write-skill") return writeSkillOperations.preview(request);
    if (request.kind === "register-mcp") return registerMcpOperations.preview(request);
    if (request.kind === "disconnect-agents") return disconnectAgentsOperations.preview(request);
    if (request.kind === "install-agents") return installAgentsOperations.preview(request);
    if (request.kind === "write-harness-setting") return harnessSettingOperations.preview(request);
    if (request.kind === "add-to-project") return addToProjectOperations.preview(request);
    return request.kind === "import-artifact" ? projectCaptures.preview(request) : restoreOperations.preview(request);
  };
  const previewApplyPlan = async (request: PreviewApplyPlanRequest): Promise<PreviewMarketplaceResponse> => {
    const state = await registryState(userDataPath);
    const project = activeRegistration(state, "project", request.projectId);
    const source = activeWorkshop(state);
    if (!project || !source)
      return {
        status: "blocked",
        reason: "entry-unavailable",
        diagnostic: "The project or marketplace is unavailable.",
      };
    const projectHandle = await registry.getGrantForEntry({ kind: "project", id: request.projectId });
    const sourceHandle = await registry.getGrantForEntry({ kind: "source", id: source.id });
    const projectGrant = projectHandle ? registry.get(projectHandle) : undefined;
    const sourceGrant = sourceHandle ? registry.get(sourceHandle) : undefined;
    if (
      !projectGrant ||
      !sourceGrant ||
      !(await currentGrantRoot(projectGrant)) ||
      !(await currentGrantRoot(sourceGrant))
    )
      return {
        status: "blocked",
        reason: "grant-invalid",
        diagnostic: "The project or marketplace grant is unavailable.",
      };
    const loaded = await bindingsStore.read();
    if (loaded.status !== "ready")
      return { status: "blocked", reason: "bindings-unavailable", diagnostic: "Bindings are unavailable." };
    const selectedIds = new Set(request.bindingIds ?? []);
    if (!selectedIds.size)
      return { status: "blocked", reason: "binding-selection-empty", diagnostic: "Select at least one assignment." };
    const selectedBindings = loaded.bindings.filter((binding) => selectedIds.has(binding.bindingId));
    try {
      await assertLegacyBindingsUnmanaged(selectedBindings, skillRelationships);
    } catch (error: unknown) {
      return block("managed-copy", safeDiagnostic(error));
    }
    if (selectedBindings.length !== selectedIds.size)
      return { status: "blocked", reason: "binding-unavailable", diagnostic: "A selected assignment is unavailable." };
    if (selectedBindings.some((binding) => binding.projectId !== request.projectId))
      return {
        status: "blocked",
        reason: "binding-project-mismatch",
        diagnostic: "A selected assignment belongs to another project.",
      };
    const applyPlan = await buildApplyPlan({
      projectId: request.projectId,
      displayName: project.displayName,
      projectGrant,
      sourceGrant,
      bindings: selectedBindings,
      settings: await settings.read(),
      git,
    });
    if (applyPlan.actions.some((item) => item.action.state === "blocked"))
      return { status: "blocked", reason: "plan-blocked", diagnostic: "One or more project targets are blocked." };
    const plan: OperationPlan = {
      planId: applyPlan.planId,
      kind: "apply-plan",
      displayTarget: applyPlan.displayName,
      actions: applyPlan.response.actions.map((action) => ({
        kind: "write-file" as const,
        relativePath: action.relativePath,
        ...(action.diff ? { diff: action.diff.text } : {}),
      })),
      git: { mode: applyPlan.response.git.mode, warnings: [] },
    };
    agentApplyPlans.set(plan.planId, { plan: applyPlan, request });
    return { status: "ready", plan };
  };
  const applyAgentPlan = async (rawRequest: unknown): Promise<ApplyOperationResponse | undefined> => {
    const request = parseApplyOperationRequest(rawRequest);
    const stored = agentApplyPlans.get(request.planId);
    if (!stored) return undefined;
    agentApplyPlans.delete(request.planId);
    const fresh = await previewApplyPlan(stored.request);
    if (fresh.status !== "ready" || fresh.plan.planId !== stored.plan.response.planId) {
      if (fresh.status === "ready") agentApplyPlans.delete(fresh.plan.planId);
      const receipt: OperationReceipt = {
        operationId: randomUUID(),
        kind: "apply-plan",
        status: "failed",
        appliedAt: new Date(now()).toISOString(),
        displayTarget: stored.plan.displayName,
        actions: stored.plan.response.actions.map((action) => ({
          kind: "write-file" as const,
          relativePath: action.relativePath,
          status: "failed" as const,
        })),
        git: { mode: stored.plan.response.git.mode },
        registered: null,
        project: { id: stored.request.projectId },
        diagnostic: "The project or marketplace changed after preview; preview again before applying.",
      };
      const appended = await store.append(receipt);
      if (appended.status !== "ready") throw new Error("A stale apply could not be recorded safely.");
      return { status: "failed", receipt };
    }
    const current = agentApplyPlans.get(fresh.plan.planId);
    agentApplyPlans.delete(fresh.plan.planId);
    if (!current) return undefined;
    const applied = await executeApply(
      current.plan,
      { planId: request.planId, resolutions: [] },
      {
        ...engineOptions(userDataPath, bindingsStore, store, await settings.read(), git, undefined, now),
        ...(request.provenance ? { provenance: request.provenance } : {}),
      },
    );
    if (applied.status === "applied") await legacyBridge.run();
    return applied;
  };
  const applyOperation = async (rawRequest: unknown) =>
    (await marketplaceConnection.apply(rawRequest)) ??
    (await storefrontLink.apply(rawRequest)) ??
    (await projectRegistration.apply(rawRequest)) ??
    (await publicationOperations.apply(rawRequest)) ??
    (await applyAgentPlan(rawRequest)) ??
    (await projectCaptures.apply(rawRequest)) ??
    (await describePluginOperations.apply(rawRequest)) ??
    (await compatibleOperations.apply(rawRequest)) ??
    (await writeSkillOperations.apply(rawRequest)) ??
    (await registerMcpOperations.apply(rawRequest)) ??
    (await installAgentsOperations.apply(rawRequest)) ??
    (await disconnectAgentsOperations.apply(rawRequest)) ??
    (await harnessSettingOperations.apply(rawRequest)) ??
    (await addToProjectOperations.apply(rawRequest)) ??
    (await restoreOperations.apply(rawRequest)) ??
    createMarketplaceOperations.apply(rawRequest);

  ipcMain.handle(
    OPERATIONS_IPC_CHANNELS.pickParent,
    guard(async (request) => {
      parseEmptyOperationsRequest(request);
      return createMarketplaceOperations.pickParent();
    }),
  );
  ipcMain.handle(OPERATIONS_IPC_CHANNELS.preview, guard(previewOperation));
  ipcMain.handle(OPERATIONS_IPC_CHANNELS.apply, guard(applyOperation));
  ipcMain.handle(
    OPERATIONS_IPC_CHANNELS.list,
    guard(async (request) => {
      parseEmptyOperationsRequest(request);
      const result = await store.read();
      if (result.status !== "ready") throw new Error(result.diagnostic);
      return { status: "ready" as const, receipts: result.receipts };
    }),
  );
  ipcMain.handle(
    OPERATIONS_IPC_CHANNELS.paths,
    guard(async (request) => {
      parseEmptyOperationsRequest(request);
      return operationPaths(userDataPath, join(userDataPath, "omni", "operations.json"));
    }),
  );
  const getReceiptDiff = async (rawRequest: unknown): Promise<ReceiptDiffResponse> => {
    const request = parseReceiptDiffRequest(rawRequest);
    return parseReceiptDiffResponse(await receiptDiffOperations.get(request));
  };
  ipcMain.handle(OPERATIONS_IPC_CHANNELS.receiptDiff, guard(getReceiptDiff));
  externalLibrary.bindOperations(skillManagement);
  return { previewOperation, applyOperation, getReceiptDiff, skillManagement, externalLibrary };
}
