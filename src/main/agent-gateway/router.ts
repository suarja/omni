import { routeStorefrontLink } from "./router-storefront-link";
import { resolveGatewayRequest, resolveGatewaySource } from "./package-resolution";
import { isActiveAvailableProject } from "../../domain/active-projects";
import { createSkillInventoryReader } from "./router-skill-inventory";
import { createFindSkillReader } from "./router-find-skill";
import { routeExternalLibrary } from "./router-external-library";
import { readAgentStorefronts } from "./router-storefronts";
import { activeWorkshop } from "../../domain/source-roles";
import { app } from "electron";
import { isAbsolute, join, resolve } from "node:path";

import type { Binding } from "../../domain/assignment-plan";
import type { ObservedPackage } from "../../domain/inventory";
import type { EntryRef, Observation, RegistryView } from "../../domain/project-source-registry";
import type { AgentClient } from "./server";
import type {
  AgentRequest,
  ApprovalReason,
  AgentWriteRequest,
  AgentPlan,
  AgentStatus,
  AgentMarketplaceResponse,
  AgentStatusResponse,
} from "../../shared/agents-ipc";
import { parseAgentWriteRequest, type AgentDriftResponse } from "../../shared/agents-ipc";
import type { RegistryIpcServices } from "../registry-ipc";
import type { OperationsIpcServices } from "../operations-ipc";
import type { BindingsIpcServices } from "../bindings-ipc";
import type { SettingsStore } from "../settings-store";
import { createSettingsStore, settingsFilePath } from "../settings-store";
import type { AgentRequestsStore } from "./requests-store";
import { createOperationStore, type OperationStore } from "../operation-store";
import { bindingsFilePath, createBindingsStore } from "../bindings-store";
import { createCatalogueRouter, type CatalogueRouterOptions } from "./router-catalogue";
import { displayCwd, empty, fail, id, keys, object, optionalBoolean, path, text } from "./router-inputs";
import { previewSkill } from "./router-skill";
import { deriveApprovalInput, resolveApproval } from "./approval";
import { createAgentRequestRefresher } from "./refresh-request";
import { createAgentApply } from "./router-apply";
import { createProjectAssetsReader } from "./router-project-assets";
import { createAgentReceiptReader } from "./router-receipt";
import { previewManagedSkill, skillIntentForAgentRequest } from "./router-management";
import type { BuildIdentity } from "../runtime-identity";
import type { ActivitySnapshot } from "../../shared/activity-ipc";

export type RouterOptions = Readonly<{
  userDataPath: string;
  registry: RegistryIpcServices;
  operations: OperationsIpcServices;
  bindings: BindingsIpcServices;
  requests: AgentRequestsStore;
  operationStore?: OperationStore;
  appVersion?: string;
  build?: BuildIdentity;
  profilePath?: string;
  appPath?: string;
  now?: () => number;
  settingsStore?: SettingsStore;
  catalogue?: Pick<CatalogueRouterOptions, "stackProfileStore" | "resourceOptions">;
  previewPlan?: (request: AgentWriteRequest) => Promise<AgentPlan>;
  activitySnapshot?: () => Promise<ActivitySnapshot>;
}>;

function registryReady(result: Awaited<ReturnType<RegistryIpcServices["listRegistry"]>>): RegistryView {
  if (result.status !== "ready") throw fail("The registry is unavailable.");
  return result.registry;
}
async function observe(registry: RegistryIpcServices, ref: EntryRef): Promise<Observation> {
  const result = await registry.observeRegisteredEntry(ref);
  if (result.status !== "observed") throw fail("The registered root could not be observed.");
  return result.observation;
}
function visibleIn(packageInfo: ObservedPackage): readonly string[] {
  const values = new Set<string>(["omni"]);
  if (packageInfo.manifestPaths.some((item) => item.includes(".claude-plugin"))) values.add("claude-code");
  if (packageInfo.manifestPaths.some((item) => item.includes(".codex-plugin"))) values.add("codex");
  return [...values];
}
function marketplaceResponse(observation: Observation, idValue: string): AgentMarketplaceResponse {
  const packages = observation.inventory.packages ?? [];
  return {
    status: "ready",
    marketplace: { id: idValue, name: observation.inventory.marketplace?.name ?? observation.inventory.displayRoot },
    packages: packages.map((packageInfo) => ({
      id: packageInfo.id,
      name: packageInfo.displayName,
      ...(packageInfo.description ? { description: packageInfo.description } : {}),
      ...(packageInfo.version ? { version: packageInfo.version } : {}),
      visibleIn: visibleIn(packageInfo),
      artifacts: observation.inventory.artifacts
        .filter((artifact) => artifact.packageId === packageInfo.id)
        .map((artifact) => ({
          kind: artifact.kind,
          path: artifact.relativePath,
          ...(artifact.summary ? { summary: artifact.summary } : {}),
        })),
    })),
    remotePackages: observation.inventory.marketplace?.remotePackages ?? [],
  };
}
type BindingDriftState = "current" | "update" | "conflict";
function bindingDriftState(action: string | undefined): BindingDriftState {
  return action === "current" || action === "linked"
    ? "current"
    : action === "add" || action === "update"
      ? "update"
      : "conflict";
}

export function createAgentRouter(options: RouterOptions) {
  const now = options.now ?? Date.now;
  const operationStore = options.operationStore ?? createOperationStore(`${options.userDataPath}/omni/operations.json`);
  const settingsStore = options.settingsStore ?? createSettingsStore(settingsFilePath(options.userDataPath));
  const bindingsStore = createBindingsStore(bindingsFilePath(options.userDataPath));
  const catalogueRouter = createCatalogueRouter({
    userDataPath: options.userDataPath,
    registry: options.registry,
    ...(options.catalogue?.stackProfileStore ? { stackProfileStore: options.catalogue.stackProfileStore } : {}),
    ...(options.catalogue?.resourceOptions ? { resourceOptions: options.catalogue.resourceOptions } : {}),
    ...(options.activitySnapshot ? { activitySnapshot: options.activitySnapshot } : {}),
  });
  const resolveBindingState = async (binding: Binding): Promise<BindingDriftState> => {
    try {
      const sourceGrant = await options.registry.getGrantForEntry({ kind: "source", id: binding.sourceId });
      const projectGrant = await options.registry.getGrantForEntry({ kind: "project", id: binding.projectId });
      if (!sourceGrant || !projectGrant) return "conflict";
      const preview = await options.bindings.previewBindings({
        source: { id: binding.sourceId, grantHandle: sourceGrant },
        packageId: binding.packageId,
        artifactPath: binding.artifactPath,
        projects: [{ projectId: binding.projectId, grantHandle: projectGrant, harnessIds: [binding.harnessId] }],
      });
      if (preview.status !== "ready") return "conflict";
      return bindingDriftState(
        preview.plans[0]?.actions.find((action) => action.bindingId === binding.bindingId)?.state,
      );
    } catch {
      return "conflict";
    }
  };
  const status = async (): Promise<AgentStatusResponse> => {
    const registry = registryReady(await options.registry.listRegistry());
    const personal = activeWorkshop(registry);
    const delivery = await options.operations.getWorkshopDelivery?.();
    const storefronts = await readAgentStorefronts(options.userDataPath, registry);
    return {
      status: "ready",
      appVersion: options.appVersion ?? app.getVersion(),
      ...(options.build ? { build: options.build } : {}),
      ...(options.profilePath ? { profilePath: options.profilePath } : {}),
      ...(options.appPath ? { appPath: options.appPath } : {}),
      ...storefronts,
      ...(delivery
        ? {
            workshop:
              storefronts.workshop && delivery.workshop
                ? { ...storefronts.workshop, drift: delivery.workshop.sync }
                : storefronts.workshop,
            installedPlugins: delivery.plugins,
            projectDrift: delivery.projects,
            deliveryDiagnostics: delivery.diagnostics,
          }
        : {}),
      personalMarketplace: personal ? { id: personal.ref.id, name: personal.displayName } : null,
      projects: await Promise.all(
        registry.projects
          .filter((project) => project.archivedAt === undefined)
          .map(async (project) => {
            const root = await options.registry.getRegisteredRoot(project.ref);
            if (!root) throw fail(`Project ${project.ref.id} changed during status; read status again.`);
            return {
              id: project.ref.id,
              name: project.displayName,
              root,
              available: isActiveAvailableProject(project),
              ...(isActiveAvailableProject(project) ? {} : { reason: project.availability }),
            };
          }),
      ),
    };
  };
  const listMarketplace = async (): Promise<AgentMarketplaceResponse> => {
    const registry = registryReady(await options.registry.listRegistry());
    const personal = activeWorkshop(registry);
    if (!personal) throw fail("No personal marketplace is registered.");
    return {
      ...marketplaceResponse(await observe(options.registry, personal.ref), personal.ref.id),
      ...(await readAgentStorefronts(options.userDataPath, registry)),
    };
  };
  const findSkill = createFindSkillReader(options.registry);
  const listProjectAssets = createProjectAssetsReader({
    registry: options.registry,
    bindingsStore,
    resolveBindingState,
  });
  const driftReport = async (params: unknown): Promise<AgentDriftResponse> => {
    const request = object(params, "drift_report parameters");
    keys(request, ["projectId"], "drift_report parameters");
    return readProjectDrift(
      {
        userDataPath: options.userDataPath,
        registry: options.registry,
        bindings: options.bindings,
      },
      request.projectId === undefined ? undefined : id(request.projectId, "Project id"),
    );
  };
  const skillInventory = createSkillInventoryReader({
    registry: options.registry,
    bindingsStore,
    userDataPath: options.userDataPath,
    resolveBindingState,
  });
  const receipt = createAgentReceiptReader(options.requests, operationStore);
  const previewPlan = async (recordedRequest: AgentWriteRequest): Promise<AgentPlan> => {
    if (recordedRequest.kind === "restore-skill") {
      const result = await options.operations.previewOperation({
        kind: "restore-import",
        operationId: recordedRequest.operationId,
      });
      if (result.status !== "ready")
        throw Object.assign(fail(result.diagnostic, result.reason), { registrationBlock: result });
      return result.plan;
    }
    if (
      recordedRequest.kind === "link-storefront" ||
      recordedRequest.kind === "register-project" ||
      recordedRequest.kind === "write-skill" ||
      recordedRequest.kind === "publish-plugin"
    ) {
      const result = await options.operations.previewOperation(recordedRequest);
      if (result.status !== "ready") {
        if (recordedRequest.kind === "register-project" || recordedRequest.kind === "link-storefront")
          throw Object.assign(fail(result.diagnostic, result.reason), { registrationBlock: result });
        throw fail(result.diagnostic);
      }
      return result.plan;
    }
    if (recordedRequest.kind === "make-compatible") {
      const result = await options.operations.previewOperation({
        kind: "make-compatible",
        sourceId: recordedRequest.sourceId,
        ...(recordedRequest.packageId ? { packageId: recordedRequest.packageId } : {}),
        harness: recordedRequest.harness,
      });
      if (result.status !== "ready") throw fail(result.diagnostic);
      return result.plan;
    }
    if (recordedRequest.kind === "import-artifact") {
      const grantHandle = await options.registry.getGrantForEntry({ kind: "project", id: recordedRequest.projectId });
      if (!grantHandle) throw fail("The project is unavailable.");
      const result = await options.operations.previewOperation({
        kind: "import-artifact",
        source: { kind: "project", id: recordedRequest.projectId, grantHandle },
        relativePath: recordedRequest.relativePath,
        target: recordedRequest.target,
      });
      if (result.status !== "ready") throw fail(result.diagnostic);
      return result.plan;
    }
    throw fail("This request must use the managed skill preview.");
  };
  const preview = async (
    request: AgentWriteRequest,
    client: AgentClient,
    askInOmni = false,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const resolved = await resolveGatewayRequest(options.registry, request);
    if (resolved.status === "blocked") return resolved;
    request = resolved.request;
    const recordedRequest: AgentWriteRequest =
      request.kind === "write-skill" && client.harness
        ? {
            ...request,
            agent: {
              harness: client.harness,
              ...(client.sessionName ? { sessionName: client.sessionName } : {}),
              requestedAt: new Date(now()).toISOString(),
            },
          }
        : request;
    const plan = await previewPlan(recordedRequest);
    if (plan.kind === "link-storefront" && plan.storefrontLink?.action === "existing")
      return {
        status: "ready",
        storefrontId: plan.storefrontLink.storefrontId,
        message: "The storefront is already linked. No write was needed.",
      };
    if (plan.kind === "register-project" && plan.projectRegistration?.action === "existing")
      return {
        status: "ready",
        projectId: plan.projectRegistration.projectId,
        message: "The project is already registered. No registry write was needed.",
      };
    const decision = await resolveApproval({
      registry: options.registry,
      ...deriveApprovalInput(recordedRequest, plan),
      settings: await settingsStore.read(),
      askInOmni,
    });
    const approval = decision.mode;
    const stored = await options.requests.create({
      request: recordedRequest,
      plan,
      approval,
      ...(decision.reason ? { approvalReason: decision.reason } : {}),
      ...(client.harness ? { harness: client.harness } : {}),
      ...(client.sessionName ? { sessionName: client.sessionName } : {}),
      ...(client.cwd ? { cwd: displayCwd(client.cwd) } : {}),
    });
    return {
      requestId: stored.requestId,
      plan,
      approval,
      ...(decision.reason ? { approvalReason: decision.reason } : {}),
    };
  };
  const previewManagement = async (
    request: AgentWriteRequest,
    client: AgentClient,
    askInOmni = false,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const resolved = await resolveGatewayRequest(options.registry, request);
    if (resolved.status === "blocked") return resolved;
    request = resolved.request;
    const intent = skillIntentForAgentRequest(request);
    if (!intent) throw fail("This request is not a managed skill operation.");
    return previewManagedSkill({
      service: options.operations.skillManagement,
      registry: options.registry,
      requests: options.requests,
      settings: await settingsStore.read(),
      request,
      intent,
      client,
      askInOmni,
      now,
    });
  };
  const previewCurrentPlan = options.previewPlan ?? previewPlan;
  const apply = createAgentApply({
    operations: options.operations,
    requests: options.requests,
    operationStore,
    skillManagement: options.operations.skillManagement,
    previewPlan: (request) => previewCurrentPlan(request),
    receipt: async (request) => receipt({ requestId: request.requestId }),
    now,
  });
  const refreshAgentRequest = createAgentRequestRefresher({
    requests: options.requests,
    registry: options.registry,
    settings: settingsStore,
    service: options.operations.skillManagement,
    previewPlan: previewCurrentPlan,
  });
  return {
    refreshAgentRequest,
    handle: async (method: string, params: unknown, client: AgentClient): Promise<unknown> => {
      if (method === "status") {
        empty(params, method);
        return status();
      }
      const external = await routeExternalLibrary(
        method,
        params,
        client,
        options.operations.externalLibrary,
        previewManagement,
      );
      if (external) return external;
      if (method === "list_marketplace") {
        empty(params, method);
        return listMarketplace();
      }
      if (method === "skill_inventory") return skillInventory(params);
      if (method === "find_skill") return findSkill(params);
      if (method === "list_project_assets") return listProjectAssets(params);
      if (method === "drift_report") return driftReport(params);
      if (method === "receipt") return receipt(params);
      const catalogueResult = catalogueRouter.handle(method, params);
      if (catalogueResult) return catalogueResult;
      const linked = await routeStorefrontLink(method, params, client, preview, operationStore);
      if (linked) return linked;
      if (method === "preview_register_project") {
        const value = object(params, method);
        keys(value, ["path", "reason"], method);
        const path = value.path === undefined ? undefined : text(value.path, "Project path", 4096);
        const cwd = client.cwd && isAbsolute(client.cwd) ? client.cwd : undefined;
        if (!cwd && (path === undefined || !isAbsolute(path)))
          return {
            status: "blocked",
            reason: "project-cwd-unavailable",
            diagnostic:
              "Pass an absolute project path, or provide the calling agent's working directory for a relative path or no path.",
          };
        try {
          return await preview(
            parseAgentWriteRequest({
              kind: "register-project",
              ...(cwd ? { cwd } : {}),
              path: path === undefined ? cwd : isAbsolute(path) ? path : resolve(cwd!, path),
              ...(value.reason === undefined ? {} : { reason: text(value.reason, "Registration reason", 1024) }),
            }),
            client,
          );
        } catch (error) {
          if (error instanceof Error && "registrationBlock" in error) return error.registrationBlock;
          throw error;
        }
      }
      if (method === "preview_publish") {
        const value = object(params, method);
        keys(value, ["pluginId", "storefrontId", "newStorefront", "conflictChoices"], method);
        return preview(parseAgentWriteRequest({ kind: "publish-plugin", ...value }), client);
      }
      if (method === "preview_capture") {
        const value = object(params, method);
        keys(value, ["projectId", "relativePath", "target", "askInOmni"], method);
        return preview(
          parseAgentWriteRequest({
            kind: "import-artifact",
            projectId: value.projectId,
            relativePath: value.relativePath,
            target: value.target,
          }),
          client,
          optionalBoolean(value.askInOmni, "askInOmni"),
        );
      }
      if (method === "preview_make_compatible") {
        const value = object(params, method);
        keys(value, ["sourceId", "harness", "packageId", "askInOmni"], method);
        return preview(
          parseAgentWriteRequest({
            kind: "make-compatible",
            sourceId: value.sourceId,
            harness: value.harness,
            packageId: value.packageId,
          }),
          client,
          optionalBoolean(value.askInOmni, "askInOmni"),
        );
      }
      if (method === "preview_assign") {
        const value = object(params, method);
        keys(value, ["artifactPath", "sourceId", "packageId", "projectIds", "harnesses", "askInOmni"], method);
        return previewManagement(
          parseAgentWriteRequest({
            kind: "assign",
            artifactPath: value.artifactPath,
            sourceId: value.sourceId,
            packageId: value.packageId,
            projectIds: value.projectIds,
            ...(value.harnesses === undefined ? {} : { harnesses: value.harnesses }),
          }),
          client,
          optionalBoolean(value.askInOmni, "askInOmni"),
        );
      }
      if (method === "preview_remove") {
        const value = object(params, method);
        keys(value, ["bindingIds", "askInOmni"], method);
        return previewManagement(
          parseAgentWriteRequest({ kind: "remove-skill", bindingIds: value.bindingIds }),
          client,
          optionalBoolean(value.askInOmni, "askInOmni"),
        );
      }
      if (method === "preview_restore") {
        const value = object(params, method);
        keys(value, ["operationId", "askInOmni"], method);
        return previewManagement(
          parseAgentWriteRequest({ kind: "restore-skill", operationId: value.operationId }),
          client,
          optionalBoolean(value.askInOmni, "askInOmni"),
        );
      }
      const skillPreview = await previewSkill(
        method,
        params,
        client,
        previewManagement,
        options.operations.skillManagement?.readPropagationCandidates,
        (source) => resolveGatewaySource(options.registry, source),
        (request) => resolveGatewayRequest(options.registry, request),
      );
      if (skillPreview) return skillPreview;
      if (method === "apply") return apply(params, client);
      throw fail(`Unknown agent method: ${method}.`);
    },
  };
}
import { readProjectDrift } from "../workshop-delivery/project-drift";
