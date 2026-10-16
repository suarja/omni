import { randomUUID } from "node:crypto";
import type { SkillEffectDraft } from "../../application/skill-management";
import type { SkillEffectStep, SkillFileSummary } from "../../shared/skill-management-ipc";
import { hashExactTree, type ExactSkillTree } from "../skill-management/project-skill-files";
import { hashExternalBytes, type ExternalTargetPlan } from "./operation-types";

function summarizeTree(path: string, tree: ExactSkillTree | undefined): Map<string, Uint8Array> {
  return new Map(
    (tree ?? []).flatMap((entry) =>
      entry.kind === "directory"
        ? []
        : [
            [
              entry.path ? `${path}/${entry.path}` : path,
              entry.kind === "file" ? Buffer.from(entry.data, "base64") : Buffer.from(entry.target),
            ],
          ],
    ),
  );
}
function summarizeFiles(plan: ExternalTargetPlan): SkillFileSummary[] {
  const before = new Map<string, Uint8Array>(),
    after = new Map<string, Uint8Array>();
  const rewritten = new Set<string>();
  for (const layout of plan.backup.layouts) {
    for (const [path, bytes] of summarizeTree(layout.path, layout.before)) before.set(path, bytes);
    for (const [path, bytes] of summarizeTree(layout.path, layout.after)) after.set(path, bytes);
    if (hashExactTree(layout.before) !== hashExactTree(layout.after))
      for (const path of summarizeTree(layout.path, layout.after).keys()) rewritten.add(path);
  }
  if (plan.backup.lockBefore !== undefined) before.set("skills-lock.json", Buffer.from(plan.backup.lockBefore));
  if (plan.backup.lockAfter !== undefined) after.set("skills-lock.json", Buffer.from(plan.backup.lockAfter));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((relativePath) => {
    const beforeHash = hashExternalBytes(before.get(relativePath)),
      afterHash = hashExternalBytes(after.get(relativePath));
    if (beforeHash === afterHash && !rewritten.has(relativePath)) return [];
    return [
      {
        rootId: plan.backup.evidence.projectId,
        relativePath,
        change:
          beforeHash === afterHash
            ? ("unchanged" as const)
            : afterHash
              ? beforeHash
                ? ("change" as const)
                : ("add" as const)
              : ("delete" as const),
        beforeHash,
        afterHash,
        ...(after.has(relativePath) ? { byteLength: after.get(relativePath)!.byteLength } : {}),
      },
    ];
  });
}
export function buildExternalSkillDraft(plans: readonly ExternalTargetPlan[]): SkillEffectDraft {
  const steps: SkillEffectStep[] = plans.map((target) => {
    const evidence = target.backup.evidence,
      files = summarizeFiles(target);
    const harnesses = [...new Set(evidence.layouts.map((layout) => layout.harnessId))];
    const scope = {
      packageId: evidence.sourceId,
      targets: harnesses.map((harnessId) => ({ projectId: evidence.projectId, harnessId })),
    };
    const stepId = evidence.backupPath
      .split("/")
      .at(-1)!
      .replace(/\.json$/u, "");
    return {
      stepId,
      scope,
      bindingEffects: [],
      files,
      externalSkillEvidence: evidence,
      plan: {
        planId: stepId,
        kind: evidence.kind,
        displayTarget: `${evidence.direction === "restore" ? "Restore" : "External skills"} · ${evidence.projectId} · ${evidence.sourceId}`,
        actions: files.map((file) => ({
          kind: file.change === "delete" ? "delete-file" : "write-file",
          relativePath: file.relativePath,
          beforeHash: file.beforeHash,
          afterHash: file.afterHash,
          byteLength: file.byteLength,
        })),
        notes: evidence.refusal
          ? [`Target refused: ${evidence.refusal}`]
          : [
              `${evidence.copies} external skill copies; project lock included.`,
              `Source licence: ${target.backup.licence ?? "none"}.`,
            ],
        git: { mode: "disabled", warnings: [] },
      },
    };
  });
  const targets = [
    ...new Map(
      steps.flatMap((step) => step.scope.targets).map((target) => [`${target.projectId}/${target.harnessId}`, target]),
    ).values(),
  ];
  const scope = { packageId: plans[0]!.backup.evidence.sourceId, targets };
  return {
    status: "ready",
    planId: randomUUID(),
    scope,
    steps,
    fingerprint: {
      scope,
      files: steps.flatMap((step) => step.files),
      bindings: [],
      externalSkillEvidence: plans.map((plan) => plan.backup.evidence),
    },
    backupReferences: plans.map((plan) => ({
      rootId: plan.backup.evidence.projectId,
      path: plan.backup.evidence.backupPath,
    })),
  };
}
