import { activeWorkshop } from "../../domain/source-roles";
import type { AgentPlan, StoredAgentWriteRequest, ApprovalReason } from "../../shared/agents-ipc";
import type { SkillIntent, SkillPreview } from "../../shared/skill-management-ipc";
import type { ApprovalMode, Settings } from "../../shared/settings-ipc";
import type { RegistryIpcServices } from "../registry-ipc";

export type ApprovalResolution = Readonly<{ mode: ApprovalMode; reason?: ApprovalReason }>;
type ApprovalEffects = Readonly<{
  sourceId?: string;
  publicPublication?: boolean;
  writesMarketplace: boolean;
  projectsTouched: boolean;
  deletionCount: number;
  hasConflict: boolean;
}>;
type ApprovalInput = ApprovalEffects &
  Readonly<{
    registry: Pick<RegistryIpcServices, "listRegistry">;
    settings: Settings;
    askInOmni?: boolean;
  }>;

type ReadyPreview = Extract<SkillPreview, { status: "ready" }>;

function countDeletions(plans: readonly AgentPlan[]): number {
  return plans.reduce(
    (total, plan) =>
      total +
      (plan.kind === "assign"
        ? 0
        : plan.actions.filter((action) => action.kind === "delete-file" || action.kind === "delete-directory").length),
    0,
  );
}

export function deriveApprovalInput(
  operation: StoredAgentWriteRequest | SkillIntent,
  evidence: AgentPlan | ReadyPreview,
): ApprovalEffects {
  const preview = "status" in evidence ? evidence : undefined;
  const plans: readonly AgentPlan[] = "status" in evidence ? evidence.steps.map((step) => step.plan) : [evidence];
  const sourceWrite =
    operation.kind === "write" || operation.kind === "update-and-maintain"
      ? operation.request
      : operation.kind === "write-skill"
        ? operation
        : undefined;
  const legacyWrite = operation.kind === "import-artifact" || operation.kind === "make-compatible";
  const sourceSteps = preview?.steps.filter((step) => step.scope.sourceId && step.scope.targets.length === 0) ?? [];
  const writesMarketplace =
    legacyWrite ||
    sourceWrite !== undefined ||
    ((operation.kind === "restore" || operation.kind === "restore-skill" || operation.kind === "reconcile") &&
      sourceSteps.length > 0);
  const sourceId =
    sourceWrite?.sourceId ?? (operation.kind === "make-compatible" ? operation.sourceId : preview?.scope.sourceId);
  const projectsTouched =
    operation.kind === "register-project" ||
    operation.kind === "assign" ||
    operation.kind === "remove" ||
    operation.kind === "remove-skill" ||
    (preview?.scope.targets.length ?? 0) > 0 ||
    plans.some((plan) => plan.kind === "assign");
  // Target propagation and explicit removal/restore already express the user's deletion intent.
  const replacementPlans =
    sourceWrite?.mode === "update" && sourceWrite.replaceFolder
      ? preview
        ? sourceSteps.filter((step) => step.plan.kind === "write-skill").map((step) => step.plan)
        : plans
      : [];
  return {
    ...(operation.kind === "publish-plugin" ? { publicPublication: true } : {}),
    ...(sourceId ? { sourceId } : {}),
    writesMarketplace,
    projectsTouched,
    deletionCount:
      operation.kind === "project-skill" &&
      operation.action === "delete" &&
      preview?.steps.some((step) => step.projectSkillEvidence?.origin === "project-only")
        ? Math.max(1, countDeletions(plans))
        : countDeletions(legacyWrite ? plans : replacementPlans),
    hasConflict:
      (operation.kind === "install-external-skill" &&
        operation.conflict === "replace" &&
        Boolean(
          preview?.steps.some((step) => step.externalSkillEvidence?.layouts.some((layout) => layout.beforeHash)),
        )) ||
      plans.some(
        (plan) =>
          plan.kind === "assign" &&
          plan.plans.some(
            (project) => project.status === "conflict" || project.actions.some((action) => action.state === "conflict"),
          ),
      ),
  };
}

export async function resolveApproval(input: ApprovalInput): Promise<ApprovalResolution> {
  const omni = (reason: ApprovalReason): ApprovalResolution => ({ mode: "omni", reason });
  if (input.publicPublication) return omni({ code: "public-publication" });
  if (input.askInOmni) return omni({ code: "asked-in-omni" });
  // An unreadable registry cannot establish ownership, even if the plan itself is ready.
  const registry = await input.registry.listRegistry?.().catch(() => undefined);
  if (registry?.status !== "ready") return omni({ code: "registry-unavailable" });
  // Content written to, or installed from, a marketplace the owner does not own needs Desktop approval.
  if (input.writesMarketplace || input.sourceId) {
    const source = activeWorkshop(registry.registry);
    if (!source || (input.sourceId && source.ref.id !== input.sourceId)) return omni({ code: "not-owned-source" });
  }
  if (input.deletionCount) return omni({ code: "deletes-files", count: input.deletionCount });
  if (input.hasConflict) return omni({ code: "conflict" });
  if (input.projectsTouched && input.settings.agents.approval.projects === "omni")
    return omni({ code: "projects-setting" });
  if (input.writesMarketplace && input.settings.agents.approval.personalMarketplace === "omni")
    return omni({ code: "marketplace-setting" });
  return { mode: "conversation" };
}
