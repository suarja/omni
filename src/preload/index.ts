import { createAppUpdatesDesktopApi } from "./app-updates";
import { LOGIN_ITEM_CHANNELS, parseLoginItemSetRequest, parseLoginItemState } from "../shared/login-item-ipc";
import { createExternalLibraryUiDesktopApi } from "./external-library-ui";
import { createExternalLibraryDesktopApi } from "./external-library";
import {
  STOREFRONT_PRESENTATION_CHANNELS,
  parseStorefrontSourceRequest,
  parseStorefrontDetails,
  parseStorefrontCapabilities,
  parseStorefrontOpened,
  parsePublicationContentRequest,
  parsePublicationContentChecks,
} from "../shared/storefront-presentation-ipc";
import { parseProjectGrantRequest, parseProjectInspectionResponse } from "../shared/project-inspection-ipc";
import {
  AGENT_MAINTENANCE_CHANNELS,
  parseAgentMaintenanceState,
  parseAgentUpdateRetry,
} from "../shared/agent-maintenance-ipc";
import { WORKSPACE_SKILL_USES_CHANNEL, parseWorkspaceSkillUsesResponse } from "../shared/workspace-skill-uses-ipc";
import { parseProjectSkills, parseProjectSkillsRequest } from "../shared/project-skills-ipc";
import { REVIEW_CHANGED_CHANNEL } from "../shared/review-events";
import { contextBridge, ipcRenderer } from "electron";
import {
  STOREFRONTS_IPC_CHANNELS,
  parseStorefrontDriftReport,
  parseStorefrontInspectResponse,
  parseStorefrontLinkRequest,
  parseStorefrontLinkResult,
} from "../shared/storefronts-ipc";

import {
  REGISTRY_IPC_CHANNELS,
  parseEmptyRegistryRequest,
  parseObservationResponse,
  parseObserveProjectRequest,
  parseObserveSourceRequest,
  parseOpenEntryResponse,
  parseRegisterProjectResponse,
  parseRegisterSourceRequest,
  parseRegisterSourceResponse,
  parseRegistryEntryRequest,
  parseRegistryLifecycleRequest,
  parseRegistryMutationResponse,
  parseRegistryViewResponse,
} from "../shared/registry-ipc";
import { ARTIFACT_IPC_CHANNELS, parseReadArtifactRequest, parseReadArtifactResponse } from "../shared/artifact-ipc";
import { IDENTITY_IPC_CHANNELS, parseHashArtifactsRequest, parseHashArtifactsResponse } from "../shared/identity-ipc";
import type { DesktopApi } from "../shared/ipc";
import {
  OPERATIONS_IPC_CHANNELS,
  parseApplyOperationRequest,
  parseApplyOperationResponse,
  parseEmptyOperationsRequest,
  parsePickParentResponse,
  parsePreviewMarketplaceResponse,
  parsePreviewOperationRequest,
  parseReceiptDiffRequest,
  parseReceiptDiffResponse,
} from "../shared/operations-ipc";
import { parseListOperationsResponse } from "../shared/operations-receipt-parsers";
import { parsePathsResponse } from "../shared/operations-import-ipc";
import {
  ACTIVITY_IPC_CHANNELS,
  parseActivityApplyRequest,
  parseActivityApplyResponse,
  parseActivityOpenTerminalRequest,
  parseActivityOpenTerminalResponse,
  parseActivityPortsRequest,
  parseActivityPortsResponse,
  parseActivityPreviewRequest,
  parseActivityPreviewResponse,
  parseActivitySimulationRequest,
  parseActivitySimulationResponse,
  parseActivitySnapshotResponse,
  parseEmptyActivityRequest,
} from "../shared/activity-ipc";
import {
  BINDINGS_IPC_CHANNELS,
  parseBindingsListResponse,
  parseBindingsMutationResponse,
  parseBindingsPreviewRequest,
  parseBindingsPreviewResponse,
  parseBindingsSaveRequest,
  parseBindingsRemoveRequest,
  parseEmptyBindingsRequest,
} from "../shared/bindings-ipc";
import {
  APPLY_IPC_CHANNELS,
  parseApplyMutationResponse,
  parseApplyPreviewRequest,
  parseApplyPreviewResponse,
  parseApplyRunRequest,
  parseRemovePreviewRequest,
  parseRemovePreviewResponse,
  parseRemoveRunRequest,
  parseRestorePreviewRequest,
  parseRestorePreviewResponse,
  parseRestoreRunRequest,
} from "../shared/apply-ipc";
import {
  SETTINGS_IPC_CHANNELS,
  parseEmptySettingsRequest,
  parseSettingsResponse,
  parseSettingsSetRequest,
} from "../shared/settings-ipc";
import {
  AGENTS_IPC_CHANNELS,
  parseAgentBeginApplyRequest,
  parseAgentEndApplyRequest,
  parseAgentApplyAuthorization,
  parseAgentDeclineRequest,
  parseAgentMutationResponse,
  parseAgentRequestResponse,
  parseAgentResolveRequest,
  parseAgentStatusResponse,
  parseEmptyAgentsRequest,
} from "../shared/agents-ipc";
import {
  GUARD_IPC_CHANNELS,
  parseSetGuardProjectModeRequest,
  parseSetGuardProjectModeResponse,
} from "../shared/guard-ipc";
import {
  STACK_PROFILE_IPC_CHANNELS,
  parseStackProfileRequest,
  parseStackProfileResponse,
} from "../shared/stack-profile-ipc";
import {
  CATALOGUE_IPC_CHANNELS,
  parseCatalogueEntryRequest,
  parseCatalogueEntryResponse,
  parseCataloguePrepareImportRequest,
  parseCataloguePrepareImportResponse,
  parseCatalogueSearchRequest,
  parseCatalogueSearchResponse,
} from "../shared/catalogue-ipc";
import {
  parseAiConnectionResponse,
  parseAiConnectionSetRequest,
  parseAiConnectionTestResponse,
  parseAiFunctionsSetRequest,
  parseAiKeySetRequest,
  parseAiModelResponse,
  parseAiPresetsResponse,
  parseInferenceKeyMutationResponse,
  parseAiUsageResponse,
  AI_GATEWAY_IPC_CHANNELS,
} from "../shared/ai-gateway-ipc";
import {
  INFERENCE_IPC_CHANNELS,
  parseEmptyInferenceRequest,
  parseInferenceDryRunRequest,
  parseInferenceDryRunResponse,
  parseInferenceRunRequest,
  parseInferenceRunResponse,
} from "../shared/inference-ipc";
import {
  ACADEMY_IPC_CHANNELS,
  parseAcademyFirstLaunchResponse,
  parseAcademyLessonRequest,
  parseAcademyLessonResponse,
  parseAcademyListRequest,
  parseAcademyListResponse,
  parseAcademyScreenshotRequest,
  parseAcademyScreenshotResponse,
} from "../shared/academy-ipc";
import {
  AGENT_JOBS_IPC_CHANNELS,
  parseAgentJobListResponse,
  parseAgentJobStartRequest,
  parseAgentJobStartResponse,
  parseAgentJobStopRequest,
  parseAgentJobStopResponse,
  parseEmptyAgentJobsRequest,
} from "../shared/agent-jobs-ipc";
import {
  SKILL_MANAGEMENT_IPC_CHANNELS,
  parseSkillManagementApplyRequest,
  parseSkillManagementPreviewRequest,
  parseSkillManagementRefreshRequest,
  parseSkillManagementResultRequest,
  parseSkillPreview,
  parseSkillResult,
} from "../shared/skill-management-ipc";
import {
  parseReadSkillVariantOriginRequest,
  parseReadSkillVariantOriginResponse,
} from "../shared/skill-variant-effects";
import {
  parseSkillPropagationCandidates,
  parseSkillPropagationCandidatesRequest,
} from "../shared/skill-propagation-ipc";
import {
  SKILL_RECONCILIATION_IPC_CHANNELS,
  parseObserveSkillCopiesRequest,
  parseObserveSkillCopiesResponse,
} from "../shared/skill-reconciliation-ipc";
import {
  SKILL_COPY_COMPARISON_CHANNEL,
  parseSkillCopyComparisonRequest,
  parseSkillCopyComparisonResponse,
} from "../shared/skill-copy-comparison-ipc";

const api: DesktopApi = {
  onOpenAgentRequest: (listener) => {
    const receive = (_event: unknown, value: unknown): void => {
      let requestId: string;
      try {
        requestId = parseAgentDeclineRequest(value).requestId;
      } catch {
        return;
      }
      listener(requestId);
    };
    ipcRenderer.on(AGENTS_IPC_CHANNELS.openRequest, receive);
    return () => {
      ipcRenderer.removeListener(AGENTS_IPC_CHANNELS.openRequest, receive);
    };
  },
  onReviewChanged: (listener) => {
    const receive = (): void => listener();
    ipcRenderer.on(REVIEW_CHANGED_CHANNEL, receive);
    return () => {
      ipcRenderer.removeListener(REVIEW_CHANGED_CHANNEL, receive);
    };
  },
  listRegistry: async () => {
    parseEmptyRegistryRequest({});
    return parseRegistryViewResponse(await ipcRenderer.invoke(REGISTRY_IPC_CHANNELS.listRegistry, {}));
  },
  ...createExternalLibraryUiDesktopApi((channel, request) => ipcRenderer.invoke(channel, request)),
  ...createExternalLibraryDesktopApi((channel, request) => ipcRenderer.invoke(channel, request)),
  readPublicationContentChecks: async (request) =>
    parsePublicationContentChecks(
      await ipcRenderer.invoke(STOREFRONT_PRESENTATION_CHANNELS.contentChecks, parsePublicationContentRequest(request)),
    ),
  readStorefrontDetails: async (request) =>
    parseStorefrontDetails(
      await ipcRenderer.invoke(STOREFRONT_PRESENTATION_CHANNELS.details, parseStorefrontSourceRequest(request)),
    ),
  readStorefrontCapabilities: async () =>
    parseStorefrontCapabilities(await ipcRenderer.invoke(STOREFRONT_PRESENTATION_CHANNELS.capabilities, {})),
  openStorefrontRepository: async (request) =>
    parseStorefrontOpened(
      await ipcRenderer.invoke(STOREFRONT_PRESENTATION_CHANNELS.openRepository, parseStorefrontSourceRequest(request)),
    ),
  inspectStorefront: async () =>
    parseStorefrontInspectResponse(await ipcRenderer.invoke(STOREFRONTS_IPC_CHANNELS.inspect, {})),
  linkStorefront: async (request) =>
    parseStorefrontLinkResult(
      await ipcRenderer.invoke(STOREFRONTS_IPC_CHANNELS.link, parseStorefrontLinkRequest(request)),
    ),
  readStorefrontDrift: async () =>
    parseStorefrontDriftReport(await ipcRenderer.invoke(STOREFRONTS_IPC_CHANNELS.drift, {})),
  inspectProject: async () =>
    parseProjectInspectionResponse(await ipcRenderer.invoke(REGISTRY_IPC_CHANNELS.inspectProject, {})),
  registerInspectedProject: async (request) =>
    parseRegisterProjectResponse(
      await ipcRenderer.invoke(REGISTRY_IPC_CHANNELS.registerInspectedProject, parseProjectGrantRequest(request)),
    ),
  registerProject: async () => {
    parseEmptyRegistryRequest({});
    return parseRegisterProjectResponse(await ipcRenderer.invoke(REGISTRY_IPC_CHANNELS.registerProject, {}));
  },
  registerSource: async (request) => {
    const parsed = parseRegisterSourceRequest(request);
    return parseRegisterSourceResponse(await ipcRenderer.invoke(REGISTRY_IPC_CHANNELS.registerSource, parsed));
  },
  openEntry: async (request) => {
    const parsed = parseRegistryEntryRequest(request);
    return parseOpenEntryResponse(await ipcRenderer.invoke(REGISTRY_IPC_CHANNELS.openEntry, parsed));
  },
  observeProject: async (request) => {
    const parsed = parseObserveProjectRequest(request);
    return parseObservationResponse(await ipcRenderer.invoke(REGISTRY_IPC_CHANNELS.observeProject, parsed));
  },
  observeSource: async (request) => {
    const parsed = parseObserveSourceRequest(request);
    return parseObservationResponse(await ipcRenderer.invoke(REGISTRY_IPC_CHANNELS.observeSource, parsed));
  },
  archiveEntry: async (request) => {
    const parsed = parseRegistryLifecycleRequest(request);
    return parseRegistryMutationResponse(await ipcRenderer.invoke(REGISTRY_IPC_CHANNELS.archiveEntry, parsed));
  },
  reactivateEntry: async (request) => {
    const parsed = parseRegistryLifecycleRequest(request);
    return parseRegistryMutationResponse(await ipcRenderer.invoke(REGISTRY_IPC_CHANNELS.reactivateEntry, parsed));
  },
  readArtifact: async (request) => {
    const parsed = parseReadArtifactRequest(request);
    return parseReadArtifactResponse(await ipcRenderer.invoke(ARTIFACT_IPC_CHANNELS.readArtifact, parsed));
  },
  readWorkspaceSkillUses: async () =>
    parseWorkspaceSkillUsesResponse(await ipcRenderer.invoke(WORKSPACE_SKILL_USES_CHANNEL)),
  observeSkillCopies: async (request) => {
    const parsed = parseObserveSkillCopiesRequest(request);
    return parseObserveSkillCopiesResponse(await ipcRenderer.invoke(SKILL_RECONCILIATION_IPC_CHANNELS.observe, parsed));
  },
  compareSkillCopies: async (request) => {
    const parsed = parseSkillCopyComparisonRequest(request);
    return parseSkillCopyComparisonResponse(await ipcRenderer.invoke(SKILL_COPY_COMPARISON_CHANNEL, parsed));
  },
  listSkillOperationRecoveries: async () => {
    const saved = await ipcRenderer.invoke(SKILL_MANAGEMENT_IPC_CHANNELS.recoveries, {});
    if (!Array.isArray(saved)) throw new Error("Skill recovery response is invalid.");
    return saved.map(parseSkillResult);
  },
  readProjectSkills: async (projectId) => {
    const parsed = parseProjectSkillsRequest({ projectId });
    return parseProjectSkills(await ipcRenderer.invoke(SKILL_MANAGEMENT_IPC_CHANNELS.projectSkills, parsed));
  },
  previewSkillOperation: async (request) => {
    const parsed = parseSkillManagementPreviewRequest(request);
    return parseSkillPreview(await ipcRenderer.invoke(SKILL_MANAGEMENT_IPC_CHANNELS.preview, parsed));
  },
  refreshSkillOperation: async (request) => {
    const parsed = parseSkillManagementRefreshRequest(request);
    return parseSkillPreview(await ipcRenderer.invoke(SKILL_MANAGEMENT_IPC_CHANNELS.refresh, parsed));
  },
  applySkillOperation: async (request) => {
    const parsed = parseSkillManagementApplyRequest(request);
    return parseSkillResult(await ipcRenderer.invoke(SKILL_MANAGEMENT_IPC_CHANNELS.apply, parsed));
  },
  readSkillOperationResult: async (request) => {
    const parsed = parseSkillManagementResultRequest(request);
    const result = await ipcRenderer.invoke(SKILL_MANAGEMENT_IPC_CHANNELS.result, parsed);
    return result === undefined ? undefined : parseSkillResult(result);
  },
  readSkillVariantOrigin: async (source) => {
    const parsed = parseReadSkillVariantOriginRequest({ source });
    const result = await ipcRenderer.invoke(SKILL_MANAGEMENT_IPC_CHANNELS.variantOrigin, parsed);
    return parseReadSkillVariantOriginResponse(result, parsed.source);
  },
  readSkillPropagationCandidates: async (source) => {
    const parsed = parseSkillPropagationCandidatesRequest({ source });
    const result = await ipcRenderer.invoke(SKILL_MANAGEMENT_IPC_CHANNELS.propagationCandidates, { source: parsed });
    return parseSkillPropagationCandidates(result);
  },
  hashArtifacts: async (request) => {
    const parsed = parseHashArtifactsRequest(request);
    return parseHashArtifactsResponse(await ipcRenderer.invoke(IDENTITY_IPC_CHANNELS.hashArtifacts, parsed));
  },
  pickOperationParent: async () => {
    parseEmptyOperationsRequest({});
    return parsePickParentResponse(await ipcRenderer.invoke(OPERATIONS_IPC_CHANNELS.pickParent, {}));
  },
  previewOperation: async (request) => {
    const parsed = parsePreviewOperationRequest(request);
    return parsePreviewMarketplaceResponse(await ipcRenderer.invoke(OPERATIONS_IPC_CHANNELS.preview, parsed));
  },
  applyOperation: async (request) => {
    const parsed = parseApplyOperationRequest(request);
    return parseApplyOperationResponse(await ipcRenderer.invoke(OPERATIONS_IPC_CHANNELS.apply, parsed));
  },
  listOperations: async () => {
    parseEmptyOperationsRequest({});
    return parseListOperationsResponse(await ipcRenderer.invoke(OPERATIONS_IPC_CHANNELS.list, {}));
  },
  getReceiptDiff: async (request) => {
    const parsed = parseReceiptDiffRequest(request);
    return parseReceiptDiffResponse(await ipcRenderer.invoke(OPERATIONS_IPC_CHANNELS.receiptDiff, parsed));
  },
  getOperationPaths: async () => parsePathsResponse(await ipcRenderer.invoke(OPERATIONS_IPC_CHANNELS.paths, {})),
  listBindings: async () => {
    parseEmptyBindingsRequest({});
    return parseBindingsListResponse(await ipcRenderer.invoke(BINDINGS_IPC_CHANNELS.list, {}));
  },
  previewBindings: async (request) => {
    const parsed = parseBindingsPreviewRequest(request);
    return parseBindingsPreviewResponse(await ipcRenderer.invoke(BINDINGS_IPC_CHANNELS.preview, parsed));
  },
  saveBindings: async (request) => {
    const parsed = parseBindingsSaveRequest(request);
    return parseBindingsMutationResponse(await ipcRenderer.invoke(BINDINGS_IPC_CHANNELS.save, parsed));
  },
  removeBinding: async (request) => {
    const parsed = parseBindingsRemoveRequest(request);
    return parseBindingsMutationResponse(await ipcRenderer.invoke(BINDINGS_IPC_CHANNELS.remove, parsed));
  },
  getActivitySnapshot: async () => {
    parseEmptyActivityRequest({});
    return parseActivitySnapshotResponse(await ipcRenderer.invoke(ACTIVITY_IPC_CHANNELS.snapshot, {}));
  },
  previewActivity: async (request) => {
    const parsed = parseActivityPreviewRequest(request);
    return parseActivityPreviewResponse(await ipcRenderer.invoke(ACTIVITY_IPC_CHANNELS.preview, parsed));
  },
  applyActivity: async (request) => {
    const parsed = parseActivityApplyRequest(request);
    return parseActivityApplyResponse(await ipcRenderer.invoke(ACTIVITY_IPC_CHANNELS.apply, parsed));
  },
  simulateActivity: async (request) => {
    const parsed = parseActivitySimulationRequest(request);
    return parseActivitySimulationResponse(await ipcRenderer.invoke(ACTIVITY_IPC_CHANNELS.simulate, parsed));
  },
  getListeningPorts: async (request) => {
    const parsed = parseActivityPortsRequest(request);
    return parseActivityPortsResponse(await ipcRenderer.invoke(ACTIVITY_IPC_CHANNELS.ports, parsed));
  },
  openTerminal: async (request) => {
    const parsed = parseActivityOpenTerminalRequest(request);
    return parseActivityOpenTerminalResponse(await ipcRenderer.invoke(ACTIVITY_IPC_CHANNELS.openTerminal, parsed));
  },
  ...createAppUpdatesDesktopApi(),
  getLoginItem: async () => parseLoginItemState(await ipcRenderer.invoke(LOGIN_ITEM_CHANNELS.get, {})),
  setLoginItem: async (request) =>
    parseLoginItemState(await ipcRenderer.invoke(LOGIN_ITEM_CHANNELS.set, parseLoginItemSetRequest(request))),
  getSettings: async () => {
    parseEmptySettingsRequest({});
    return parseSettingsResponse(await ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.get, {}));
  },
  setSettings: async (request) => {
    const parsed = parseSettingsSetRequest(request);
    return parseSettingsResponse(await ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.set, parsed));
  },
  listAgentRequests: async () => {
    parseEmptyAgentsRequest({});
    const trace = process.env.OMNI_RECEPTION_TRACE === "1";
    try {
      const result = parseAgentRequestResponse(await ipcRenderer.invoke(AGENTS_IPC_CHANNELS.list, {}));
      if (trace) console.info(`[omni-reception] preload agent-list count=${result.requests.length}`);
      return result;
    } catch (error: unknown) {
      if (trace)
        console.error(
          `[omni-reception] agent-list rejected: ${error instanceof Error ? error.message.slice(0, 240) : "Unknown error"}`,
        );
      throw error;
    }
  },
  refreshAgentRequest: async (requestId) => {
    const parsed = parseAgentDeclineRequest({ requestId });
    return parseAgentMutationResponse(await ipcRenderer.invoke(AGENTS_IPC_CHANNELS.refresh, parsed));
  },
  beginAgentApply: async (request) => {
    const parsed = parseAgentBeginApplyRequest(request);
    return parseAgentApplyAuthorization(await ipcRenderer.invoke(AGENTS_IPC_CHANNELS.beginApply, parsed));
  },
  endAgentApply: async (request) => {
    const parsed = parseAgentEndApplyRequest(request);
    await ipcRenderer.invoke(AGENTS_IPC_CHANNELS.endApply, parsed);
  },
  resolveAgentRequest: async (request) => {
    const parsed = parseAgentResolveRequest(request);
    return parseAgentMutationResponse(await ipcRenderer.invoke(AGENTS_IPC_CHANNELS.resolve, parsed));
  },
  declineAgentRequest: async (request) => {
    const parsed = parseAgentDeclineRequest(request);
    return parseAgentMutationResponse(await ipcRenderer.invoke(AGENTS_IPC_CHANNELS.decline, parsed));
  },
  getAgentMaintenance: async () =>
    parseAgentMaintenanceState(await ipcRenderer.invoke(AGENT_MAINTENANCE_CHANNELS.get, {})),
  retryAgentUpdate: async (request) =>
    parseAgentMaintenanceState(
      await ipcRenderer.invoke(AGENT_MAINTENANCE_CHANNELS.retry, parseAgentUpdateRetry(request)),
    ),
  getAgentStatus: async () => {
    parseEmptyAgentsRequest({});
    return parseAgentStatusResponse(await ipcRenderer.invoke(AGENTS_IPC_CHANNELS.status, {}));
  },
  rotateAgentToken: async () => {
    parseEmptyAgentsRequest({});
    return parseAgentStatusResponse(await ipcRenderer.invoke(AGENTS_IPC_CHANNELS.rotateToken, {}));
  },
  setGuardProjectMode: async (request) => {
    const parsed = parseSetGuardProjectModeRequest(request);
    return parseSetGuardProjectModeResponse(await ipcRenderer.invoke(GUARD_IPC_CHANNELS.setProjectMode, parsed));
  },
  previewApply: async (request) => {
    const parsed = parseApplyPreviewRequest(request);
    return parseApplyPreviewResponse(await ipcRenderer.invoke(APPLY_IPC_CHANNELS.preview, parsed));
  },
  runApply: async (request) => {
    const parsed = parseApplyRunRequest(request);
    return parseApplyMutationResponse(await ipcRenderer.invoke(APPLY_IPC_CHANNELS.run, parsed));
  },
  previewRemove: async (request) => {
    const parsed = parseRemovePreviewRequest(request);
    return parseRemovePreviewResponse(await ipcRenderer.invoke(APPLY_IPC_CHANNELS.removePreview, parsed));
  },
  runRemove: async (request) => {
    const parsed = parseRemoveRunRequest(request);
    return parseApplyMutationResponse(await ipcRenderer.invoke(APPLY_IPC_CHANNELS.removeRun, parsed));
  },
  previewRestoreApply: async (request) => {
    const parsed = parseRestorePreviewRequest(request);
    return parseRestorePreviewResponse(await ipcRenderer.invoke(APPLY_IPC_CHANNELS.restorePreview, parsed));
  },
  runRestoreApply: async (request) => {
    const parsed = parseRestoreRunRequest(request);
    return parseApplyMutationResponse(await ipcRenderer.invoke(APPLY_IPC_CHANNELS.restoreRun, parsed));
  },
  getStackProfile: async (request) => {
    const parsed = parseStackProfileRequest(request);
    return parseStackProfileResponse(await ipcRenderer.invoke(STACK_PROFILE_IPC_CHANNELS.get, parsed));
  },
  searchCatalogue: async (request) => {
    const parsed = parseCatalogueSearchRequest(request);
    return parseCatalogueSearchResponse(await ipcRenderer.invoke(CATALOGUE_IPC_CHANNELS.search, parsed));
  },
  getCatalogueEntry: async (request) => {
    const parsed = parseCatalogueEntryRequest(request);
    return parseCatalogueEntryResponse(await ipcRenderer.invoke(CATALOGUE_IPC_CHANNELS.entry, parsed));
  },
  startAgentJob: async (request) => {
    const parsed = parseAgentJobStartRequest(request);
    return parseAgentJobStartResponse(await ipcRenderer.invoke(AGENT_JOBS_IPC_CHANNELS.start, parsed));
  },
  listAgentJobs: async () => {
    parseEmptyAgentJobsRequest({});
    return parseAgentJobListResponse(await ipcRenderer.invoke(AGENT_JOBS_IPC_CHANNELS.list, {}));
  },
  stopAgentJob: async (request) => {
    const parsed = parseAgentJobStopRequest(request);
    return parseAgentJobStopResponse(await ipcRenderer.invoke(AGENT_JOBS_IPC_CHANNELS.stop, parsed));
  },
  prepareCatalogueImport: async (request) => {
    const parsed = parseCataloguePrepareImportRequest(request);
    return parseCataloguePrepareImportResponse(await ipcRenderer.invoke(CATALOGUE_IPC_CHANNELS.prepareImport, parsed));
  },
  getAiConnection: async () => {
    parseEmptyInferenceRequest({});
    return parseAiConnectionResponse(await ipcRenderer.invoke(AI_GATEWAY_IPC_CHANNELS.connectionGet, {}));
  },
  setAiConnection: async (request) => {
    const parsed = parseAiConnectionSetRequest(request);
    return parseAiConnectionResponse(await ipcRenderer.invoke(AI_GATEWAY_IPC_CHANNELS.connectionSet, parsed));
  },
  removeAiConnection: async () => {
    parseEmptyInferenceRequest({});
    return parseAiConnectionResponse(await ipcRenderer.invoke(AI_GATEWAY_IPC_CHANNELS.connectionRemove, {}));
  },
  setAiKey: async (request) => {
    const parsed = parseAiKeySetRequest(request);
    return parseInferenceKeyMutationResponse(await ipcRenderer.invoke(AI_GATEWAY_IPC_CHANNELS.keySet, parsed));
  },
  removeAiKey: async () => {
    parseEmptyInferenceRequest({});
    return parseInferenceKeyMutationResponse(await ipcRenderer.invoke(AI_GATEWAY_IPC_CHANNELS.keyRemove, {}));
  },
  testAiConnection: async () => {
    parseEmptyInferenceRequest({});
    return parseAiConnectionTestResponse(await ipcRenderer.invoke(AI_GATEWAY_IPC_CHANNELS.connectionTest, {}));
  },
  listAiModels: async () => {
    parseEmptyInferenceRequest({});
    return parseAiModelResponse(await ipcRenderer.invoke(AI_GATEWAY_IPC_CHANNELS.models, {}));
  },
  setAiFunctions: async (request) => {
    const parsed = parseAiFunctionsSetRequest(request);
    return parseAiFunctionsSetRequest(await ipcRenderer.invoke(AI_GATEWAY_IPC_CHANNELS.functionsSet, parsed));
  },
  getAiUsage: async () => {
    parseEmptyInferenceRequest({});
    return parseAiUsageResponse(await ipcRenderer.invoke(AI_GATEWAY_IPC_CHANNELS.usage, {}));
  },
  listAiPresets: async () => {
    parseEmptyInferenceRequest({});
    return parseAiPresetsResponse(await ipcRenderer.invoke(AI_GATEWAY_IPC_CHANNELS.presets, {}));
  },
  runInferenceCommand: async (request) => {
    const parsed = parseInferenceRunRequest(request);
    return parseInferenceRunResponse(await ipcRenderer.invoke(INFERENCE_IPC_CHANNELS.run, parsed));
  },
  dryRunInference: async (request) => {
    const parsed = parseInferenceDryRunRequest(request);
    return parseInferenceDryRunResponse(await ipcRenderer.invoke(INFERENCE_IPC_CHANNELS.dryRun, parsed));
  },
  listAcademyLessons: async (request) => {
    const parsed = parseAcademyListRequest(request);
    return parseAcademyListResponse(await ipcRenderer.invoke(ACADEMY_IPC_CHANNELS.list, parsed));
  },
  getAcademyLesson: async (request) => {
    const parsed = parseAcademyLessonRequest(request);
    return parseAcademyLessonResponse(await ipcRenderer.invoke(ACADEMY_IPC_CHANNELS.lesson, parsed));
  },
  getAcademyScreenshot: async (request) => {
    const parsed = parseAcademyScreenshotRequest(request);
    return parseAcademyScreenshotResponse(await ipcRenderer.invoke(ACADEMY_IPC_CHANNELS.screenshot, parsed));
  },
  getAcademyFirstLaunch: async () =>
    parseAcademyFirstLaunchResponse(await ipcRenderer.invoke(ACADEMY_IPC_CHANNELS.firstLaunch, {})),
};

contextBridge.exposeInMainWorld("omni", api);
