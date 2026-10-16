import { activeWorkshop, activeStorefronts, StorefrontTargetError } from "../domain/source-roles";
import { randomUUID } from "node:crypto";

import type { ProjectPlan, Binding } from "../domain/assignment-plan";
import { planAssignment } from "../domain/assignment-plan";
import { targetRelative } from "./operations-import-plan";
import {
  activeRegistration,
  candidateBindings,
  grantFor,
  observeTarget,
  resolveUnitFromRoot,
} from "./assignment-resolution";
import { buildApplyPlan, executeApply, type ApplyPlan } from "./apply-engine";
import { bindingsFilePath, createBindingsStore, type BindingsStore } from "./bindings-store";
import { currentGrantRoot } from "./granted-hashing";
import { registryState, engineOptions } from "./apply-ipc-helpers";
import { createSettingsStore, settingsFilePath, type SettingsStore } from "./settings-store";
import { readActiveWorkshop } from "./operations-paths";
import type { GitCli } from "./git-cli";
import type { FileWriter } from "./operation-files";
import type { OperationStore } from "./operation-store";
import type { RegistryGrantStore, RegistryIpcServices } from "./registry-ipc";
import {
  catalogueGrantSourceId,
  catalogueImportRootIdentity,
  fetchCatalogueSkillMd,
  prepareCatalogueImportFiles,
} from "./catalogue/cache";
import { loadCatalogueSnapshot } from "./catalogue/index";
import type { ResourceOptions } from "./omni-resources";
import { parseAddToProjectRequest, type AddToProjectRequest } from "../shared/operations-add-to-project-ipc";
import { parsePreviewRestoreRequest } from "../shared/operations-import-ipc";
import type { ApplyBlockedResponse } from "../shared/apply-ipc";
import {
  parseApplyOperationRequest,
  type ApplyOperationResponse,
  type OperationPlan,
  type OperationReceipt,
  type PreviewMarketplaceResponse,
} from "../shared/operations-ipc";
import type { OperationApplyProvenance } from "../shared/operations-ipc";

type ImportOperations = Readonly<{
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}>;
type PreparedCatalogueSource = Readonly<{
  sourceId: string;
  grantHandle: string;
  root: string;
  relativePath: string;
}>;
type PrepareCatalogue = (
  entry: AddToProjectRequest["entry"],
) => Promise<PreparedCatalogueSource | Readonly<{ status: "blocked"; reason: string; diagnostic: string }>>;
type StoredPlan = Readonly<{
  plan: OperationPlan;
  request: AddToProjectRequest;
  importPlanId: string;
  personalSourceId: string;
  artifactPath: string;
}>;
type AddToProjectOptions = Readonly<{
  userDataPath: string;
  operationStore: OperationStore;
  git: GitCli;
  registry: RegistryIpcServices;
  bindingsStore?: BindingsStore;
  settingsStore?: SettingsStore;
  fileWriter?: FileWriter;
  now?: () => number;
  resourceOptions?: ResourceOptions;
  importOperations: ImportOperations;
  prepareCatalogue?: PrepareCatalogue;
  applyProject?: (plan: ApplyPlan, provenance?: OperationApplyProvenance) => Promise<ApplyOperationResponse>;
  afterAssignment?: () => Promise<void>;
}>;

function block(reason: string, diagnostic: string, plan?: OperationPlan): PreviewMarketplaceResponse {
  return { status: "blocked", reason, diagnostic, ...(plan ? { plan } : {}) };
}

async function defaultPrepareCatalogue(
  entry: AddToProjectRequest["entry"],
  options: AddToProjectOptions,
  grants: RegistryGrantStore,
): Promise<PreparedCatalogueSource | Readonly<{ status: "blocked"; reason: string; diagnostic: string }>> {
  const snapshot = await loadCatalogueSnapshot(options.resourceOptions);
  const snapshotEntry = snapshot.entries.find(
    (candidate) => candidate.ownerRepo === entry.ownerRepo && candidate.skill === entry.skill,
  );
  if (!snapshotEntry || !snapshotEntry.path || !snapshotEntry.url)
    return { status: "blocked", reason: "catalogue-unavailable", diagnostic: "No SKILL.md was found for this skill." };
  const skillMd = await fetchCatalogueSkillMd(snapshotEntry, options.userDataPath);
  if (skillMd.status === "offline")
    return { status: "blocked", reason: "catalogue-offline", diagnostic: "The catalogue skill is currently offline." };
  if (skillMd.status === "unavailable")
    return { status: "blocked", reason: "catalogue-unavailable", diagnostic: skillMd.reason };
  const prepared = await prepareCatalogueImportFiles(snapshotEntry, skillMd.content, options.userDataPath);
  const identity = await catalogueImportRootIdentity(prepared.root);
  const sourceId = catalogueGrantSourceId(entry.ownerRepo, entry.skill);
  const grantHandle = grants.issue({
    subject: { kind: "source", id: sourceId },
    root: identity.canonicalPath,
    device: identity.device,
    inode: identity.inode,
  });
  return { sourceId, grantHandle, root: prepared.root, relativePath: prepared.relativePath };
}

function requestImport(request: AddToProjectRequest, prepared: PreparedCatalogueSource) {
  return {
    kind: "import-artifact" as const,
    source: { kind: "source" as const, id: prepared.sourceId, grantHandle: prepared.grantHandle },
    relativePath: prepared.relativePath,
    target:
      "packageId" in request
        ? { packageId: request.packageId }
        : { newPackageName: request.newPackageName, description: request.description },
  };
}

async function assignmentPreview(
  request: AddToProjectRequest,
  prepared: PreparedCatalogueSource,
  importPlan: OperationPlan,
  personalSourceId: string,
  projectGrant: NonNullable<ReturnType<RegistryGrantStore["get"]>>,
  bindingsStore: BindingsStore,
): Promise<Readonly<{ plan: ProjectPlan; artifactPath: string }>> {
  const resolved = await resolveUnitFromRoot(prepared.root, importPlan.displayTarget, prepared.relativePath);
  if (!resolved) throw new Error("The prepared catalogue skill is unavailable.");
  const artifactPath = targetRelative(resolved.unit.kind, resolved.unit.id, resolved.sourceRelativePath);
  const loaded = await bindingsStore.read();
  if (loaded.status !== "ready") throw new Error("Bindings are unavailable.");
  const bindings = candidateBindings(
    request.projectId,
    request.harnessIds,
    personalSourceId,
    importPlan.displayTarget,
    artifactPath,
    resolved.unit,
    loaded.bindings,
  );
  const targets = await Promise.all(
    request.harnessIds.map((harnessId) => observeTarget(projectGrant, resolved.unit, harnessId)),
  );
  return {
    artifactPath,
    plan: planAssignment({
      unit: resolved.unit,
      project: { projectId: request.projectId, targets },
      bindings,
    }),
  };
}

function displayTarget(request: AddToProjectRequest, importPlan: OperationPlan, projectName: string): string {
  const packageName = importPlan.displayTarget.split("/").at(-1) ?? importPlan.displayTarget;
  return `${request.entry.skill} → ${packageName} → ${projectName}`;
}

function mergeBindings(existing: readonly Binding[], additions: readonly Binding[]): readonly Binding[] {
  const byId = new Map(existing.map((binding) => [binding.bindingId, binding]));
  for (const binding of additions) byId.set(binding.bindingId, binding);
  return [...byId.values()];
}

function compositeReceipt(
  request: AddToProjectRequest,
  plan: OperationPlan,
  importReceipt: OperationReceipt,
  now: () => number,
  assignmentReceipt?: OperationReceipt,
  failure?: Readonly<{ step: "import" | "assign"; diagnostic: string }>,
): OperationReceipt {
  return {
    operationId: randomUUID(),
    kind: "add-to-project",
    status: failure ? "failed" : "applied",
    appliedAt: new Date(now()).toISOString(),
    displayTarget: plan.displayTarget,
    actions: [...importReceipt.actions, ...(assignmentReceipt?.actions ?? [])],
    git: importReceipt.git,
    registered: importReceipt.registered,
    ...(importReceipt.source ? { source: importReceipt.source } : {}),
    project: { id: request.projectId },
    ...(assignmentReceipt?.bindings ? { bindings: assignmentReceipt.bindings } : {}),
    ...(assignmentReceipt?.files ? { files: assignmentReceipt.files } : {}),
    ...(importReceipt.manifests ? { manifests: importReceipt.manifests } : {}),
    children: [importReceipt.operationId, ...(assignmentReceipt ? [assignmentReceipt.operationId] : [])],
    ...(failure ? { failedStep: failure.step, diagnostic: failure.diagnostic } : {}),
  };
}

export function createAddToProjectOperations(
  grants: RegistryGrantStore,
  options: AddToProjectOptions,
): Readonly<{
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const now = options.now ?? Date.now;
  const bindingsStore = options.bindingsStore ?? createBindingsStore(bindingsFilePath(options.userDataPath));
  const settingsStore = options.settingsStore ?? createSettingsStore(settingsFilePath(options.userDataPath));
  const plans = new Map<string, StoredPlan>();
  const prepare = options.prepareCatalogue ?? ((entry) => defaultPrepareCatalogue(entry, options, grants));

  const preview = async (raw: unknown): Promise<PreviewMarketplaceResponse> => {
    const request = parseAddToProjectRequest(raw);
    const state = await registryState(options.userDataPath);
    const project = activeRegistration(state, "project", request.projectId);
    const source = activeWorkshop(state);
    if (!source && activeStorefronts(state).length) {
      const error = new StorefrontTargetError();
      return block(error.code, error.message);
    }
    if (!project || !source) return block("entry-unavailable", "The project or personal marketplace is unavailable.");
    const projectGrant = grantFor(grants, { kind: "project", id: request.projectId }, request.grantHandle);
    if (!projectGrant || !(await currentGrantRoot(projectGrant)))
      return block("grant-invalid", "The project grant is unavailable.");
    const prepared = await prepare(request.entry);
    if ("status" in prepared) return prepared;
    const imported = await options.importOperations.preview(requestImport(request, prepared));
    if (imported.status !== "ready") return imported;
    const assignment = await assignmentPreview(
      request,
      prepared,
      imported.plan,
      source.id,
      projectGrant,
      bindingsStore,
    );
    const plan: OperationPlan = {
      planId: randomUUID(),
      kind: "add-to-project",
      displayTarget: displayTarget(request, imported.plan, project.displayName),
      actions: imported.plan.actions,
      git: imported.plan.git,
      visibleIn: imported.plan.visibleIn,
      steps: [
        { kind: "import", plan: imported.plan },
        { kind: "assign", plan: assignment.plan },
      ],
    };
    plans.set(plan.planId, {
      plan,
      request,
      importPlanId: imported.plan.planId,
      personalSourceId: source.id,
      artifactPath: assignment.artifactPath,
    });
    return { status: "ready", plan };
  };

  const apply = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    const request = parseApplyOperationRequest(raw);
    const stored = plans.get(request.planId);
    if (!stored) return undefined;
    plans.delete(request.planId);
    const imported = await options.importOperations.apply({
      planId: stored.importPlanId,
      ...(request.provenance ? { provenance: request.provenance } : {}),
    });
    if (!imported) return undefined;
    if (imported.status === "failed") {
      const receipt = compositeReceipt(stored.request, stored.plan, imported.receipt, now, undefined, {
        step: "import",
        diagnostic: imported.receipt.diagnostic ?? "The marketplace import failed.",
      });
      await options.operationStore.append(receipt);
      return { status: "failed", receipt };
    }
    try {
      const state = await registryState(options.userDataPath);
      const project = activeRegistration(state, "project", stored.request.projectId);
      const source = activeWorkshop(state);
      const projectGrant = grantFor(
        grants,
        { kind: "project", id: stored.request.projectId },
        stored.request.grantHandle,
      );
      if (!project || !source || source.id !== stored.personalSourceId || !projectGrant)
        throw new Error("The project or personal marketplace is no longer available.");
      const sourceHandle = await options.registry.getGrantForEntry({ kind: "source", id: source.id });
      const sourceGrant = sourceHandle ? grants.get(sourceHandle) : undefined;
      if (!sourceGrant || !(await currentGrantRoot(sourceGrant)) || !(await currentGrantRoot(projectGrant)))
        throw new Error("The project or marketplace grant is unavailable.");
      const marketplace = await readActiveWorkshop(options.userDataPath);
      if (!marketplace) throw new Error("The personal marketplace is unavailable.");
      const importStep = stored.plan.steps?.find((step) => step.kind === "import");
      const resolved = await resolveUnitFromRoot(
        marketplace.root,
        importStep?.plan.displayTarget ?? "",
        stored.artifactPath,
      );
      if (!resolved) throw new Error("The imported marketplace skill is unavailable.");
      const loaded = await bindingsStore.read();
      if (loaded.status !== "ready") throw new Error("Bindings are unavailable.");
      const additions = candidateBindings(
        stored.request.projectId,
        stored.request.harnessIds,
        source.id,
        imported.receipt.displayTarget,
        stored.artifactPath,
        resolved.unit,
        loaded.bindings,
      );
      if (additions.length === 0) throw new Error("No assignment bindings were created.");
      const saved = await bindingsStore.save(mergeBindings(loaded.bindings, additions));
      if (saved.status !== "ready") throw new Error("Bindings could not be persisted safely.");
      const applyPlan = await buildApplyPlan({
        projectId: stored.request.projectId,
        displayName: project.displayName,
        projectGrant,
        sourceGrant,
        bindings: additions,
        settings: await settingsStore.read(),
        git: options.git,
      });
      const applied = options.applyProject
        ? await options.applyProject(applyPlan, request.provenance)
        : await executeApply(
            applyPlan,
            { planId: applyPlan.planId, resolutions: [] },
            {
              ...engineOptions(
                options.userDataPath,
                bindingsStore,
                options.operationStore,
                await settingsStore.read(),
                options.git,
                options.fileWriter,
                now,
              ),
              ...(request.provenance ? { provenance: request.provenance } : {}),
            },
          );
      if (applied.status === "applied") await options.afterAssignment?.();
      const receipt = compositeReceipt(
        stored.request,
        stored.plan,
        imported.receipt,
        now,
        applied.receipt,
        applied.status === "failed"
          ? { step: "assign", diagnostic: applied.receipt.diagnostic ?? "The project assignment failed." }
          : undefined,
      );
      await options.operationStore.append(receipt);
      return { status: applied.status, receipt };
    } catch (error: unknown) {
      const receipt = compositeReceipt(stored.request, stored.plan, imported.receipt, now, undefined, {
        step: "assign",
        diagnostic: error instanceof Error ? error.message : "The project assignment failed.",
      });
      await options.operationStore.append(receipt);
      return { status: "failed", receipt };
    }
  };

  return { preview, apply };
}

export type CompositeRestoreOptions = Readonly<{
  operationStore: OperationStore;
  previewChild: (receipt: OperationReceipt) => Promise<PreviewMarketplaceResponse>;
  applyChild: (
    planId: string,
    kind: OperationReceipt["kind"],
  ) => Promise<ApplyOperationResponse | ApplyBlockedResponse | undefined>;
  now?: () => number;
}>;

type CompositeRestorePlan = Readonly<{
  plan: OperationPlan;
  original: OperationReceipt;
  childPlanIds: readonly Readonly<{ planId: string; kind: OperationReceipt["kind"] }>[];
}>;

export function createCompositeRestoreOperations(options: CompositeRestoreOptions): Readonly<{
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const plans = new Map<string, CompositeRestorePlan>();
  const preview = async (raw: unknown): Promise<PreviewMarketplaceResponse> => {
    const request = parsePreviewRestoreRequest(raw);
    const loaded = await options.operationStore.read();
    if (loaded.status !== "ready") return block("operations-unavailable", loaded.diagnostic);
    const original = loaded.receipts.find(
      (receipt) =>
        receipt.operationId === request.operationId &&
        ((receipt.kind === "add-to-project" && receipt.status === "applied") ||
          (receipt.kind === "import-artifact" && Boolean(receipt.children?.length))) &&
        !receipt.restored,
    );
    if (!original) return block("restore-unavailable", "The composite receipt is unavailable or was already restored.");
    const childPlanIds: Readonly<{ planId: string; kind: OperationReceipt["kind"] }>[] = [];
    const childPlans: OperationPlan[] = [];
    for (const childId of [...(original.children ?? [])].reverse()) {
      const child = loaded.receipts.find((receipt) => receipt.operationId === childId);
      if (!child) return block("restore-child-unavailable", `Cannot restore child ${childId}: its receipt is missing.`);
      if (child.restored) continue;
      const result = await options.previewChild(child);
      if (result.status !== "ready")
        return block("restore-child-unavailable", `Cannot restore ${child.displayTarget}: ${result.diagnostic}`);
      childPlanIds.push({ planId: result.plan.planId, kind: child.kind });
      childPlans.push(result.plan);
    }
    const plan: OperationPlan = {
      planId: randomUUID(),
      kind: original.kind === "import-artifact" ? "restore-import" : "restore-add-to-project",
      displayTarget: original.displayTarget,
      actions: childPlans.flatMap((child) => child.actions),
      git: { mode: "unavailable", warnings: [] },
      notes: ["Children restore in reverse order."],
    };
    plans.set(plan.planId, { plan, original, childPlanIds });
    return { status: "ready", plan };
  };
  const apply = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    const request = parseApplyOperationRequest(raw);
    const stored = plans.get(request.planId);
    if (!stored) return undefined;
    plans.delete(request.planId);
    const completed: OperationReceipt[] = [];
    for (const childPlan of stored.childPlanIds) {
      const result = await options.applyChild(childPlan.planId, childPlan.kind);
      if (!result || result.status === "blocked" || result.status === "failed") {
        const diagnostic = !result
          ? `Restore stopped at child ${childPlan.planId}.`
          : result.status === "blocked"
            ? `Restore stopped at ${stored.original.displayTarget}: ${result.diagnostic ?? result.reason}.`
            : (result.receipt.diagnostic ?? `Restore stopped at child ${childPlan.planId}.`);
        const receipt: OperationReceipt = {
          operationId: randomUUID(),
          kind: stored.plan.kind,
          status: "failed",
          appliedAt: new Date((options.now ?? Date.now)()).toISOString(),
          displayTarget: stored.plan.displayTarget,
          actions: stored.plan.actions.map((action) => ({ ...action, status: "failed" as const })),
          git: { mode: "unavailable" },
          registered: null,
          project: stored.original.project,
          restores: stored.original.operationId,
          children: completed.map((child) => child.operationId),
          diagnostic,
        };
        await options.operationStore.append(receipt);
        return { status: "failed", receipt };
      }
      completed.push(result.receipt);
    }
    const receipt: OperationReceipt = {
      operationId: randomUUID(),
      kind: stored.plan.kind,
      status: "applied",
      appliedAt: new Date((options.now ?? Date.now)()).toISOString(),
      displayTarget: stored.plan.displayTarget,
      actions: stored.plan.actions.map((action) => ({ ...action, status: "applied" as const })),
      // The marketplace commit of the import child; the project child's commit sits on its own receipt.
      git: completed.find((child) => child.kind === "restore-import")?.git ?? { mode: "unavailable" },
      registered: null,
      project: stored.original.project,
      restores: stored.original.operationId,
      children: completed.map((child) => child.operationId),
    };
    const saved = await options.operationStore.append(receipt);
    if (saved.status !== "ready") return undefined;
    await options.operationStore.markRestored(stored.original.operationId);
    return { status: "applied", receipt };
  };
  return { preview, apply };
}
