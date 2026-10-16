import { sourceReferenceRecovery } from "./source-observation";
import { createHash } from "node:crypto";

import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import { planSkillAdoption, type SkillAdoptionPlan } from "../../domain/skill-reconciliation/adoption";
import type { SkillLocationKey, SourceSkillRef } from "../../domain/skill-reconciliation/types";
import type { SkillEffectFingerprint } from "../../domain/skill-management-intent";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { SkillAdoptionBaseReference, SkillAdoptionEvidence } from "../../shared/skill-adoption-effects";
import type { SkillEffectStep, SkillIntent, SkillIssue, SkillResult } from "../../shared/skill-management-ipc";
import type { SkillRelationshipStore, SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import type { RegistryIpcServices } from "../registry-ipc";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import { readSkillAdoptionSnapshot, type SkillAdoptionSnapshot } from "./adoption-reader";
import type { SkillAdoptionRequest } from "../../shared/skill-reconciliation-request";

type ReconcileIntent = Extract<SkillIntent, { kind: "reconcile" }> & Readonly<{ request: SkillAdoptionRequest }>;
type Snapshot = Extract<SkillAdoptionSnapshot, { status: "ready" }>;

function issue(code: string, message: string, recoveryAction: SkillIssue["recoveryAction"]): SkillIssue {
  return { code, message, recoveryAction };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}
function uuid(seed: string): string {
  const value = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32).split("");
  value[12] = "5";
  value[16] = ((Number.parseInt(value[16]!, 16) & 3) | 8).toString(16);
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}
function intentFor(step: SkillEffectStep): ReconcileIntent {
  const source = step.adoptionEvidence?.source.ref;
  const skillId = step.metadataEffects?.[0]?.skillId;
  const locations = step.metadataEffects?.map(({ location }) => location);
  if (!source || !skillId || !locations?.length) throw new Error("The saved adoption step cannot be resolved safely.");
  return { kind: "reconcile", request: { choice: "adopt-exact", skillId, source, locations } };
}
function evidence(snapshot: Snapshot, source: SourceSkillRef): SkillAdoptionEvidence {
  return {
    storeRevision: snapshot.relationships.revision,
    source: { ref: source, rootIdentity: snapshot.rootIdentities.source, revision: snapshot.sourceTree.revision },
    locals: snapshot.localTrees
      .map(({ location, tree }) => ({
        location,
        rootIdentity: snapshot.rootIdentities.project,
        revision: tree.revision,
      }))
      .sort((a, b) => locationKey(a.location).localeCompare(locationKey(b.location))),
  };
}
function sameRevision(left: Snapshot["sourceTree"]["revision"], right: Snapshot["sourceTree"]["revision"]): boolean {
  return canonical(left) === canonical(right);
}
async function selectBase(
  snapshot: Snapshot,
  intent: ReconcileIntent,
  intentId: string,
  bases: SkillBaseStore,
): Promise<string | undefined> {
  const selected = new Set(intent.request.locations.map(locationKey));
  const uses = snapshot.relationships.uses.filter(
    (use) => use.skillId === intent.request.skillId && selected.has(locationKey(use.location)) && !use.baseUnavailable,
  );
  const verified = new Map<string, Extract<Awaited<ReturnType<SkillBaseStore["read"]>>, { status: "ready" }>>();
  for (const use of uses) {
    const base = await bases.read(use.baseRevisionId);
    if (base.status !== "ready") return undefined;
    verified.set(use.baseRevisionId, base);
  }
  const ids = new Set(uses.map(({ baseRevisionId }) => baseRevisionId));
  if (ids.size === 1) {
    const id = [...ids][0]!;
    if (sameRevision(verified.get(id)!.revision, snapshot.sourceTree.revision)) return id;
  }
  return uuid(`${intentId}\\nbase\\n${intent.request.skillId}`);
}
function policy(
  snapshot: Snapshot,
  intent: ReconcileIntent,
  baseId: string,
  intentId: string,
  now: () => number,
  saved?: SkillEffectStep,
): SkillAdoptionPlan {
  const record = snapshot.relationships.skills.find(({ skillId }) => skillId === intent.request.skillId);
  const savedIds = new Map(
    (saved?.metadataEffects ?? []).flatMap((metadata) => {
      const id = (metadata.after ?? metadata.before)?.bindingId;
      return id ? [[locationKey(metadata.location), id] as const] : [];
    }),
  );
  const savedCreatedAt = saved?.bindingEffects.find((change) => !change.before)?.after?.createdAt;
  return planSkillAdoption({
    request: intent.request,
    record,
    sourceRevision: snapshot.sourceTree.revision,
    locals: snapshot.localTrees.map(({ location, tree }) => ({ location, revision: tree.revision })),
    bindings: snapshot.bindings,
    uses: snapshot.relationships.uses,
    baseRevisionId: baseId,
    now: savedCreatedAt ?? new Date(now()).toISOString(),
    allocateBindingId: (location) =>
      savedIds.get(locationKey(location)) ?? uuid(`${intentId}\\nbinding\\n${locationKey(location)}`),
  });
}
function blocked(code: string, message: string, status: "blocked" | "needs-input" = "blocked"): SkillEffectBuild {
  return {
    status,
    reason: message,
    details: [issue(code, message, status === "needs-input" ? "choose-targets" : sourceReferenceRecovery(code))],
  };
}
function makeDraft(
  intent: ReconcileIntent,
  intentId: string,
  snapshot: Snapshot,
  planned: Extract<SkillAdoptionPlan, { status: "ready" }>,
): SkillEffectBuild {
  const stepId = uuid(`${intentId}\\nadopt-skill-step`);
  const scope = {
    sourceId: intent.request.source.sourceId,
    packageId: intent.request.source.packageId,
    artifactPath: intent.request.source.artifactPath,
    targets: planned.bindingEffects.flatMap((change) => {
      const binding = change.after ?? change.before;
      return binding
        ? [{ projectId: binding.projectId, harnessId: binding.harnessId, bindingId: binding.bindingId }]
        : [];
    }),
  };
  const base: SkillAdoptionBaseReference = {
    baseRevisionId: planned.baseRevisionId,
    revision: snapshot.sourceTree.revision,
  };
  const step: SkillEffectStep = {
    stepId,
    scope,
    plan: {
      planId: stepId,
      kind: "adopt-skill",
      displayTarget: intent.request.source.artifactPath,
      actions: [],
      git: { mode: "disabled", warnings: [] },
    },
    bindingEffects: planned.bindingEffects,
    files: [],
    metadataEffects: planned.metadataEffects,
    baseReferences: [base],
    adoptionEvidence: evidence(snapshot, intent.request.source),
  };
  const fingerprint: SkillEffectFingerprint = {
    scope,
    files: [],
    bindings: planned.bindingEffects,
    actions: [],
    metadataEffects: planned.metadataEffects,
    baseReferences: [base],
    adoptionEvidence: step.adoptionEvidence,
  };
  return { status: "ready", planId: stepId, scope, steps: [step], fingerprint, backupReferences: [] };
}
function getAdoptionStep(effect: SkillEffectDraft): SkillEffectStep {
  const step = effect.steps[0];
  if (effect.steps.length !== 1 || step?.plan.kind !== "adopt-skill" || step.plan.actions.length || step.files.length)
    throw new Error("The saved adoption effect is invalid.");
  return step;
}
function matchesSaved(snapshot: Snapshot, intentId: string, step: SkillEffectStep, now: () => number): boolean {
  const intent = intentFor(step);
  const base = step.baseReferences?.[0];
  if (
    !step.metadataEffects ||
    !step.adoptionEvidence ||
    !base ||
    canonical(evidence(snapshot, intent.request.source)) !== canonical(step.adoptionEvidence) ||
    snapshot.relationships.revision !== step.adoptionEvidence.storeRevision
  )
    return false;
  const fresh = policy(snapshot, intent, base.baseRevisionId, intentId, now, step);
  return (
    fresh.status === "ready" &&
    canonical(fresh.bindingEffects) === canonical(step.bindingEffects) &&
    canonical(fresh.metadataEffects) === canonical(step.metadataEffects)
  );
}
function targetResults(
  step: SkillEffectStep,
  status: SkillResult["targets"][number]["status"],
): SkillResult["targets"] {
  return step.bindingEffects.flatMap((change) => {
    const binding = change.after ?? change.before;
    return binding
      ? [
          {
            projectId: binding.projectId,
            harnessId: binding.harnessId,
            bindingId: binding.bindingId,
            artifactPath: binding.artifactPath,
            status,
          },
        ]
      : [];
  });
}
function resolution(
  step: SkillEffectStep,
  status: Extract<NonNullable<SkillResult["resolution"]>, { choice: "adopt-exact" }>["targets"][number]["status"],
): Extract<NonNullable<SkillResult["resolution"]>, { choice: "adopt-exact" }> | undefined {
  const first = step.metadataEffects?.[0];
  if (!first) return undefined;
  return {
    skillId: first.skillId,
    choice: "adopt-exact",
    targets: step.metadataEffects!.map((change) => ({
      location: change.location,
      bindingId: change.after?.bindingId ?? change.before!.bindingId,
      status,
    })),
  };
}
function makeReceipt(
  intentId: string,
  step: SkillEffectStep,
  intent: ReconcileIntent,
  now: () => number,
): OperationReceipt {
  return {
    operationId: step.stepId,
    kind: "adopt-skill",
    status: "applied",
    appliedAt: new Date(now()).toISOString(),
    displayTarget: intent.request.source.artifactPath,
    actions: [],
    git: { mode: "unavailable" },
    registered: null,
    source: { kind: "source", id: intent.request.source.sourceId, relativePath: intent.request.source.artifactPath },
    project: { id: intent.request.locations[0]!.projectId },
    adoption: { intentId, stepId: step.stepId },
  };
}
function result(
  status: SkillEffectOutcome["status"],
  intent: ReconcileIntent,
  step: SkillEffectStep,
  receipt?: OperationReceipt,
): SkillEffectOutcome {
  const targetStatus = status === "no-op" ? "no-op" : "applied";
  return {
    status,
    source: { status: "unchanged", sourceId: intent.request.source.sourceId },
    targets: targetResults(step, targetStatus),
    receiptIds: receipt ? [receipt.operationId] : [],
    receipts: receipt ? [receipt] : [],
    issues: [],
    recoveryAvailable: false,
    resolution: resolution(step, targetStatus),
  };
}
function verifyAfter(snapshot: Snapshot, step: SkillEffectStep, revision: Snapshot["sourceTree"]["revision"]): boolean {
  if (
    !step.metadataEffects ||
    !sameRevision(snapshot.sourceTree.revision, revision) ||
    snapshot.localTrees.length !== step.metadataEffects.length ||
    snapshot.localTrees.some(
      ({ location, tree }) =>
        !step.metadataEffects!.some((effect) => locationKey(effect.location) === locationKey(location)) ||
        !sameRevision(tree.revision, revision),
    )
  )
    return false;
  const bindings = new Map(snapshot.bindings.map((binding) => [binding.bindingId, binding]));
  if (step.bindingEffects.some((change) => canonical(bindings.get(change.bindingId)) !== canonical(change.after)))
    return false;
  return step.metadataEffects.every(
    (change) =>
      canonical(
        snapshot.relationships.uses.find((use) => locationKey(use.location) === locationKey(change.location)),
      ) === canonical(change.after),
  );
}

export function createSkillAdoptionAdapter(
  args: Readonly<{
    registry: RegistryIpcServices;
    relationships: SkillRelationshipStore;
    bindings: BindingsStore;
    bases: SkillBaseStore;
    operationStore: OperationStore;
    filesystem?: SkillObservationFilesystem;
    now?: () => number;
  }>,
): Readonly<{
  preview(intent: ReconcileIntent, intentId: string): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress: SkillStepProgress): Promise<SkillEffectOutcome>;
}> {
  const now = args.now ?? Date.now;
  const read = (intent: ReconcileIntent) =>
    readSkillAdoptionSnapshot(intent.request, {
      registry: args.registry,
      relationships: args.relationships,
      bindings: args.bindings,
      ...(args.filesystem ? { filesystem: args.filesystem } : {}),
      now,
    });
  const preview = async (intent: ReconcileIntent, intentId: string): Promise<SkillEffectBuild> => {
    const snapshot = await read(intent);
    if (snapshot.status !== "ready") return blocked(snapshot.code, snapshot.message);
    const baseId = await selectBase(snapshot, intent, intentId, args.bases);
    if (!baseId)
      return blocked(
        "managed-base-unavailable",
        "A selected managed use references a missing or corrupt immutable base.",
      );
    const planned = policy(snapshot, intent, baseId, intentId, now);
    return planned.status === "ready"
      ? makeDraft(intent, intentId, snapshot, planned)
      : blocked(planned.code, planned.reason, planned.status);
  };
  const prepare = async (intentId: string, effect: SkillEffectDraft): Promise<void> => {
    const step = getAdoptionStep(effect);
    const intent = intentFor(step);
    const base = step.baseReferences?.[0];
    if (!base) throw new Error("The saved adoption base is missing.");
    const snapshot = await read(intent);
    if (snapshot.status !== "ready" || !matchesSaved(snapshot, intentId, step, now))
      throw new Error("The approved source, selected copies, or metadata changed before preparation.");
    await args.bases.publish(base.baseRevisionId, snapshot.sourceTree.revision, snapshot.sourceTree.files);
  };
  const apply = async (
    intentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome> => {
    const step = getAdoptionStep(effect);
    const intent = intentFor(step);
    const base = step.baseReferences?.[0];
    const savedEvidence = step.adoptionEvidence;
    if (!base || !savedEvidence || !step.metadataEffects) throw new Error("The saved adoption evidence is incomplete.");
    const snapshot = await read(intent);
    if (snapshot.status !== "ready" || !matchesSaved(snapshot, intentId, step, now)) {
      return {
        status: "failed",
        source: { status: "unchanged", sourceId: intent.request.source.sourceId },
        targets: targetResults(step, "failed"),
        receiptIds: [],
        receipts: [],
        recoveryAvailable: false,
        issues: [
          issue(
            snapshot.status === "ready" ? "adoption-stale" : snapshot.code,
            snapshot.status === "ready"
              ? "The approved source, selected copies, or touched metadata changed; refresh the adoption."
              : snapshot.message,
            "refresh",
          ),
        ],
        resolution: resolution(step, "failed"),
      };
    }
    const savedBase = await args.bases.read(base.baseRevisionId);
    if (savedBase.status !== "ready" || !sameRevision(savedBase.revision, snapshot.sourceTree.revision))
      throw new Error("The prepared immutable adoption base is unavailable or no longer matches the source.");
    const planned = policy(snapshot, intent, base.baseRevisionId, intentId, now, step);
    if (planned.status !== "ready") throw new Error(planned.reason);
    if (planned.noOp) return result("no-op", intent, step);
    await progress({ stepId: step.stepId, status: "applying" });
    const bindingResult = await args.bindings.updateExact(
      planned.bindingEffects.map((change) => ({
        bindingId: change.bindingId,
        ...(change.before ? { expected: change.before } : {}),
        ...(change.after ? { next: change.after } : {}),
      })),
    );
    if (bindingResult.status !== "ready")
      throw new Error("The exact Binding update failed; inspect adoption recovery.");
    const useResult = await args.relationships.updateUsesExact(savedEvidence.storeRevision, planned.metadataEffects);
    if (useResult.status !== "saved")
      throw new Error("The exact managed-use update failed; inspect adoption recovery.");
    await progress({ stepId: step.stepId, status: "verifying" });
    const verified = await read(intent);
    if (verified.status !== "ready" || !verifyAfter(verified, step, snapshot.sourceTree.revision))
      throw new Error("Adoption metadata or tree evidence did not verify after its write.");
    const receipt = makeReceipt(intentId, step, intent, now);
    if ((await args.operationStore.append(receipt)).status !== "ready")
      throw new Error("The adoption child receipt could not be saved; inspect recovery.");
    await progress({ stepId: step.stepId, status: "applied", receiptId: receipt.operationId });
    return result("applied", intent, step, receipt);
  };
  return { preview, prepare, apply };
}
