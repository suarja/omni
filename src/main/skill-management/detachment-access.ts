import type { SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillEffectBuild } from "../../application/skill-management";
import type { SkillActor, SkillAuthorization } from "../../shared/skill-management-ipc";
import { blockedRestore } from "./unbound-service-routes";
import type { createSkillDetachmentRecoveryAdapter } from "./detachment-recovery";

export function blockedDetachmentForMcp(actor: SkillActor): ReturnType<typeof blockedRestore> | undefined {
  if (actor.kind !== "mcp") return undefined;
  return blockedRestore(
    "Stop management and its inverse are desktop-only operations.",
    "detachment-local-only",
    "Open the desktop Changes review to stop or restore management for this copy.",
    "inspect-recovery",
  );
}

export function assertDesktopDetachmentAuthorization(
  record: SkillOperationJournalRecord,
  authorization: SkillAuthorization,
): void {
  const isDetachment =
    (record.intent.kind === "reconcile" && record.intent.request.choice === "detach-managed") ||
    (record.effect?.steps.some((step) => Boolean(step.detachmentEvidence)) ?? false);
  if (isDetachment && (record.actor.kind !== "desktop" || authorization.kind !== "desktop"))
    throw new Error("Stop management is a desktop-only operation.");
}

export function previewInterruptedDetachmentInverse(
  actor: SkillActor,
  record: SkillOperationJournalRecord,
  intentId: string,
  recovery: ReturnType<typeof createSkillDetachmentRecoveryAdapter> | undefined,
): Promise<SkillEffectBuild> | undefined {
  const interruptedInverse =
    record.intent.kind === "restore" &&
    record.status === "recovery-required" &&
    record.effect?.steps.some((step) => step.detachmentRestoreOrigin);
  if (!interruptedInverse) return undefined;
  const localOnly = blockedDetachmentForMcp(actor);
  if (localOnly) return Promise.resolve(localOnly);
  return recovery
    ? recovery.previewInverse(record, intentId)
    : Promise.resolve(
        blockedRestore(
          "Stop-management recovery is unavailable.",
          "detachment-recovery-unavailable",
          "Inspect the original management inverse and its saved progress.",
        ),
      );
}
