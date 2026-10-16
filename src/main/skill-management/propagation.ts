import { sourceReferenceRecovery } from "./source-observation";
import { randomUUID } from "node:crypto";

import { createUnifiedDiff } from "../../domain/unified-diff";
import type { SkillEffectBuild, SkillEffectDraft } from "../../application/skill-management";
import type { SkillEffectFingerprint } from "../../domain/skill-management-intent";
import type { SkillEffectStep, SkillFileSummary, SkillIssue, SkillScope } from "../../shared/skill-management-ipc";
import type {
  SkillPropagationIntent,
  SkillPropagationSummary,
  SkillPropagationTarget,
} from "../../shared/skill-propagation-ipc";
import type { SkillPropagationStepEvidence } from "../../shared/skill-propagation-effects";
import type { OperationAction, OperationPlan } from "../../shared/operations-ipc";
import type { createWriteSkillOperations } from "../operations-write-skill";
import type { SkillPropagationSnapshot, SkillPropagationLocationSnapshot } from "./propagation-reader";

type ReadySnapshot = Extract<SkillPropagationSnapshot, { status: "ready" }>;
type WriteOperations = ReturnType<typeof createWriteSkillOperations>;
type BuiltPropagation = Readonly<{
  draft: SkillEffectDraft;
  snapshot: ReadySnapshot;
  sourcePlanId?: string;
}>;

const issue = (code: string, message: string, recoveryAction: SkillIssue["recoveryAction"]): SkillIssue => ({
  code,
  message,
  recoveryAction,
});

function bytesToText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function fullPath(location: SkillPropagationLocationSnapshot["location"], path: string): string {
  return `${location.folderPath}/${path}`;
}

function targetFileChanges(
  snapshot: ReadySnapshot,
  location: SkillPropagationLocationSnapshot,
): Readonly<{
  actions: readonly OperationAction[];
  files: readonly SkillFileSummary[];
}> {
  const local = location.localTree?.files;
  if (!local) return { actions: [], files: [] };
  const actions: OperationAction[] = [];
  const files: SkillFileSummary[] = [];
  const paths = [...new Set([...snapshot.projectedSource.files.keys(), ...local.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );
  for (const path of paths) {
    const before = local.get(path);
    const after = snapshot.projectedSource.files.get(path);
    if (before && after && Buffer.from(before).equals(Buffer.from(after))) continue;
    const relativePath = fullPath(location.location, path);
    if (!after) {
      const text = before ? bytesToText(before) : undefined;
      const diff =
        text === undefined
          ? `${relativePath}: binary content deleted (${before?.byteLength ?? 0} bytes).`
          : createUnifiedDiff(`${relativePath} (current)`, `${relativePath} (deleted)`, text, "").text;
      actions.push({
        kind: "delete-file",
        relativePath,
        beforeHash: location.target.files?.find((file) => file.path === path)?.beforeHash,
        diff,
      });
      files.push({
        rootId: location.location.projectId,
        relativePath,
        change: "delete",
        ...(before ? { byteLength: before.byteLength } : {}),
        ...(location.target.files?.find((file) => file.path === path)?.beforeHash
          ? { beforeHash: location.target.files!.find((file) => file.path === path)!.beforeHash }
          : {}),
        diff,
      });
      continue;
    }
    const beforeText = before ? bytesToText(before) : "";
    const afterText = bytesToText(after);
    const beforeHash = location.target.files?.find((file) => file.path === path)?.beforeHash;
    const afterHash = location.target.files?.find((file) => file.path === path)?.afterHash;
    const change = before ? "change" : "add";
    const diff =
      beforeText !== undefined && afterText !== undefined
        ? createUnifiedDiff(
            `${relativePath} (${before ? "current" : "absent"})`,
            `${relativePath} (proposed)`,
            beforeText,
            afterText,
          ).text
        : `${relativePath}: binary content ${before ? "updated" : "added"} (${after.byteLength} bytes).`;
    actions.push({
      kind: "write-file",
      relativePath,
      byteLength: after.byteLength,
      ...(beforeHash ? { beforeHash } : {}),
      ...(afterHash ? { afterHash } : {}),
      diff,
    });
    files.push({
      rootId: location.location.projectId,
      relativePath,
      change,
      byteLength: after.byteLength,
      ...(beforeHash ? { beforeHash } : {}),
      ...(afterHash ? { afterHash } : {}),
      ...(diff ? { diff } : {}),
    });
  }
  return { actions, files };
}

function stepForTarget(
  intentId: string,
  snapshot: ReadySnapshot,
  target: SkillPropagationLocationSnapshot,
): SkillEffectStep {
  if (
    !target.use ||
    !target.binding ||
    !target.useEffect ||
    !target.nextBinding ||
    !target.localTree ||
    !target.baseTree ||
    !target.rootIdentity ||
    !target.baseRevisionId
  )
    throw new Error("An eligible propagation target is missing verified relationship evidence.");
  const stepId = randomUUID();
  const changes = target.target.state === "eligible" ? targetFileChanges(snapshot, target) : { actions: [], files: [] };
  const evidence: SkillPropagationStepEvidence = {
    intentId,
    skillId: target.use.skillId,
    source: snapshot.intent.source,
    location: target.location,
    relationshipRevision: snapshot.relationshipRevision,
    sourceRootIdentity: snapshot.sourceRootIdentity,
    projectRootIdentity: target.rootIdentity,
    sourceRevision: snapshot.projectedSource.revision,
    localRevision: target.localTree.revision,
    baseRevision: target.baseTree.revision,
    previousBaseRevisionId: target.baseRevisionId,
    nextBaseRevisionId: target.useEffect.after!.baseRevisionId,
  };
  const scope: SkillScope = {
    sourceId: snapshot.intent.source.sourceId,
    packageId: snapshot.intent.source.packageId,
    artifactPath: snapshot.intent.source.artifactPath,
    targets: [
      {
        projectId: target.location.projectId,
        harnessId: target.location.harnessId,
        bindingId: target.binding.bindingId,
      },
    ],
  };
  const actions = changes.actions;
  const plan: OperationPlan = {
    planId: stepId,
    kind: "propagate-skill",
    displayTarget: target.location.folderPath,
    actions,
    git: { mode: "disabled", warnings: [] },
    visibleIn: ["omni"],
  };
  return {
    stepId,
    scope,
    plan,
    bindingEffects: [{ bindingId: target.binding.bindingId, before: target.binding, after: target.nextBinding }],
    files: changes.files,
    metadataEffects: [target.useEffect],
    baseReferences: [
      { baseRevisionId: target.useEffect.after!.baseRevisionId, revision: snapshot.projectedSource.revision },
    ],
    propagationEvidence: evidence,
  };
}

function summary(intent: SkillPropagationIntent, snapshot: ReadySnapshot): SkillPropagationSummary {
  const mode = intent.kind;
  return {
    mode,
    source: intent.source,
    ...(intent.kind === "maintain-current" && intent.retryOf ? { retryOf: intent.retryOf } : {}),
    sourceRootIdentity: snapshot.sourceRootIdentity,
    relationshipRevision: snapshot.relationshipRevision,
    targets: snapshot.locations.map(({ target }) => target),
  };
}

function targetScope(steps: readonly SkillEffectStep[]): SkillScope["targets"] {
  return steps.flatMap(({ scope }) => scope.targets);
}

function fingerprint(
  scope: SkillScope,
  steps: readonly SkillEffectStep[],
  propagation: SkillPropagationSummary,
): SkillEffectFingerprint {
  return {
    scope,
    files: steps.flatMap(({ files }) => files),
    bindings: steps.flatMap(({ bindingEffects }) => bindingEffects),
    actions: steps.flatMap((step) =>
      step.plan.actions.map((action) => ({
        rootId: step.scope.targets[0]?.projectId ?? step.scope.sourceId ?? "unknown",
        kind: action.kind,
        relativePath: action.relativePath,
        ...(action.beforeHash ? { beforeHash: action.beforeHash } : {}),
        ...(action.afterHash ? { afterHash: action.afterHash } : {}),
      })),
    ),
    metadataEffects: steps.flatMap(({ metadataEffects }) => metadataEffects ?? []),
    baseReferences: steps.flatMap(({ baseReferences }) => baseReferences ?? []),
    propagation,
  };
}

export async function buildSkillPropagationDraft(
  intent: SkillPropagationIntent,
  intentId: string,
  snapshot: SkillPropagationSnapshot,
  writeSkill: WriteOperations,
): Promise<BuiltPropagation | SkillEffectBuild> {
  if (snapshot.status === "blocked")
    return {
      status: "blocked",
      reason: snapshot.message,
      details: [issue(snapshot.code, snapshot.message, sourceReferenceRecovery(snapshot.code))],
    };
  const steps: SkillEffectStep[] = [];
  let sourcePlanId: string | undefined;
  if (intent.kind === "update-and-maintain") {
    const source = await writeSkill.preview({ ...intent.request, kind: "write-skill" });
    if (source.status !== "ready")
      return {
        status: "blocked",
        reason: source.diagnostic,
        details: [issue(source.reason, source.diagnostic, "refresh")],
      };
    sourcePlanId = source.plan.planId;
    steps.push({
      stepId: source.plan.planId,
      scope: {
        sourceId: intent.source.sourceId,
        packageId: intent.source.packageId,
        artifactPath: intent.source.artifactPath,
        targets: [],
      },
      plan: source.plan,
      bindingEffects: [],
      files: source.plan.actions
        .filter((action) => action.kind === "write-file" || action.kind === "delete-file")
        .map((action) => ({
          rootId: intent.source.sourceId,
          relativePath: action.relativePath,
          change: action.kind === "delete-file" ? "delete" : action.beforeHash ? "change" : "add",
          ...(action.byteLength === undefined ? {} : { byteLength: action.byteLength }),
          ...(action.beforeHash ? { beforeHash: action.beforeHash } : {}),
          ...(action.afterHash ? { afterHash: action.afterHash } : {}),
          ...(action.diff ? { diff: action.diff } : {}),
        })),
    });
  }
  const targets = snapshot.locations.filter(
    ({ target }) => target.state === "eligible" || target.state === "already-current",
  );
  for (const target of targets) steps.push(stepForTarget(intentId, snapshot, target));
  const propagation = summary(intent, snapshot);
  const scope: SkillScope = {
    sourceId: intent.source.sourceId,
    packageId: intent.source.packageId,
    artifactPath: intent.source.artifactPath,
    targets: targetScope(steps),
  };
  const draft: SkillEffectDraft = {
    status: "ready",
    planId: randomUUID(),
    scope,
    steps,
    fingerprint: fingerprint(scope, steps, propagation),
    backupReferences: targets
      .filter(({ target }) => target.state === "eligible")
      .map((target) => ({
        rootId: target.location.projectId,
        path: `backups/skill-propagation/${intentId}/${target.target.bindingId ?? "target"}`,
      })),
    propagation,
  };
  return { draft, snapshot, ...(sourcePlanId ? { sourcePlanId } : {}) };
}
