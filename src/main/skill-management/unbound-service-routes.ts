import { sourceReferenceRecovery } from "./source-observation";
import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillOperationJournal, SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillActor } from "../../shared/skill-management-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { SkillUnboundResolutionRequest } from "../../shared/skill-unbound-resolution-request";
import type { createSkillAdoptionAdapter } from "./adoption";
import type { createSkillAdoptionRecoveryAdapter } from "./adoption-recovery";
import { verifiedLinkCanonicalAdoptionStep } from "./adoption-receipt";
import type { createSkillUnboundResolutionAdapter } from "./unbound-resolution";
import { resolveSkillUnboundResolutionReceiptRecord } from "./unbound-receipt";

type AdoptionAdapter = ReturnType<typeof createSkillAdoptionAdapter>;
type AdoptionRecoveryAdapter = ReturnType<typeof createSkillAdoptionRecoveryAdapter>;
type UnboundAdapter = ReturnType<typeof createSkillUnboundResolutionAdapter>;

export function blockedRestore(
  reason: string,
  code: string,
  message: string,
  recoveryAction: "refresh" | "reconnect" | "inspect-recovery" = sourceReferenceRecovery(code),
): SkillEffectBuild {
  return { status: "blocked", reason, details: [{ code, message, recoveryAction }] };
}

export function previewUnboundLinkRecovery(
  args: Readonly<{
    record: SkillOperationJournalRecord;
    intentId: string;
    actor: SkillActor;
    adoptionRecovery?: AdoptionRecoveryAdapter;
    unboundResolution?: UnboundAdapter;
  }>,
): Promise<SkillEffectBuild> {
  if (args.actor.kind === "mcp")
    return Promise.resolve(
      blockedRestore(
        "Unbound resolution is a desktop-only operation.",
        "unbound-resolution-local-only",
        "Open the desktop Changes review to continue.",
        "inspect-recovery",
      ),
    );
  if (verifiedLinkCanonicalAdoptionStep(args.record)) {
    if (!args.adoptionRecovery)
      return Promise.resolve(
        blockedRestore(
          "Exact-copy adoption recovery is unavailable.",
          "adoption-recovery-unavailable",
          "Reconnect the selected source and project before restoring metadata.",
        ),
      );
    return args.adoptionRecovery.preview(args.record, args.intentId);
  }
  if (!args.unboundResolution)
    return Promise.resolve(
      blockedRestore(
        "Unbound linkage recovery is unavailable.",
        "unbound-recovery-unavailable",
        "Reconnect the selected project and inspect its saved recovery.",
      ),
    );
  return args.unboundResolution.previewRecovery(args.record, args.intentId);
}

export async function previewUnboundLinkReceiptRecovery(
  args: Readonly<{
    receipt: OperationReceipt;
    intentId: string;
    actor: SkillActor;
    journal: SkillOperationJournal;
    unboundResolution?: UnboundAdapter;
  }>,
): Promise<SkillEffectBuild> {
  const saved = args.receipt.link
    ? await args.journal.read(args.receipt.link.intentId)
    : { status: "missing" as const };
  const linked = saved.status === "ready" ? resolveSkillUnboundResolutionReceiptRecord(args.receipt, saved) : undefined;
  if (!linked || !args.unboundResolution)
    return blockedRestore(
      "The link receipt does not have a verified journal link.",
      "unbound-link-receipt-unavailable",
      "Inspect the original operation and saved project backup before restoring it.",
    );
  if (args.actor.kind === "mcp")
    return blockedRestore(
      "Unbound resolution restore is a desktop-only operation.",
      "unbound-resolution-local-only",
      "Open the desktop Changes review to restore this link.",
      "inspect-recovery",
    );
  return args.unboundResolution.previewRecovery(linked, args.intentId, args.receipt);
}

export async function applyUnboundLink(
  args: Readonly<{
    request: SkillUnboundResolutionRequest;
    intentId: string;
    effect: SkillEffectDraft;
    progress: SkillStepProgress;
    adoption?: AdoptionAdapter;
    unboundResolution?: UnboundAdapter;
  }>,
): Promise<SkillEffectOutcome> {
  const step = args.effect.steps[0];
  if (step?.plan.kind === "adopt-skill" && step.adoptionEvidence) {
    if (!args.adoption) throw new Error("The exact-copy adoption adapter is unavailable.");
    const outcome = await args.adoption.apply(args.intentId, args.effect, args.progress);
    const binding = step.bindingEffects[0]?.after;
    if (!binding) return outcome;
    return {
      ...outcome,
      link: {
        choice: "link-canonical",
        skillId: args.request.skillId,
        source: args.request.source,
        location: args.request.locations[0]!,
        bindingId: binding.bindingId,
        status: outcome.status === "applied" ? "applied" : outcome.status === "failed" ? "failed" : "unknown",
      },
    };
  }
  if (!args.unboundResolution) throw new Error("The unbound skill resolution adapter is unavailable.");
  return args.unboundResolution.apply(args.intentId, args.effect, args.progress);
}
