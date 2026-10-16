import { planSkillDetachment, type SkillDetachmentPlan } from "../../domain/skill-reconciliation/detachment";
import type { SkillEffectFingerprint } from "../../domain/skill-management-intent";
import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillStepProgress,
  SkillEffectOutcome,
} from "../../application/skill-management";
import type { SkillEffectStep, SkillIntent, SkillIssue } from "../../shared/skill-management-ipc";
import type { SkillDetachmentRequest } from "../../shared/skill-detachment-request";
import type { SkillDetachmentApplicationDependencies } from "./detachment-application";
import { applySkillDetachment } from "./detachment-application";
import { readSkillDetachmentSnapshot, type SkillDetachmentSnapshot } from "./detachment-reader";
import type { SkillDetachmentReaderDependencies } from "./detachment-reader";

type DetachmentIntent = Extract<SkillIntent, { kind: "reconcile" }> & Readonly<{ request: SkillDetachmentRequest }>;
type ReadySnapshot = Extract<SkillDetachmentSnapshot, { status: "ready" }>;
type ReadyPlan = Extract<SkillDetachmentPlan, { status: "ready" }>;

function issue(code: string, message: string, recoveryAction: SkillIssue["recoveryAction"]): SkillIssue {
  return { code, message, recoveryAction };
}

function blocked(snapshot: Extract<SkillDetachmentSnapshot, { status: "blocked" | "needs-input" }>): SkillEffectBuild {
  return {
    status: snapshot.status,
    reason: snapshot.message,
    details: [
      issue(snapshot.code, snapshot.message, snapshot.status === "needs-input" ? "choose-targets" : "reconnect"),
    ],
  };
}

function plan(snapshot: ReadySnapshot, intentId: string): SkillDetachmentPlan {
  return planSkillDetachment({
    request: snapshot.request,
    record: snapshot.record,
    storeRevision: snapshot.relationships.revision,
    local: {
      location: snapshot.request.locations[0]!,
      rootIdentity: snapshot.rootIdentity,
      revision: snapshot.localTree.revision,
      envelope: snapshot.envelope,
    },
    use: snapshot.use,
    binding: snapshot.binding,
    base: snapshot.base,
    bindings: snapshot.bindings,
    uses: snapshot.relationships.uses,
    intentId,
  });
}

function makeDraft(planned: ReadyPlan): SkillEffectDraft {
  const step: SkillEffectStep = {
    stepId: planned.stepId,
    scope: planned.scope,
    plan: {
      planId: planned.stepId,
      kind: "detach-skill",
      displayTarget: planned.evidence.local.location.folderPath,
      actions: [],
      git: { mode: "unavailable", warnings: [] },
    },
    bindingEffects: planned.bindingEffects,
    files: [],
    metadataEffects: planned.metadataEffects,
    detachmentEvidence: planned.evidence,
  };
  const fingerprint: SkillEffectFingerprint = planned.fingerprint;
  return {
    status: "ready",
    planId: planned.stepId,
    scope: planned.scope,
    steps: [step],
    fingerprint,
    backupReferences: [],
  };
}

function savedStep(effect: SkillEffectDraft): SkillEffectStep {
  const step = effect.steps[0];
  if (
    effect.steps.length !== 1 ||
    !step ||
    step.plan.kind !== "detach-skill" ||
    step.plan.actions.length !== 0 ||
    step.files.length !== 0 ||
    !step.detachmentEvidence
  ) {
    throw new Error("The saved stop-management effect is invalid.");
  }
  return step;
}

function matchesSaved(
  snapshot: ReadySnapshot,
  intentId: string,
  request: SkillDetachmentRequest,
  step: SkillEffectStep,
): boolean {
  const evidence = step.detachmentEvidence;
  if (!evidence || step.stepId !== step.plan.planId) return false;
  const planned = planSkillDetachment({
    request,
    record: snapshot.record,
    storeRevision: snapshot.relationships.revision,
    local: {
      location: request.locations[0]!,
      rootIdentity: snapshot.rootIdentity,
      revision: snapshot.localTree.revision,
      envelope: snapshot.envelope,
    },
    use: snapshot.use,
    binding: snapshot.binding,
    base: snapshot.base,
    bindings: snapshot.bindings,
    uses: snapshot.relationships.uses,
    intentId,
  });
  return (
    planned.status === "ready" &&
    planned.stepId === step.stepId &&
    JSON.stringify(planned.evidence) === JSON.stringify(evidence) &&
    JSON.stringify(planned.bindingEffects) === JSON.stringify(step.bindingEffects) &&
    JSON.stringify(planned.metadataEffects) === JSON.stringify(step.metadataEffects)
  );
}

export function createSkillDetachmentAdapter(args: SkillDetachmentApplicationDependencies): Readonly<{
  preview(intent: DetachmentIntent, intentId: string): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress: SkillStepProgress): Promise<SkillEffectOutcome>;
  has(planId: string): boolean;
}> {
  const active = new Set<string>();
  const reader: SkillDetachmentReaderDependencies = {
    registry: args.registry,
    relationships: args.relationships,
    bindings: args.bindings,
    bases: args.bases,
    ...(args.filesystem ? { filesystem: args.filesystem } : {}),
    ...(args.now ? { now: args.now } : {}),
  };
  const preview = async (intent: DetachmentIntent, intentId: string): Promise<SkillEffectBuild> => {
    const snapshot = await readSkillDetachmentSnapshot(intent.request, reader);
    if (snapshot.status !== "ready") return blocked(snapshot);
    const planned = plan(snapshot, intentId);
    if (planned.status !== "ready")
      return {
        status: planned.status,
        reason: planned.reason,
        details: [
          issue(planned.code, planned.reason, planned.status === "needs-input" ? "choose-targets" : "open-changes"),
        ],
      };
    const draft = makeDraft(planned);
    active.add(draft.planId);
    return draft;
  };
  const prepare = async (intentId: string, effect: SkillEffectDraft): Promise<void> => {
    const step = savedStep(effect);
    const request = {
      choice: "detach-managed",
      skillId: step.detachmentEvidence!.skillId,
      locations: [step.detachmentEvidence!.local.location],
    } as const;
    const snapshot = await readSkillDetachmentSnapshot(request, reader);
    if (snapshot.status !== "ready" || !matchesSaved(snapshot, intentId, request, step))
      throw new Error("The approved project copy or metadata changed before stop-management preparation.");
  };
  const apply = async (
    intentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome> => {
    active.delete(effect.planId);
    savedStep(effect);
    return applySkillDetachment(intentId, effect, progress, args);
  };
  return { preview, prepare, apply, has: (planId) => active.has(planId) };
}
