import type { OperationPlan, OperationReceipt } from "../../shared/operations-ipc";
import type { SkillBindingEffect, SkillEffectStep } from "../../shared/skill-management-ipc";

function restoreAssignmentEffects(receipt: OperationReceipt): readonly SkillBindingEffect[] | undefined {
  const effects = receipt.bindings ?? [];
  if (receipt.kind === "remove-binding") {
    const restored = effects.map((effect) => {
      const binding = effect.before ?? effect.binding;
      return binding ? { bindingId: effect.bindingId, after: binding } : undefined;
    });
    return restored.every((effect) => effect !== undefined) ? (restored as SkillBindingEffect[]) : undefined;
  }
  if (!effects.length || effects.some((effect) => !effect.after)) return undefined;
  return effects.map((effect) => ({
    bindingId: effect.bindingId,
    before: effect.after!,
    ...(effect.before ? { after: effect.before } : {}),
  }));
}

export function assignmentRestoreStep(
  receipt: OperationReceipt,
  planId: string,
  restoreFiles: readonly Readonly<{ relativePath: string; action: "delete" | "restore" }>[],
): SkillEffectStep | undefined {
  const projectId = receipt.project?.id;
  const bindingEffects = restoreAssignmentEffects(receipt);
  if (!projectId || !receipt.files || !bindingEffects || (!receipt.files.length && receipt.kind !== "remove-binding"))
    return undefined;
  const byPath = new Map(receipt.files.map((file) => [file.relativePath, file]));
  const files: SkillEffectStep["files"] = restoreFiles.map((file) => {
    const original = byPath.get(file.relativePath);
    if (!original) throw new Error("The restore preview contains a file outside the assignment receipt.");
    if (receipt.kind === "remove-binding")
      return { rootId: projectId, relativePath: file.relativePath, change: "add", afterHash: original.contentHash };
    return {
      rootId: projectId,
      relativePath: file.relativePath,
      change: file.action === "delete" ? "delete" : original.previousHash ? "change" : "add",
      beforeHash: original.contentHash,
      ...(original.previousHash ? { afterHash: original.previousHash } : {}),
    };
  });
  const firstBinding = bindingEffects[0]?.before ?? bindingEffects[0]?.after;
  if (!firstBinding) return undefined;
  const scope = {
    sourceId: firstBinding.sourceId,
    packageId: firstBinding.packageId,
    artifactPath: firstBinding.artifactPath,
    targets: bindingEffects.flatMap((effect) => {
      const binding = effect.before ?? effect.after;
      return binding ? [{ projectId, harnessId: binding.harnessId, bindingId: binding.bindingId }] : [];
    }),
  };
  const plan: OperationPlan = {
    planId,
    kind: "restore-apply",
    displayTarget: receipt.displayTarget,
    actions: restoreFiles.map((file) => {
      const original = byPath.get(file.relativePath)!;
      if (receipt.kind === "remove-binding")
        return { kind: "write-file" as const, relativePath: file.relativePath, afterHash: original.contentHash };
      return {
        kind: file.action === "delete" ? ("delete-file" as const) : ("write-file" as const),
        relativePath: file.relativePath,
        beforeHash: original.contentHash,
        ...(original.previousHash ? { afterHash: original.previousHash } : {}),
      };
    }),
    git: { mode: "unavailable", warnings: [] },
  };
  return { stepId: planId, scope, plan, bindingEffects, files };
}
