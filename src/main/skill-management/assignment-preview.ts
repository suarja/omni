import { createHash } from "node:crypto";
import type { Binding } from "../../domain/assignment-plan";
import type { ManagedSkillUse } from "../../domain/skill-reconciliation/types";
import { createUnifiedDiff } from "../../domain/unified-diff";
import type { SkillBindingEffect, SkillFileSummary } from "../../shared/skill-management-ipc";
import type { OperationPlan } from "../../shared/operations-ipc";
import type { ApplyPlan } from "../apply-engine";
import type { ManagedAssignmentPreview } from "../apply-ipc";
import { boundedDiff } from "../apply-ipc-helpers";
import { readRegularFile } from "../operation-files";
import { isManagedBinding } from "./legacy-binding-guard";

async function summarizeAssignmentFiles(plan: ApplyPlan): Promise<readonly SkillFileSummary[]> {
  const files: SkillFileSummary[] = [];
  for (const item of plan.actions)
    for (const file of item.unit.files) {
      const relativePath = file.relativePath
        ? `${item.action.relativePath}/${file.relativePath}`
        : item.action.relativePath;
      const beforeBytes = await readRegularFile(plan.projectRoot, relativePath);
      const beforeHash = beforeBytes ? createHash("sha256").update(beforeBytes).digest("hex") : undefined;
      const afterHash = file.contentHash;
      const unchanged = beforeHash === afterHash;
      const diff = !unchanged
        ? boundedDiff(
            createUnifiedDiff(
              `${relativePath} (${beforeBytes ? "current" : "absent"})`,
              `${relativePath} (proposed)`,
              beforeBytes ?? Buffer.alloc(0),
              Buffer.from(file.content),
            ).text,
          ).text
        : undefined;
      files.push({
        rootId: plan.projectId,
        relativePath,
        change: unchanged ? "unchanged" : beforeHash ? "change" : "add",
        byteLength: Buffer.byteLength(file.content, "utf8"),
        ...(diff ? { diff } : {}),
        ...(beforeHash ? { beforeHash } : {}),
        afterHash,
      });
    }
  return files;
}

function planAssignmentBindings(
  plan: ApplyPlan,
  bindings: readonly Binding[],
  uses: readonly ManagedSkillUse[],
): readonly SkillBindingEffect[] {
  return plan.actions.map((item) => {
    const before = bindings.find((candidate) => candidate.bindingId === item.binding.bindingId);
    const after =
      before && item.action.state === "current" && isManagedBinding(before, uses)
        ? before
        : { ...item.binding, boundHash: item.unit.unit.contentHash, ownedHash: item.unit.unit.contentHash };
    return { bindingId: item.binding.bindingId, ...(before ? { before } : {}), after };
  });
}

export async function buildManagedAssignmentPreview(
  plan: ApplyPlan,
  bindings: readonly Binding[],
  uses: readonly ManagedSkillUse[],
): Promise<ManagedAssignmentPreview> {
  const files = await summarizeAssignmentFiles(plan);
  const bindingEffects = planAssignmentBindings(plan, bindings, uses);
  const operationPlan: OperationPlan = {
    planId: plan.planId,
    kind: "apply-plan",
    displayTarget: plan.displayName,
    actions: files.map((file) => ({
      kind: "write-file",
      relativePath: file.relativePath,
      ...(file.byteLength === undefined ? {} : { byteLength: file.byteLength }),
      ...(file.beforeHash === undefined ? {} : { beforeHash: file.beforeHash }),
      ...(file.afterHash === undefined ? {} : { afterHash: file.afterHash }),
      ...(file.diff === undefined ? {} : { diff: file.diff }),
    })),
    git: { mode: plan.response.git.mode, warnings: [] },
  };
  const noOp =
    plan.actions.every((item) => item.action.state === "current" || item.action.state === "linked") &&
    bindingEffects.every((effect) => effect.before && JSON.stringify(effect.before) === JSON.stringify(effect.after)) &&
    files.every((file) => file.change === "unchanged");
  return { planId: plan.planId, plan: operationPlan, files, bindingEffects, noOp };
}
