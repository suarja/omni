import { createHash } from "node:crypto";

import type { InventoryArtifactKind } from "./inventory";
import { resolveTarget, type HarnessId, type TargetKind } from "./harness-targets";

export type Binding = Readonly<{
  bindingId: string;
  sourceId: string;
  packageId: string;
  artifactPath: string;
  kind: TargetKind;
  projectId: string;
  harnessId: HarnessId;
  boundHash: string;
  ownedHash?: string;
  createdAt: string;
}>;

export type TargetEvidence = Readonly<{
  harnessId: HarnessId;
  relativePath: string;
  exists: boolean;
  contentHash?: string;
  symlinkTarget?: string;
  providerManaged: boolean;
}>;

export type AssignmentActionState = "add" | "current" | "update" | "linked" | "conflict" | "blocked";
export type AssignmentAction = Readonly<{
  bindingId: string;
  harnessId: HarnessId;
  kind: InventoryArtifactKind;
  relativePath: string;
  state: AssignmentActionState;
  reason?: string;
}>;
export type ProjectPlan = Readonly<{
  projectId: string;
  planId: string;
  status: "ready" | "conflict" | "blocked";
  actions: readonly AssignmentAction[];
}>;

export type AssignmentUnit = Readonly<{
  kind: TargetKind;
  id: string;
  contentHash: string;
  files?: readonly Readonly<{ relativePath: string; contentHash: string }>[];
}>;
export type AssignmentProject = Readonly<{ projectId: string; targets: readonly TargetEvidence[] }>;

type AssignmentInput = Readonly<{
  unit: AssignmentUnit;
  project: AssignmentProject;
  bindings: readonly Binding[];
}>;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedBindings(bindings: readonly Binding[]): Binding[] {
  return [...bindings].sort((left, right) => compare(left.bindingId, right.bindingId));
}

function sortedTargets(targets: readonly TargetEvidence[]): TargetEvidence[] {
  return [...targets].sort(
    (left, right) => compare(left.harnessId, right.harnessId) || compare(left.relativePath, right.relativePath),
  );
}

function targetForBinding(
  unit: AssignmentUnit,
  binding: Binding,
  targets: readonly TargetEvidence[],
): TargetEvidence | undefined {
  const resolved = resolveTarget({ kind: unit.kind, id: unit.id, harnessId: binding.harnessId });
  if (resolved.status === "blocked") return undefined;
  return targets.find(
    (target) => target.harnessId === binding.harnessId && target.relativePath === resolved.relativePath,
  );
}

function isLinked(unit: AssignmentUnit, target: TargetEvidence, allTargets: readonly TargetEvidence[]): boolean {
  if (!target.symlinkTarget) return false;
  const otherTargetPaths = (["claude-code", "codex", "cursor"] as const)
    .filter((harnessId) => harnessId !== target.harnessId)
    .map((harnessId) => resolveTarget({ kind: unit.kind, id: unit.id, harnessId }))
    .filter(
      (result): result is Extract<ReturnType<typeof resolveTarget>, { status: "target" }> => result.status === "target",
    )
    .map((result) => result.relativePath);
  return (
    otherTargetPaths.includes(target.symlinkTarget) &&
    (allTargets.length === 1 || allTargets.some((candidate) => candidate.relativePath === target.symlinkTarget))
  );
}

function actionFor(unit: AssignmentUnit, binding: Binding, targets: readonly TargetEvidence[]): AssignmentAction {
  const resolved = resolveTarget({ kind: unit.kind, id: unit.id, harnessId: binding.harnessId });
  if (resolved.status === "blocked") {
    return {
      bindingId: binding.bindingId,
      harnessId: binding.harnessId,
      kind: unit.kind,
      relativePath: binding.artifactPath,
      state: "blocked",
      reason: resolved.reason,
    };
  }
  const target = targetForBinding(unit, binding, targets);
  if (!target) {
    return {
      bindingId: binding.bindingId,
      harnessId: binding.harnessId,
      kind: unit.kind,
      relativePath: resolved.relativePath,
      state: "blocked",
      reason: "Target evidence is unavailable.",
    };
  }
  if (target.providerManaged) {
    return {
      bindingId: binding.bindingId,
      harnessId: binding.harnessId,
      kind: unit.kind,
      relativePath: resolved.relativePath,
      state: "blocked",
      reason: "Target is managed by a provider.",
    };
  }
  if (isLinked(unit, target, targets)) {
    return {
      bindingId: binding.bindingId,
      harnessId: binding.harnessId,
      kind: unit.kind,
      relativePath: resolved.relativePath,
      state: "linked",
    };
  }
  if (!target.exists) {
    return {
      bindingId: binding.bindingId,
      harnessId: binding.harnessId,
      kind: unit.kind,
      relativePath: resolved.relativePath,
      state: "add",
    };
  }
  if (
    target.contentHash === unit.contentHash ||
    (target.contentHash === binding.ownedHash && binding.boundHash === unit.contentHash)
  ) {
    return {
      bindingId: binding.bindingId,
      harnessId: binding.harnessId,
      kind: unit.kind,
      relativePath: resolved.relativePath,
      state: "current",
    };
  }
  if (target.contentHash && binding.ownedHash !== undefined && target.contentHash === binding.ownedHash) {
    return {
      bindingId: binding.bindingId,
      harnessId: binding.harnessId,
      kind: unit.kind,
      relativePath: resolved.relativePath,
      state: "update",
    };
  }
  return {
    bindingId: binding.bindingId,
    harnessId: binding.harnessId,
    kind: unit.kind,
    relativePath: resolved.relativePath,
    state: "conflict",
    reason: "Target contains local changes.",
  };
}

function planStatus(actions: readonly AssignmentAction[]): ProjectPlan["status"] {
  if (actions.some((action) => action.state === "blocked")) return "blocked";
  if (actions.some((action) => action.state === "conflict")) return "conflict";
  return "ready";
}

function planId(input: AssignmentInput, bindings: readonly Binding[], targets: readonly TargetEvidence[]): string {
  const files = [...(input.unit.files ?? [])].sort((left, right) => compare(left.relativePath, right.relativePath));
  const canonical = JSON.stringify({
    unit: { kind: input.unit.kind, id: input.unit.id, contentHash: input.unit.contentHash, files },
    projectId: input.project.projectId,
    bindings: bindings.map((binding) => ({
      bindingId: binding.bindingId,
      harnessId: binding.harnessId,
      boundHash: binding.boundHash,
    })),
    targets: targets.map((target) => ({
      harnessId: target.harnessId,
      relativePath: target.relativePath,
      exists: target.exists,
      contentHash: target.contentHash ?? null,
      symlinkTarget: target.symlinkTarget ?? null,
      providerManaged: target.providerManaged,
    })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function planAssignment(input: AssignmentInput): ProjectPlan {
  const bindings = sortedBindings(input.bindings.filter((binding) => binding.projectId === input.project.projectId));
  const targets = sortedTargets(input.project.targets);
  const actions = bindings
    .map((binding) => actionFor(input.unit, binding, targets))
    .sort(
      (left, right) =>
        compare(left.harnessId, right.harnessId) ||
        compare(left.relativePath, right.relativePath) ||
        compare(left.bindingId, right.bindingId),
    );
  return {
    projectId: input.project.projectId,
    planId: planId(input, bindings, targets),
    status: planStatus(actions),
    actions,
  };
}
