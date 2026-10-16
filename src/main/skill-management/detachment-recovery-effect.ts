import { createHash } from "node:crypto";
import type { SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillEffectDraft } from "../../application/skill-management";
import type { SkillEffectFingerprint } from "../../domain/skill-management-intent";
import type { SkillEffectStep } from "../../shared/skill-management-ipc";
import type { SkillDetachmentEvidence } from "../../shared/skill-detachment-effects";
import type { SkillDetachmentSavedStep as ReadyStep } from "./detachment-recovery-receipt";
import type { SkillDetachmentRecoveryDecision as Decision } from "./detachment-recovery-plan";

function stepIdFor(intentId: string, origin: SkillDetachmentEvidence): string {
  const suffix = createHash("sha256")
    .update(
      `${intentId}\n${origin.skillId}\n${origin.local.location.projectId}\n${origin.local.location.harnessId}\n${origin.local.location.folderPath}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return `restore-detach-${suffix}`;
}

export function buildSkillDetachmentRecoveryEffect(
  record: SkillOperationJournalRecord,
  step: ReadyStep,
  intentId: string,
  decision: Decision,
): SkillEffectDraft {
  const evidence = step.detachmentEvidence;
  if (decision.status === "blocked") throw new Error("Cannot build a blocked stop-management inverse.");
  const noOp = decision.status === "unchanged";
  const restoreBinding = decision.status === "restore" && decision.restoreBinding;
  const restoreUse = decision.status === "restore" && decision.restoreUse;
  const inverseStepId = stepIdFor(intentId, evidence);
  const origin = { intentId: record.intentId, stepId: step.stepId };
  const bindingEffect = restoreBinding
    ? { bindingId: evidence.binding.bindingId, after: evidence.binding }
    : { bindingId: evidence.binding.bindingId, before: evidence.binding, after: evidence.binding };
  const useEffect = restoreUse
    ? { skillId: evidence.skillId, location: evidence.local.location, after: evidence.use }
    : { skillId: evidence.skillId, location: evidence.local.location, before: evidence.use, after: evidence.use };
  const stepEffect: SkillEffectStep = {
    stepId: inverseStepId,
    scope: step.scope,
    plan: {
      planId: inverseStepId,
      kind: "detach-skill",
      displayTarget: evidence.local.location.folderPath,
      actions: [],
      git: { mode: "unavailable", warnings: [] },
    },
    bindingEffects: [bindingEffect],
    files: [],
    metadataEffects: [useEffect],
    detachmentEvidence: evidence,
    detachmentRestoreOrigin: origin,
  };
  const fingerprint: SkillEffectFingerprint = {
    scope: step.scope,
    files: [],
    bindings: [bindingEffect],
    actions: [],
    metadataEffects: [useEffect],
    detachmentEvidence: evidence,
    detachmentRestoreOrigin: origin,
  };
  return {
    status: "ready",
    planId: inverseStepId,
    scope: step.scope,
    steps: [stepEffect],
    fingerprint,
    backupReferences: [],
  };
}
