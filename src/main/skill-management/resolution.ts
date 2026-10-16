import { sourceReferenceRecovery } from "./source-observation";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import {
  planManagedSkillResolution,
  type ManagedSkillResolutionPlan,
} from "../../domain/skill-reconciliation/resolution";
import type { SkillManagedResolutionRequest } from "../../shared/skill-reconciliation-request";
import type { SkillEffectFingerprint } from "../../domain/skill-management-intent";
import type { SkillEffectStep, SkillFileSummary } from "../../shared/skill-management-ipc";
import type { SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import { backupFiles, readRegularFile, safePath, type FileWriter } from "../operation-files";
import { createUnifiedDiff } from "../../domain/unified-diff";
import {
  resolutionIssue,
  makeSkillResolutionReceipt,
  resolutionResultDetails,
  resolutionTargetResult,
} from "./resolution-receipts";
import { applyCanonicalResolution } from "./resolution-application";
import {
  readSkillResolutionSnapshot,
  type SkillResolutionReaderDependencies,
  type SkillResolutionSnapshot,
} from "./resolution-reader";

type ReadySnapshot = Extract<SkillResolutionSnapshot, { status: "ready" }>;
type ReadyPlan = Extract<ManagedSkillResolutionPlan, { status: "ready" }>;
type ResolutionRequest = SkillManagedResolutionRequest;
type PreparedResolution = Readonly<{
  intentId: string;
  request: ResolutionRequest;
  snapshot: ReadySnapshot;
  plan: ReadyPlan;
  step: SkillEffectStep;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
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

function hash(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
}

function requestFor(step: SkillEffectStep): ResolutionRequest {
  const evidence = step.resolutionEvidence;
  if (!evidence || step.scope.targets.length !== 1) throw new Error("The saved managed resolution is incomplete.");
  return { choice: evidence.choice, skillId: evidence.skillId, locations: [evidence.local.location] };
}

function decoratedFiles(plan: ReadyPlan, snapshot: ReadySnapshot): SkillFileSummary[] {
  const source = snapshot.sourceTree;
  if (!source) return [...plan.files];
  return plan.files.map((file) => {
    const relativePath = file.relativePath.slice(snapshot.use.location.folderPath.length + 1);
    const before = snapshot.localTree.files.get(relativePath) ?? new Uint8Array();
    const after = source.files.get(relativePath) ?? new Uint8Array();
    const diff = createUnifiedDiff(`${file.relativePath} (local)`, `${file.relativePath} (canonical)`, before, after);
    if (diff.text === "binary file differs")
      return { ...file, summary: "Binary file; complete byte length and hashes are shown." };
    return { ...file, diff: diff.text };
  });
}

function operationActions(files: readonly SkillFileSummary[]) {
  return files.map((file) => ({
    kind: file.change === "delete" ? ("delete-file" as const) : ("write-file" as const),
    relativePath: file.relativePath,
    ...(file.byteLength === undefined || file.change === "delete" ? {} : { byteLength: file.byteLength }),
    ...(file.beforeHash === undefined ? {} : { beforeHash: file.beforeHash }),
    ...(file.afterHash === undefined ? {} : { afterHash: file.afterHash }),
  }));
}

function makeStep(intentId: string, snapshot: ReadySnapshot, planned: ReadyPlan): SkillEffectStep {
  const stepId = uuid(`${intentId}\nresolve-skill-step`);
  const files = decoratedFiles(planned, snapshot);
  const actions = operationActions(files);
  return {
    stepId,
    scope: {
      sourceId: snapshot.use.source.sourceId,
      packageId: snapshot.use.source.packageId,
      artifactPath: snapshot.use.source.artifactPath,
      targets: [
        {
          projectId: snapshot.use.location.projectId,
          harnessId: snapshot.use.location.harnessId,
          bindingId: snapshot.use.bindingId,
        },
      ],
    },
    plan: {
      planId: stepId,
      kind: "resolve-skill",
      displayTarget: snapshot.use.location.folderPath,
      actions,
      git: { mode: "disabled", warnings: [] },
    },
    bindingEffects: planned.bindingEffects,
    files,
    metadataEffects: planned.metadataEffects,
    baseReferences: planned.baseReferences,
    resolutionEvidence: planned.evidence,
  };
}

function fingerprint(step: SkillEffectStep): SkillEffectFingerprint {
  return {
    scope: step.scope,
    files: step.files,
    bindings: step.bindingEffects,
    actions: step.plan.actions.map((action) => ({
      rootId: step.scope.targets[0]!.projectId,
      kind: action.kind,
      relativePath: action.relativePath,
      ...(action.beforeHash ? { beforeHash: action.beforeHash } : {}),
      ...(action.afterHash ? { afterHash: action.afterHash } : {}),
    })),
    metadataEffects: step.metadataEffects,
    baseReferences: step.baseReferences,
    resolutionEvidence: step.resolutionEvidence,
  };
}

function backupReference(intentId: string, projectId: string) {
  return { rootId: projectId, path: `backups/skill-intents/${intentId}/before-managed-resolution` };
}

function build(snapshot: ReadySnapshot, request: ResolutionRequest, intentId: string): ManagedSkillResolutionPlan {
  return planManagedSkillResolution({
    request,
    record: snapshot.record,
    storeRevision: snapshot.relationships.revision,
    use: snapshot.use,
    binding: snapshot.binding,
    local: { rootIdentity: snapshot.rootIdentities.project, revision: snapshot.localTree.revision },
    base: { baseRevisionId: snapshot.base.baseRevisionId, revision: snapshot.base.revision },
    ...(snapshot.sourceTree && snapshot.rootIdentities.source
      ? {
          sourceTree: {
            ref: snapshot.use.source,
            rootIdentity: snapshot.rootIdentities.source,
            revision: snapshot.sourceTree.revision,
          },
        }
      : {}),
    intentId,
  });
}

function sameFileEffects(left: readonly SkillFileSummary[], right: readonly SkillFileSummary[]): boolean {
  const core = (items: readonly SkillFileSummary[]) => items.map(({ diff: _diff, summary: _summary, ...file }) => file);
  return canonical(core(left)) === canonical(core(right));
}

function matchesSaved(
  snapshot: ReadySnapshot,
  request: ResolutionRequest,
  intentId: string,
  step: SkillEffectStep,
): boolean {
  const result = build(snapshot, request, intentId);
  return (
    result.status === "ready" &&
    canonical(result.evidence) === canonical(step.resolutionEvidence) &&
    canonical(result.bindingEffects) === canonical(step.bindingEffects) &&
    canonical(result.metadataEffects) === canonical(step.metadataEffects) &&
    canonical(result.baseReferences) === canonical(step.baseReferences) &&
    sameFileEffects(result.files, step.files)
  );
}

async function backupRoot(userDataPath: string, intentId: string, projectId: string): Promise<string> {
  const path = await safePath(userDataPath, `omni/${backupReference(intentId, projectId).path}`);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const verified = await realpath(path);
  const relativePath = relative(await realpath(userDataPath), verified);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`))
    throw new Error("Managed resolution backup escaped the registered profile.");
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory())
    throw new Error("Managed resolution backup must be a regular profile directory.");
  return path;
}

async function listBackupFiles(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const child = join(directory, name);
      const details = await lstat(child);
      if (details.isSymbolicLink()) throw new Error("Managed resolution backup contains a symbolic link.");
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (details.isDirectory()) await visit(child, relativePath);
      else if (details.isFile()) result.push(relativePath);
      else throw new Error("Managed resolution backup contains a special file.");
    }
  };
  await visit(root, "");
  return result.sort((left, right) => left.localeCompare(right));
}

async function verifyOrCreateBackup(
  args: Readonly<{ userDataPath: string; intentId: string; snapshot: ReadySnapshot }>,
): Promise<void> {
  const root = await backupRoot(args.userDataPath, args.intentId, args.snapshot.use.location.projectId);
  const paths = [...args.snapshot.localTree.files.keys()]
    .map((path) => `${args.snapshot.use.location.folderPath}/${path}`)
    .sort((left, right) => left.localeCompare(right));
  const existing = await listBackupFiles(root);
  if (!existing.length) await backupFiles(args.snapshot.projectGrant.root, root, paths);
  const saved = await listBackupFiles(root);
  if (canonical(saved) !== canonical(paths))
    throw new Error("The complete managed resolution backup does not match the reviewed local tree.");
  for (const [relativePath, bytes] of args.snapshot.localTree.files) {
    const copy = await readRegularFile(root, `${args.snapshot.use.location.folderPath}/${relativePath}`);
    if (hash(copy) !== hash(bytes)) throw new Error(`Managed resolution backup failed verification: ${relativePath}`);
  }
}

function afterUse(step: SkillEffectStep) {
  return step.metadataEffects?.[0]?.after ?? step.resolutionEvidence!.use;
}

export function createSkillResolutionAdapter(
  args: Readonly<{
    userDataPath: string;
    registry: RegistryIpcServices;
    relationships: SkillRelationshipStore;
    bindings: BindingsStore;
    bases: SkillBaseStore;
    operationStore: OperationStore;
    filesystem?: SkillObservationFilesystem;
    fileWriter?: FileWriter;
    now?: () => number;
  }>,
): Readonly<{
  preview(
    intent: Extract<import("../../shared/skill-management-ipc").SkillIntent, { kind: "reconcile" }> & {
      request: ResolutionRequest;
    },
    intentId: string,
  ): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress: SkillStepProgress): Promise<SkillEffectOutcome>;
  has(planId: string): boolean;
}> {
  const now = args.now ?? Date.now;
  const plans = new Map<string, PreparedResolution>();
  const dependencies: SkillResolutionReaderDependencies = {
    registry: args.registry,
    relationships: args.relationships,
    bindings: args.bindings,
    bases: args.bases,
    ...(args.filesystem ? { filesystem: args.filesystem } : {}),
    now,
  };
  const read = (request: ResolutionRequest) => readSkillResolutionSnapshot(request, dependencies);
  const preview = async (
    intent: Extract<import("../../shared/skill-management-ipc").SkillIntent, { kind: "reconcile" }> & {
      request: ResolutionRequest;
    },
    intentId: string,
  ): Promise<SkillEffectBuild> => {
    const snapshot = await read(intent.request);
    if (snapshot.status !== "ready")
      return {
        status: snapshot.status,
        reason: snapshot.message,
        details: [
          resolutionIssue(
            snapshot.code,
            snapshot.message,
            snapshot.status === "needs-input" ? "choose-targets" : sourceReferenceRecovery(snapshot.code),
          ),
        ],
      };
    const planned = build(snapshot, intent.request, intentId);
    if (planned.status !== "ready")
      return {
        status: planned.status,
        reason: planned.reason,
        details: [
          resolutionIssue(
            planned.code,
            planned.reason,
            planned.status === "needs-input" ? "choose-targets" : "reconnect",
          ),
        ],
      };
    const step = makeStep(intentId, snapshot, planned);
    const backupReferences =
      planned.choice === "use-canonical" && planned.files.length
        ? [backupReference(intentId, snapshot.use.location.projectId)]
        : [];
    const built: SkillEffectDraft = {
      status: "ready",
      planId: step.stepId,
      scope: step.scope,
      steps: [step],
      fingerprint: fingerprint(step),
      backupReferences,
    };
    plans.set(step.stepId, { intentId, request: intent.request, snapshot, plan: planned, step });
    return built;
  };
  const getPlan = (effect: SkillEffectDraft): PreparedResolution => {
    const saved = plans.get(effect.planId);
    if (!saved || effect.steps.length !== 1 || effect.steps[0]?.stepId !== saved.step.stepId)
      throw new Error("The managed resolution preview expired; review it again.");
    return saved;
  };
  const fresh = async (saved: PreparedResolution): Promise<ReadySnapshot> => {
    const current = await read(saved.request);
    if (current.status !== "ready" || !matchesSaved(current, saved.request, saved.intentId, saved.step)) {
      throw new Error(
        current.status === "ready"
          ? "The approved source, selected tree, base, use, or Binding changed after review."
          : current.message,
      );
    }
    return current;
  };
  const prepare = async (_intentId: string, effect: SkillEffectDraft): Promise<void> => {
    const saved = getPlan(effect);
    const snapshot = await fresh(saved);
    if (saved.plan.choice !== "use-canonical" || saved.plan.noOp) return;
    if (saved.plan.files.length)
      await verifyOrCreateBackup({ userDataPath: args.userDataPath, intentId: saved.intentId, snapshot });
    const evidence = saved.step.resolutionEvidence!;
    const afterBase = saved.plan.baseReferences.find(
      (base) => base.baseRevisionId === afterUse(saved.step).baseRevisionId,
    );
    if (!afterBase) throw new Error("The verified canonical base reference is missing from the reviewed effect.");
    const existing = await args.bases.read(afterBase.baseRevisionId);
    if (existing.status === "ready") {
      if (canonical(existing.revision) !== canonical(afterBase.revision))
        throw new Error("The canonical base id already contains different bytes.");
    } else {
      if (!snapshot.sourceTree) throw new Error("The approved source tree is unavailable for base publication.");
      await args.bases.publish(afterBase.baseRevisionId, snapshot.sourceTree.revision, snapshot.sourceTree.files);
    }
    const verified = await args.bases.read(afterBase.baseRevisionId);
    if (verified.status !== "ready" || canonical(verified.revision) !== canonical(afterBase.revision))
      throw new Error("The canonical immutable base failed verification.");
    if (evidence.sourceTree && !snapshot.sourceTree)
      throw new Error("The approved source tree changed before preparation.");
  };

  const apply = async (
    _intentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome> => {
    const saved = getPlan(effect);
    const snapshot = await fresh(saved);
    const step = effect.steps[0]!;
    if (saved.plan.noOp) {
      await progress({ stepId: step.stepId, status: "skipped" });
      return {
        status: "no-op",
        source: { status: "unchanged", sourceId: step.resolutionEvidence!.source.sourceId },
        targets: resolutionTargetResult(step, "no-op"),
        receiptIds: [],
        resolution: resolutionResultDetails(step, "no-op"),
        issues: [],
        recoveryAvailable: false,
      };
    }
    if (saved.plan.choice === "keep-local") {
      await progress({ stepId: step.stepId, status: "applying" });
      await progress({ stepId: step.stepId, status: "verifying" });
      const receipt = makeSkillResolutionReceipt(saved.intentId, step, [], "applied", now);
      if ((await args.operationStore.append(receipt)).status !== "ready")
        throw new Error("The retained-local decision receipt could not be saved.");
      await progress({ stepId: step.stepId, status: "applied", receiptId: receipt.operationId });
      return {
        status: "applied",
        source: { status: "unchanged", sourceId: step.resolutionEvidence!.source.sourceId },
        targets: resolutionTargetResult(step, "retained-local"),
        receiptIds: [receipt.operationId],
        receipts: [receipt],
        resolution: resolutionResultDetails(step, "retained-local"),
        issues: [],
        recoveryAvailable: false,
      };
    }
    return applyCanonicalResolution({
      intentId: saved.intentId,
      snapshot,
      step,
      progress,
      dependencies: args,
      now,
    });
  };
  return { preview, prepare, apply, has: (planId) => plans.has(planId) };
}
