import { isWorkshopSource, assertWorkshopTarget } from "../domain/source-roles";
import { join } from "node:path";

import { app, ipcMain } from "electron";

import { planAssignment, type Binding, type ProjectPlan } from "../domain/assignment-plan";
import { mergeProjectPlans } from "../domain/assignment-merge";
import type { HarnessId } from "../domain/harness-targets";
import type { EntryRef, RegistryState } from "../domain/project-source-registry";
import { createLocalJsonRegistryStore } from "../adapters/registry/local-json";
import type { RegistryGrant, RegistryGrantStore } from "./registry-ipc";
import { bindingsFilePath, createBindingsStore, type BindingsStore } from "./bindings-store";
import { currentGrantRoot } from "./granted-hashing";
import { createSkillRelationshipStore } from "./skill-reconciliation/store";
import { isManagedBinding } from "./skill-management/legacy-binding-guard";
import {
  activeRegistration,
  candidateBindings,
  grantFor,
  observeTarget,
  resolveUnitFromGrant,
  sameRef,
} from "./assignment-resolution";
import { resolvePackageUnits, type PackageUnit } from "./bindings-whole-package";
import {
  BINDINGS_IPC_CHANNELS,
  parseBindingsPreviewRequest,
  parseBindingsSaveRequest,
  parseBindingsRemoveRequest,
  parseEmptyBindingsRequest,
  type BindingsPreviewRequest,
  type BindingsPreviewResponse,
  type BindingsPreviewUnit,
  type BindingsSaveRequest,
  type BindingsListResponse,
} from "../shared/bindings-ipc";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;
type BindingsIpcOptions = Readonly<{ userDataPath?: string; bindingsStore?: BindingsStore }>;
export type BindingsIpcServices = Readonly<{
  previewBindings(request: unknown): Promise<BindingsPreviewResponse>;
  readBindings(): Promise<BindingsListResponse>;
  saveBindings(request: unknown): Promise<BindingsListResponse>;
}>;

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Bindings request failed safely.";
  return message.length <= 240 && !/[\r\n]/.test(message) && !/(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/.test(message)
    ? message
    : "Bindings request failed safely.";
}
async function readRegistry(userDataPath: string): Promise<RegistryState> {
  const result = await createLocalJsonRegistryStore(join(userDataPath, "omni", "project-source-registry.json")).read();
  if (result.status === "corrupt") throw new Error("Registry is unavailable.");
  return result.state;
}
async function packageUnits(
  sourceGrant: RegistryGrant,
  packageId: string,
  artifactPath: string | undefined,
): Promise<readonly PackageUnit[]> {
  if (artifactPath === undefined) {
    const units = await resolvePackageUnits(sourceGrant, packageId);
    if (!units.length) throw new Error("Marketplace package has no assignable artifacts.");
    return units;
  }
  const resolved = await resolveUnitFromGrant(sourceGrant, packageId, artifactPath);
  if (!resolved) throw new Error("Marketplace unit is unavailable.");
  return [{ artifactPath, unit: resolved.unit }];
}

async function preview(
  request: BindingsPreviewRequest,
  grants: RegistryGrantStore,
  store: BindingsStore,
  userDataPath: string,
): Promise<BindingsPreviewResponse | Readonly<{ status: "denied" }>> {
  const sourceRef: EntryRef = { kind: "source", id: request.source.id };
  const sourceGrant = grantFor(grants, sourceRef, request.source.grantHandle);
  if (!sourceGrant || !(await currentGrantRoot(sourceGrant))) return { status: "denied" };
  const state = await readRegistry(userDataPath);
  const source = state.sources.find((record) => record.id === request.source.id && record.archivedAt === undefined);
  if (source) assertWorkshopTarget(source);
  if (!source || !isWorkshopSource(source)) throw new Error("Personal source is not active.");
  const units = await packageUnits(sourceGrant, request.packageId, request.artifactPath);
  const loaded = await store.read();
  if (loaded.status === "corrupt") throw new Error("Bindings store is unavailable.");
  const relationships = await createSkillRelationshipStore(
    join(userDataPath, "omni", "skill-relationships.json"),
  ).read();
  if (relationships.status !== "ready") throw new Error("Skill relationship store is unavailable.");
  const plans: ProjectPlan[] = [];
  const previewBindings: Binding[] = [];
  for (const project of request.projects) {
    const projectRef: EntryRef = { kind: "project", id: project.projectId };
    const projectGrant = grantFor(grants, projectRef, project.grantHandle);
    if (!projectGrant || !(await currentGrantRoot(projectGrant))) return { status: "denied" };
    if (!activeRegistration(state, "project", project.projectId)) throw new Error("Project is not active.");
    const unitPlans: ProjectPlan[] = [];
    for (const { artifactPath, unit } of units) {
      const targets = await Promise.all(
        project.harnessIds.map((harnessId) => observeTarget(projectGrant, unit, harnessId)),
      );
      const bindings = candidateBindings(
        project.projectId,
        project.harnessIds,
        request.source.id,
        request.packageId,
        artifactPath,
        unit,
        loaded.bindings,
      );
      previewBindings.push(...bindings);
      const planned = planAssignment({ unit, project: { projectId: project.projectId, targets }, bindings });
      const actions = planned.actions.map((action) => {
        const binding = bindings.find(({ bindingId }) => bindingId === action.bindingId);
        if (binding && isManagedBinding(binding, relationships.state.uses) && action.state !== "current")
          return {
            ...action,
            state: "blocked" as const,
            reason: "This copy is managed by Omni; use Update linked copies or copy management in Changes.",
          };
        const target = targets.find(
          (candidate) => candidate.harnessId === action.harnessId && candidate.relativePath === action.relativePath,
        );
        const recorded = loaded.bindings.some((binding) => binding.bindingId === action.bindingId);
        if (recorded || !target?.exists || action.state === "blocked" || action.state === "conflict") return action;
        return {
          ...action,
          state: "conflict" as const,
          reason: "An existing unbound project copy cannot be adopted in this operation.",
        };
      });
      const status = actions.some((action) => action.state === "blocked")
        ? "blocked"
        : actions.some((action) => action.state === "conflict")
          ? "conflict"
          : "ready";
      unitPlans.push({ ...planned, status, actions });
    }
    plans.push(mergeProjectPlans(unitPlans));
  }
  const previewUnits: readonly BindingsPreviewUnit[] = units.map(({ artifactPath, unit }) => ({
    kind: unit.kind,
    id: unit.id,
    artifactPath,
    contentHash: unit.contentHash,
  }));
  return {
    status: "ready",
    units: previewUnits,
    plans,
    bindings: previewBindings.filter(
      (binding, index, all) => all.findIndex((candidate) => candidate.bindingId === binding.bindingId) === index,
    ),
  };
}
async function save(request: BindingsSaveRequest, store: BindingsStore, userDataPath: string) {
  const state = await readRegistry(userDataPath);
  for (const binding of request.bindings) {
    const source = state.sources.find((record) => record.id === binding.sourceId && record.archivedAt === undefined);
    if (source) assertWorkshopTarget(source);
    if (!source || !isWorkshopSource(source)) throw new Error("Binding source is not active.");
    if (!state.projects.some((record) => record.id === binding.projectId && record.archivedAt === undefined))
      throw new Error("Binding project is not active.");
  }
  return store.save(request.bindings);
}

export function registerBindingsIpcHandlers(
  assertTrustedSender: SenderGuard,
  grants: RegistryGrantStore,
  options: BindingsIpcOptions = {},
): BindingsIpcServices {
  const userDataPath = options.userDataPath ?? app.getPath("userData");
  const store = options.bindingsStore ?? createBindingsStore(bindingsFilePath(userDataPath));
  const guard =
    <T>(handler: (request: unknown) => Promise<T>) =>
    async (event: Electron.IpcMainInvokeEvent, rawRequest: unknown): Promise<T> => {
      assertTrustedSender(event);
      try {
        return await handler(rawRequest);
      } catch (error: unknown) {
        throw new Error(safeErrorMessage(error));
      }
    };
  const previewBindings = (rawRequest: unknown): Promise<BindingsPreviewResponse> =>
    preview(parseBindingsPreviewRequest(rawRequest), grants, store, userDataPath);
  const readBindings = (): Promise<BindingsListResponse> => store.read();
  const readLegacyBindings = async (): Promise<BindingsListResponse> => {
    const loaded = await store.read();
    if (loaded.status !== "ready") return loaded;
    const relationships = await createSkillRelationshipStore(
      join(userDataPath, "omni", "skill-relationships.json"),
    ).read();
    if (relationships.status !== "ready") return relationships;
    return {
      status: "ready",
      bindings: loaded.bindings.filter((binding) => !isManagedBinding(binding, relationships.state.uses)),
    };
  };
  const saveBindings = (rawRequest: unknown): Promise<BindingsListResponse> =>
    save(parseBindingsSaveRequest(rawRequest), store, userDataPath);
  ipcMain.handle(
    BINDINGS_IPC_CHANNELS.list,
    guard(async (rawRequest) => {
      parseEmptyBindingsRequest(rawRequest);
      return readLegacyBindings();
    }),
  );
  ipcMain.handle(BINDINGS_IPC_CHANNELS.preview, guard(previewBindings));
  ipcMain.handle(BINDINGS_IPC_CHANNELS.save, guard(saveBindings));
  ipcMain.handle(
    BINDINGS_IPC_CHANNELS.remove,
    guard(async (rawRequest) => store.remove(parseBindingsRemoveRequest(rawRequest).bindingId)),
  );
  return { previewBindings, readBindings, saveBindings };
}
