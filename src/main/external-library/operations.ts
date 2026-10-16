import { serializeExternalProjectWrites } from "./project-write-queue";
import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillActor, SkillAuthorization, SkillEffectStep, SkillIssue } from "../../shared/skill-management-ipc";
import type { ExternalSkillIntent } from "../../shared/external-skill-intents";
import { readRegularFile, writeAtomically } from "../operation-files";
import { planExternalRestoration, completeExternalRecovery } from "./operation-recovery";
import { buildExternalSkillDraft } from "./operation-draft";
import { planExternalSkillTargets } from "./operation-planning";
import {
  readExternalBackup,
  rollbackExternalTarget,
  validateExternalTarget,
  writeExternalTarget,
} from "./operation-files";
import { type ExternalOperationDependencies, type ExternalTargetPlan } from "./operation-types";

function blocked(error: unknown): SkillEffectBuild {
  const message =
    error instanceof Error ? error.message : "The external skill operation is unavailable. Refresh its preview.";
  return {
    status: "blocked",
    reason: message,
    details: [{ code: "external-operation-unavailable", message, recoveryAction: "refresh" }],
  };
}
function targetIssue(error: unknown, recovery: boolean): SkillIssue {
  return {
    code: recovery ? "external-recovery-required" : "external-target-refused",
    message: error instanceof Error ? error.message : "The external target failed.",
    recoveryAction: recovery ? "inspect-recovery" : "refresh",
  };
}
export type ExternalSkillOperations = Readonly<{
  preview(intent: ExternalSkillIntent, intentId: string): Promise<SkillEffectBuild>;
  previewRestore(operationId: string, intentId: string): Promise<SkillEffectBuild | undefined>;
  has(planId: string): boolean;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(
    intentId: string,
    effect: SkillEffectDraft,
    actor: SkillActor,
    authorization: SkillAuthorization,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome>;
}>;
export function createExternalSkillOperations(args: ExternalOperationDependencies): ExternalSkillOperations {
  const plans = new Map<string, readonly ExternalTargetPlan[]>(),
    originals = new Map<string, string>();
  const save = (targets: readonly ExternalTargetPlan[]): SkillEffectDraft => {
    const draft = buildExternalSkillDraft(targets);
    plans.set(draft.planId, targets);
    return draft;
  };
  return {
    has: (planId) => plans.has(planId),
    preview: async (intent, intentId) => {
      try {
        return save(await planExternalSkillTargets(args, intent, intentId));
      } catch (error) {
        return blocked(error);
      }
    },
    previewRestore: async (operationId, intentId) => {
      try {
        const targets = await planExternalRestoration(args, operationId, intentId);
        if (!targets) return undefined;
        const draft = save(targets);
        originals.set(draft.planId, operationId);
        return draft;
      } catch (error) {
        return blocked(error);
      }
    },
    prepare: async (_intentId, effect) => {
      for (const plan of plans.get(effect.planId) ?? []) {
        const current = await readRegularFile(args.userDataPath, plan.backup.evidence.backupPath);
        if (current && Buffer.from(current).toString("utf8") !== plan.bytes)
          throw new Error("The external operation backup path is occupied. Inspect recovery.");
        await writeAtomically(args.userDataPath, plan.backup.evidence.backupPath, plan.bytes);
      }
    },
    apply: async (intentId, effect, actor, authorization, progress) => {
      const selected = plans.get(effect.planId);
      if (!selected) throw new Error("The external operation preview expired. Refresh it.");
      return serializeExternalProjectWrites(
        args.userDataPath,
        selected.map((plan) => plan.backup.evidence.projectId),
        async () => {
          const receipts: NonNullable<SkillEffectOutcome["receipts"]>[number][] = [],
            targets: SkillEffectOutcome["targets"][number][] = [],
            issues: SkillIssue[] = [];
          let recovery = false;
          for (let index = 0; index < selected.length; index++) {
            const plan = selected[index]!,
              step = effect.steps[index]!,
              evidence = plan.backup.evidence;
            let grant: Awaited<ReturnType<typeof validateExternalTarget>> | undefined,
              mutated = false,
              recorded = false;
            try {
              await progress({ stepId: step.stepId, status: "applying" });
              await readExternalBackup(args, evidence);
              grant = await validateExternalTarget(args, plan);
              await writeExternalTarget(args, grant, plan, () => {
                mutated = true;
              });
              const receipt = {
                operationId: step.stepId,
                kind: evidence.kind,
                status: "applied" as const,
                appliedAt: new Date((args.now ?? Date.now)()).toISOString(),
                displayTarget: step.plan.displayTarget,
                actions: step.plan.actions.map((action) => ({ ...action, status: "applied" as const })),
                git: { mode: "disabled" as const },
                registered: null,
                project: { id: evidence.projectId },
                externalSkill: evidence,
                ...(evidence.restores ? { restores: evidence.restores } : {}),
                ...(actor.kind === "desktop" && actor.automatic
                  ? { provenance: { approval: "automatic" as const, reason: "automatique" } }
                  : {}),
              };
              if (actor.kind === "mcp" && authorization.kind === "agent")
                Object.assign(receipt, {
                  provenance: {
                    approval: authorization.approval ?? "conversation",
                    ...(actor.harness
                      ? {
                          agent: {
                            harness: actor.harness,
                            ...(actor.sessionName ? { sessionName: actor.sessionName } : {}),
                            requestedAt: authorization.approvedAt,
                          },
                        }
                      : {}),
                  },
                });
              if ((await args.operationStore.append(receipt)).status !== "ready")
                throw new Error("The external operation receipt could not be saved. Inspect recovery.");
              recorded = true;
              receipts.push(receipt);
              if (evidence.restores && (await args.operationStore.markRestored(evidence.restores)).status !== "ready")
                throw new Error("The original external receipt could not be marked restored.");
              await progress({ stepId: step.stepId, status: "applied", receiptId: receipt.operationId });
              targets.push(...outcomes(step, evidence.direction === "restore" ? "restored" : "applied"));
            } catch (error) {
              const rolledBack =
                !recorded && (!mutated || (grant && (await rollbackExternalTarget(args, grant, plan))));
              const failedRecovery = !rolledBack;
              recovery ||= failedRecovery;
              const issue = targetIssue(error, failedRecovery);
              issues.push(issue);
              targets.push(...outcomes(step, failedRecovery ? "unknown" : "failed", issue));
              await progress({ stepId: step.stepId, status: failedRecovery ? "recovery-required" : "failed" }).catch(
                () => undefined,
              );
            }
          }
          const originalId = originals.get(effect.planId);
          if (originalId && !issues.length && (await args.operationStore.markRestored(originalId)).status !== "ready") {
            issues.push(targetIssue(new Error("The aggregate external receipt could not be marked restored."), true));
            recovery = true;
          }
          if (originalId && !issues.length) await completeExternalRecovery(args, originalId);
          await args.library.refreshCopies().catch((error) => issues.push(targetIssue(error, false)));
          return {
            status: recovery
              ? "recovery-required"
              : issues.length
                ? receipts.length
                  ? "partial"
                  : "failed"
                : originalId
                  ? "restored"
                  : "applied",
            source: { status: "unchanged" },
            targets,
            receiptIds: receipts.map((receipt) => receipt.operationId),
            receipts,
            issues,
            recoveryAvailable: recovery,
          };
        },
      );
    },
  };
}
function outcomes(
  step: SkillEffectStep,
  status: SkillEffectOutcome["targets"][number]["status"],
  issue?: SkillIssue,
): SkillEffectOutcome["targets"] {
  return step.scope.targets.map((target) => ({
    projectId: target.projectId,
    harnessId: target.harnessId,
    bindingId: step.stepId + "-" + target.harnessId,
    artifactPath: step.externalSkillEvidence!.layouts.find((layout) => layout.harnessId === target.harnessId)!.path,
    status,
    ...(issue ? { issue } : {}),
  }));
}
