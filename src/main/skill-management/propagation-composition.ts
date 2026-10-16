import { createHash } from "node:crypto";
import { join } from "node:path";

import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillIssue, SkillResult } from "../../shared/skill-management-ipc";
import type {
  SkillPropagationIntent,
  SkillPropagationTarget,
  SkillPropagationCandidate,
} from "../../shared/skill-propagation-ipc";
import type { SourceSkillRef } from "../../domain/skill-reconciliation/types";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { SkillLocationKey } from "../../domain/skill-reconciliation/types";
import { backupFiles, readRegularFile } from "../operation-files";
import { currentGrantRoot } from "../granted-hashing";
import { captureSkillTree } from "../skill-reconciliation/capture-engine";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";
import {
  freshGrant,
  hasActiveSourceAndProject,
  observationGrant,
  skillRootIdentity,
  SKILL_SCAN_BUDGET_BYTES,
} from "./adoption-reader";
import {
  readSkillPropagationSnapshot,
  propagationEvidenceFingerprint,
  type SkillPropagationSnapshot,
} from "./propagation-reader";
import { buildSkillPropagationDraft } from "./propagation";
import { createSkillPropagationRecoveryAdapter } from "./propagation-recovery";
import { applyPropagationTarget } from "./propagation-target-apply";
import type {
  ReadySkillPropagationSnapshot,
  SkillPropagationApplyPlan,
  SkillPropagationDependencies,
} from "./propagation-types";

type ReadySnapshot = ReadySkillPropagationSnapshot;
type Dependencies = SkillPropagationDependencies;
type ApplyPlan = SkillPropagationApplyPlan;

const issue = (code: string, message: string, recoveryAction: SkillIssue["recoveryAction"]): SkillIssue => ({
  code,
  message,
  recoveryAction,
});
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const locationKey = (location: SkillLocationKey): string =>
  JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
const backupRelativePath = (intentId: string, bindingId: string): string =>
  "omni/backups/skill-propagation/" + intentId + "/" + bindingId;
const backupRoot = (args: Dependencies, intentId: string, bindingId: string): string =>
  join(args.userDataPath, backupRelativePath(intentId, bindingId));

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function sameSource(left: SourceSkillRef, right: SourceSkillRef): boolean {
  return (
    left.sourceId === right.sourceId && left.packageId === right.packageId && left.artifactPath === right.artifactPath
  );
}
function hashOrAbsent(bytes: Uint8Array | undefined): string | undefined {
  return bytes ? sha256(bytes) : undefined;
}
function errorIssue(error: unknown, code: string): SkillIssue {
  return issue(
    code,
    error instanceof Error ? error.message : "The target could not be updated safely.",
    "inspect-recovery",
  );
}
function targetUse(step: import("../../shared/skill-management-ipc").SkillEffectStep) {
  const effect = step.metadataEffects?.[0];
  if (!effect?.before || !effect.after || !step.propagationEvidence)
    throw new Error("Saved propagation metadata is incomplete.");
  return effect;
}
function savedResult(
  target: SkillPropagationTarget,
  result: NonNullable<SkillPropagationTarget["result"]>,
): SkillPropagationTarget {
  return { ...target, result };
}
function targetOutcome(
  target: SkillPropagationTarget,
  status: SkillResult["targets"][number]["status"],
): SkillResult["targets"][number] | undefined {
  if (!target.bindingId) return undefined;
  return {
    projectId: target.location.projectId,
    harnessId: target.location.harnessId,
    bindingId: target.bindingId,
    artifactPath: target.location.folderPath,
    status,
  };
}

async function validateRetry(
  args: Dependencies,
  intent: SkillPropagationIntent,
): Promise<readonly SkillPropagationTarget[] | undefined> {
  if (intent.kind !== "maintain-current" || !intent.retryOf) return undefined;
  if (!intent.locations) throw new Error("A retry must select the original failed targets explicitly.");
  const [history, original] = await Promise.all([args.operationStore.read(), args.journal.read(intent.retryOf)]);
  if (history.status !== "ready" || original.status !== "ready")
    throw new Error("The original operation result is unavailable for retry.");
  if (["recovery-required", "applying", "verifying"].includes(original.record.status))
    throw new Error("The original operation has an unknown step and must enter recovery before retry.");
  const receipt = history.receipts.find(
    (item) => item.operationId === intent.retryOf && item.kind === "skill-management",
  );
  const saved = receipt?.skillManagement?.propagation;
  if (
    !receipt ||
    !saved ||
    receipt.restored ||
    saved.source.sourceId !== intent.source.sourceId ||
    saved.source.packageId !== intent.source.packageId ||
    saved.source.artifactPath !== intent.source.artifactPath
  )
    throw new Error("The retry link does not identify an unchanged skill propagation result.");
  const candidates = new Set(
    saved.targets
      .filter(
        (target) =>
          ["failed", "unavailable", "pending"].includes(target.result ?? "") ||
          ["withheld", "unavailable"].includes(target.state),
      )
      .map(({ location }) => locationKey(location)),
  );
  if ((intent.locations ?? []).some((location) => !candidates.has(locationKey(location))))
    throw new Error(
      "A retry can select only failed, unavailable or newly eligible withheld targets from the original result.",
    );
  return saved.targets;
}

function validateRetrySkillIds(
  intent: SkillPropagationIntent,
  originalTargets: readonly SkillPropagationTarget[] | undefined,
  snapshot: ReadySnapshot,
): void {
  if (!originalTargets || !intent.locations) return;
  const originalByLocation = new Map(originalTargets.map((target) => [locationKey(target.location), target]));
  for (const { target } of snapshot.locations) {
    const previous = originalByLocation.get(locationKey(target.location));
    if (previous?.skillId && target.skillId !== previous.skillId)
      throw new Error("The target logical skill changed since the original result; review it as a new operation.");
  }
}

async function validatePreview(args: Dependencies, snapshot: ReadySnapshot): Promise<void> {
  const fresh = await readSkillPropagationSnapshot(snapshot.intent, args);
  if (fresh.status !== "ready" || propagationEvidenceFingerprint(fresh) !== propagationEvidenceFingerprint(snapshot))
    throw new Error("The source, project trees, roots, base or managed-use evidence changed; refresh the preview.");
}

function resultSummary(
  snapshot: ReadySnapshot,
  results: ReadonlyMap<string, NonNullable<SkillPropagationTarget["result"]>>,
  reasons: ReadonlyMap<string, string> = new Map(),
): NonNullable<SkillEffectOutcome["propagation"]> {
  return {
    mode: snapshot.intent.kind,
    source: snapshot.intent.source,
    ...(snapshot.intent.kind === "maintain-current" && snapshot.intent.retryOf
      ? { retryOf: snapshot.intent.retryOf }
      : {}),
    sourceRootIdentity: snapshot.sourceRootIdentity,
    relationshipRevision: snapshot.relationshipRevision,
    targets: snapshot.locations.map(({ target }) => ({
      ...savedResult(
        target,
        results.get(locationKey(target.location)) ??
          (target.state === "current" ? "no-op" : target.state === "retained-local" ? "retained-local" : "unavailable"),
      ),
      ...(reasons.has(locationKey(target.location)) ? { reason: reasons.get(locationKey(target.location))! } : {}),
    })),
  };
}

export function createSkillPropagationAdapter(args: Dependencies): Readonly<{
  preview(intent: SkillPropagationIntent, intentId: string): Promise<SkillEffectBuild>;
  readCandidates(source: SourceSkillRef): Promise<readonly SkillPropagationCandidate[]>;
  validateAuthorization(record: SkillOperationJournalRecord): Promise<void>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress: SkillStepProgress): Promise<SkillEffectOutcome>;
  previewReceipt(receipt: OperationReceipt, intentId: string): Promise<SkillEffectBuild>;
  has(planId: string): boolean;
}> {
  const plans = new Map<string, ApplyPlan>();
  const recovery = createSkillPropagationRecoveryAdapter(args);
  const readCandidates = async (source: SourceSkillRef): Promise<readonly SkillPropagationCandidate[]> => {
    const state = await args.relationships.read();
    if (state.status !== "ready")
      throw new Error("Managed skill links are unavailable. Refresh the source before continuing.");
    return state.state.skills
      .flatMap((record) => {
        const locations = state.state.uses
          .filter((use) => !use.disabled && use.skillId === record.skillId && sameSource(use.source, source))
          .filter((use) => record.locations.some((location) => locationKey(location) === locationKey(use.location)))
          .map(({ location }) => location)
          .sort((left, right) => locationKey(left).localeCompare(locationKey(right)));
        return locations.length ? [{ skillId: record.skillId, locations }] : [];
      })
      .sort((left, right) => left.skillId.localeCompare(right.skillId));
  };
  const preview = async (intent: SkillPropagationIntent, intentId: string): Promise<SkillEffectBuild> => {
    try {
      const originalTargets = await validateRetry(args, intent);
      const snapshot = await readSkillPropagationSnapshot(intent, args);
      if (snapshot.status === "ready") validateRetrySkillIds(intent, originalTargets, snapshot);
      const built = await buildSkillPropagationDraft(intent, intentId, snapshot, args.writeSkill);
      if (!("draft" in built)) return built;
      plans.set(built.draft.planId, {
        intent,
        snapshot: built.snapshot,
        ...(built.sourcePlanId ? { sourcePlanId: built.sourcePlanId } : {}),
      });
      return built.draft;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Propagation could not be previewed safely.";
      return {
        status: "blocked",
        reason: message,
        details: [issue("propagation-preview-blocked", message, "inspect-recovery")],
      };
    }
  };
  const validateAuthorization = async (record: SkillOperationJournalRecord): Promise<void> => {
    const plan = record.effect && plans.get(record.effect.planId);
    if (!plan) throw new Error("The propagation preview expired; refresh it before applying.");
    await validatePreview(args, plan.snapshot);
  };
  const prepare = async (intentId: string, effect: SkillEffectDraft): Promise<void> => {
    if (recovery.has(effect.planId)) return recovery.prepare(intentId, effect);
    const plan = plans.get(effect.planId);
    if (!plan) throw new Error("The propagation preview expired; refresh it before preparing.");
    if (plan.sourcePlanId) await args.writeSkill.prepare(plan.sourcePlanId);
    for (const step of effect.steps.filter(({ plan: op }) => op.kind === "propagate-skill")) {
      const target = plan.snapshot.locations.find(
        (item) =>
          item.location.projectId === step.scope.targets[0]?.projectId &&
          item.location.harnessId === step.scope.targets[0]?.harnessId,
      );
      const bindingId = target?.binding?.bindingId;
      if (!target?.localTree || !target.projectGrant || !bindingId)
        throw new Error("The project backup target is no longer available.");
      const root = backupRoot(args, intentId, bindingId);
      const paths = [...target.localTree.files.keys()].map((path) => target.location.folderPath + "/" + path);
      if (paths.length) await backupFiles(target.projectGrant.root, root, paths);
      for (const path of paths) {
        const saved = await readRegularFile(root, path);
        const relative = path.slice(target.location.folderPath.length + 1);
        const expected = target.localTree.files.get(relative);
        if (!saved || !expected || sha256(saved) !== sha256(expected))
          throw new Error("The verified project backup is unavailable: " + path);
      }
    }
  };
  const apply = async (
    intentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome> => {
    if (recovery.has(effect.planId)) return recovery.apply(intentId, effect, progress);
    const plan = plans.get(effect.planId);
    if (!plan) throw new Error("The propagation preview expired; refresh it before applying.");
    const receipts: OperationReceipt[] = [];
    const issues: SkillIssue[] = [];
    const results = new Map<string, NonNullable<SkillPropagationTarget["result"]>>();
    const reasons = new Map<string, string>();
    const outcomes: SkillResult["targets"][number][] = [];
    let source: SkillResult["source"] = { status: "unchanged", sourceId: plan.intent.source.sourceId };
    const sourceStep = effect.steps.find((step) => step.plan.kind === "write-skill");
    if (sourceStep && sourceStep.plan.actions.length) {
      await progress({ stepId: sourceStep.stepId, status: "applying" });
      const applied = await args.writeSkill.apply({ planId: plan.sourcePlanId! });
      if (!applied || applied.receipt.status !== "applied") {
        await progress({
          stepId: sourceStep.stepId,
          status: "failed",
          ...(applied ? { receiptId: applied.receipt.operationId } : {}),
        });
        if (applied) receipts.push(applied.receipt);
        const targets = plan.snapshot.locations.map(({ target }) =>
          savedResult(
            target,
            target.state === "retained-local"
              ? "retained-local"
              : target.state === "current"
                ? "no-op"
                : target.state === "withheld" || target.state === "unavailable"
                  ? "unavailable"
                  : "pending",
          ),
        );
        return {
          status: "failed",
          source: { status: "failed", sourceId: plan.intent.source.sourceId },
          targets: [],
          receiptIds: receipts.map(({ operationId }) => operationId),
          ...(receipts.length ? { receipts } : {}),
          propagation: {
            mode: plan.intent.kind,
            source: plan.intent.source,
            sourceRootIdentity: plan.snapshot.sourceRootIdentity,
            relationshipRevision: plan.snapshot.relationshipRevision,
            targets,
          },
          issues: [
            issue(
              "source-update-failed",
              applied?.receipt.diagnostic ?? "The owned source update failed; no project target was started.",
              "inspect-recovery",
            ),
          ],
          recoveryAvailable: Boolean(applied?.receipt.status === "failed"),
        };
      }
      source = { status: "updated", sourceId: plan.intent.source.sourceId };
      receipts.push(applied.receipt);
      await progress({ stepId: sourceStep.stepId, status: "applied", receiptId: applied.receipt.operationId });
      const postSource = await revalidateAfterSourceWrite(args, plan.snapshot);
      if (!postSource) {
        for (const { target } of plan.snapshot.locations) {
          results.set(
            locationKey(target.location),
            target.state === "current" || target.state === "already-current"
              ? "no-op"
              : target.state === "retained-local"
                ? "retained-local"
                : target.state === "withheld" || target.state === "unavailable"
                  ? "unavailable"
                  : "pending",
          );
        }
        const propagation = resultSummary(plan.snapshot, results);
        return {
          status: "partial",
          source,
          targets: propagation.targets
            .filter((target) => target.bindingId)
            .map((target) => ({
              projectId: target.location.projectId,
              harnessId: target.location.harnessId,
              bindingId: target.bindingId!,
              artifactPath: target.location.folderPath,
              status:
                target.result === "no-op" ? "no-op" : target.result === "retained-local" ? "retained-local" : "pending",
            })),
          receiptIds: receipts.map(({ operationId }) => operationId),
          receipts,
          propagation,
          issues: [
            issue(
              "targets-revalidation-required",
              "A project, Binding or managed use changed after the source update. Review a fresh propagation preview before writing project copies.",
              "refresh",
            ),
          ],
          recoveryAvailable: false,
        };
      }
    }
    for (const step of effect.steps.filter(({ plan: op }) => op.kind === "propagate-skill")) {
      await progress({ stepId: step.stepId, status: "applying" });
      const target = plan.snapshot.locations.find(
        (item) => locationKey(item.location) === locationKey(step.propagationEvidence!.location),
      );
      if (!target) throw new Error("The saved propagation target is unavailable.");
      const result = await applyPropagationTarget(args, intentId, plan.snapshot, target, step, progress);
      const key = locationKey(target.location);
      results.set(key, result.result);
      if (result.issue) reasons.set(key, result.issue.message);
      if (result.receipt) receipts.push(result.receipt);
      if (result.issue) issues.push(result.issue);
      const outcome = targetOutcome(
        target.target,
        result.result === "applied"
          ? "applied"
          : result.result === "no-op"
            ? "no-op"
            : result.result === "unknown"
              ? "unknown"
              : "failed",
      );
      if (outcome) outcomes.push(outcome);
    }
    for (const { target } of plan.snapshot.locations) {
      const key = locationKey(target.location);
      if (results.has(key)) continue;
      const result =
        target.state === "current"
          ? "no-op"
          : target.state === "retained-local"
            ? "retained-local"
            : target.state === "withheld" || target.state === "unavailable"
              ? "unavailable"
              : "pending";
      results.set(key, result);
      const outcome = targetOutcome(
        target,
        result === "no-op"
          ? "no-op"
          : result === "retained-local"
            ? "retained-local"
            : result === "unavailable"
              ? "skipped"
              : "pending",
      );
      if (outcome) outcomes.push(outcome);
    }
    const propagation = resultSummary(plan.snapshot, results, reasons);
    const incomplete = propagation.targets.some((target) =>
      ["failed", "unknown", "unavailable", "pending"].includes(target.result ?? ""),
    );
    const changed = source.status === "updated" || propagation.targets.some((target) => target.result === "applied");
    return {
      status: incomplete ? (receipts.length ? "partial" : "failed") : changed ? "applied" : "no-op",
      source,
      targets: outcomes,
      receiptIds: receipts.map(({ operationId }) => operationId),
      ...(receipts.length ? { receipts } : {}),
      propagation,
      issues,
      recoveryAvailable: propagation.targets.some((target) => target.result === "unknown"),
    };
  };
  return {
    preview,
    readCandidates,
    validateAuthorization,
    prepare,
    apply,
    previewReceipt: recovery.previewReceipt,
    has: (planId) => plans.has(planId) || recovery.has(planId),
  };
}

async function revalidateAfterSourceWrite(args: Dependencies, snapshot: ReadySnapshot): Promise<boolean> {
  const [relationships, bindings, registry] = await Promise.all([
    args.relationships.read(),
    args.bindings.read(),
    args.registry.listRegistry(),
  ]);
  if (relationships.status !== "ready" || bindings.status !== "ready" || registry.status !== "ready") return false;
  if (relationships.state.revision !== snapshot.relationshipRevision || !same(bindings.bindings, snapshot.bindings))
    return false;
  const sourceGrant = await freshGrant(
    args.registry,
    { kind: "source", id: snapshot.intent.source.sourceId },
    args.now ?? Date.now,
  );
  if (!sourceGrant || !(await currentGrantRoot(sourceGrant))) return false;
  if (
    skillRootIdentity(sourceGrant, (value) => createHash("sha256").update(value).digest("hex")) !==
    snapshot.sourceRootIdentity
  )
    return false;
  const sourceTree = await captureSkillTree(
    observationGrant(sourceGrant),
    snapshot.sourceFolderPath,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    args.filesystem ?? strictSkillObservationFilesystem,
    (value) => createHash("sha256").update(value).digest("hex"),
  );
  if (sourceTree.status !== "complete" || sourceTree.revision.hash !== snapshot.projectedSource.revision.hash)
    return false;
  for (const target of snapshot.locations) {
    if (!target.projectGrant || !(await currentGrantRoot(target.projectGrant))) {
      if (target.target.state === "unavailable") continue;
      return false;
    }
    if (
      target.rootIdentity &&
      skillRootIdentity(target.projectGrant, (value) => createHash("sha256").update(value).digest("hex")) !==
        target.rootIdentity
    )
      return false;
    if (!hasActiveSourceAndProject(registry, snapshot.intent.source.sourceId, target.location.projectId)) return false;
    if (target.localTree) {
      const current = await captureSkillTree(
        observationGrant(target.projectGrant),
        target.location.folderPath,
        { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
        args.filesystem ?? strictSkillObservationFilesystem,
        (value) => createHash("sha256").update(value).digest("hex"),
      );
      if (current.status !== "complete" || current.revision.hash !== target.localTree.revision.hash) return false;
    }
  }
  return true;
}
