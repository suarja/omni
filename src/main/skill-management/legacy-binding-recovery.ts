import { randomUUID } from "node:crypto";
import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillOperationJournalRecord } from "../../application/skill-management-journal";
import { skillLocationIdentity } from "../../domain/skill-reconciliation/legacy-binding-bridge";
import type { SkillUseEffect } from "../../domain/skill-reconciliation/types";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { OperationStore } from "../operation-store";
import { persistLegacyBridgeReceipt } from "./legacy-binding-bridge";

type RestorePlan = Readonly<{ original: OperationReceipt; effects: readonly SkillUseEffect[] }>;

export function createLegacyBindingRecovery(
  args: Readonly<{ relationships: SkillRelationshipStore; operationStore: OperationStore; now?: () => number }>,
): Readonly<{
  preview(
    original: OperationReceipt,
    intentId: string,
    interrupted?: SkillOperationJournalRecord,
  ): Promise<SkillEffectBuild>;
  has(planId: string): boolean;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress: SkillStepProgress): Promise<SkillEffectOutcome>;
}> {
  const plans = new Map<string, RestorePlan>();
  const saved = (planId: string): RestorePlan => {
    const plan = plans.get(planId);
    if (!plan) throw new Error("Legacy bridge restore expired; preview its receipt again.");
    return plan;
  };
  const verify = async (plan: RestorePlan): Promise<void> => {
    const loaded = await args.relationships.read();
    const history = await args.operationStore.read();
    if (
      loaded.status !== "ready" ||
      history.status !== "ready" ||
      !history.receipts.some((receipt) => JSON.stringify(receipt) === JSON.stringify(plan.original))
    )
      throw new Error("Legacy bridge restore history changed; refresh its receipt before applying.");
    for (const effect of plan.effects) {
      const actual = loaded.state.uses.find(
        ({ location }) => skillLocationIdentity(location) === skillLocationIdentity(effect.location),
      );
      if (JSON.stringify(actual) !== JSON.stringify(effect.before))
        throw new Error(
          `Managed copy changed at ${skillLocationIdentity(effect.location)}; inspect the copy and refresh restore.`,
        );
    }
  };
  return {
    has: (planId) => plans.has(planId),
    async preview(original, intentId, interrupted): Promise<SkillEffectBuild> {
      try {
        if (
          !original.legacyBridge ||
          original.legacyBridge.phase === "abandoned" ||
          (original.restored && !interrupted)
        )
          throw new Error("The legacy bridge receipt is unavailable or already restored.");
        const loaded = await args.relationships.read();
        if (loaded.status !== "ready")
          throw new Error("Skill relationships are unavailable; inspect the store before restoring.");
        const effects = original.legacyBridge.uses.flatMap((use): SkillUseEffect[] => {
          const actual = loaded.state.uses.find(
            ({ location }) => skillLocationIdentity(location) === skillLocationIdentity(use.location),
          );
          if (
            JSON.stringify(actual) !== JSON.stringify(use) &&
            (actual || (!interrupted && original.legacyBridge!.phase === "applied"))
          )
            throw new Error(
              `Managed copy changed at ${skillLocationIdentity(use.location)}; restore cannot remove later metadata.`,
            );
          return actual ? [{ skillId: use.skillId, location: use.location, before: actual }] : [];
        });
        const planId = randomUUID();
        const scope = {
          targets: original.legacyBridge.uses.map((use) => ({
            projectId: use.location.projectId,
            harnessId: use.location.harnessId,
            bindingId: use.bindingId,
          })),
        };
        const step = {
          stepId: randomUUID(),
          scope,
          files: [],
          bindingEffects: [],
          metadataEffects: effects,
          plan: {
            planId,
            kind: "bridge-skill-uses" as const,
            displayTarget: `Restore ${original.displayTarget}`,
            actions: [],
            git: { mode: "unavailable" as const, warnings: [] },
          },
        };
        plans.set(planId, { original, effects });
        return {
          status: "ready",
          planId,
          scope,
          steps: [step],
          fingerprint: { scope, files: [], bindings: [], metadataEffects: effects },
          backupReferences: [],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Legacy bridge restore is unavailable.";
        return {
          status: "blocked",
          reason: message,
          details: [{ code: "legacy-bridge-restore-unavailable", message, recoveryAction: "inspect-recovery" }],
        };
      }
    },
    async prepare(_intentId, effect): Promise<void> {
      await verify(saved(effect.planId));
    },
    async apply(_intentId, effect, progress): Promise<SkillEffectOutcome> {
      const plan = saved(effect.planId);
      await verify(plan);
      const step = effect.steps[0]!;
      await progress({ stepId: step.stepId, status: "applying" });
      const effects = plan.effects.filter(({ before }) => before);
      const changed = await args.relationships.updateUsesExact(undefined, effects);
      if (changed.status !== "saved")
        throw new Error("Legacy bridge restore could not remove exact uses; inspect its recovery record.");
      await progress({ stepId: step.stepId, status: "verifying" });
      const receipt: OperationReceipt = {
        operationId: step.stepId,
        kind: "restore-apply",
        status: "applied",
        appliedAt: new Date((args.now ?? Date.now)()).toISOString(),
        displayTarget: step.plan.displayTarget,
        actions: [],
        git: { mode: "unavailable" },
        registered: null,
        restores: plan.original.operationId,
      };
      await persistLegacyBridgeReceipt(args.operationStore, receipt);
      const marked = await args.operationStore.markRestored(plan.original.operationId);
      if (
        marked.status !== "ready" ||
        !marked.receipts.some(({ operationId, restored }) => operationId === plan.original.operationId && restored)
      )
        throw new Error(
          "Legacy bridge uses were removed but its receipt could not be marked restored; inspect recovery.",
        );
      return {
        status: "restored",
        source: { status: "unchanged" },
        targets: plan.original.legacyBridge!.uses.map((use) => ({
          projectId: use.location.projectId,
          harnessId: use.location.harnessId,
          bindingId: use.bindingId,
          artifactPath: use.source.artifactPath,
          status: "restored",
        })),
        receiptIds: [receipt.operationId],
        receipts: [receipt],
        issues: [],
        recoveryAvailable: false,
      };
    },
  };
}
