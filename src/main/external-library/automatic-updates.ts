import type { SkillManagementService } from "../../application/skill-management";
import type { ExternalPass, ExternalUse, ExternalAutomaticFailure } from "../../shared/external-library-ipc";
import type { SkillResult } from "../../shared/skill-management-ipc";
import type { ExternalLibraryObservation } from "./reader";
import { skipsAutomaticFailure, type ExternalAutomaticFailures } from "./automatic-failures";

export async function applyAutomaticExternalUpdates(
  service: SkillManagementService,
  observation: ExternalLibraryObservation,
  failures: ExternalAutomaticFailures,
  now: () => number = Date.now,
): Promise<{
  updates: NonNullable<ExternalPass["updates"]>;
  diagnostics: ExternalPass["diagnostics"];
}> {
  const updates: NonNullable<ExternalPass["updates"]> = [],
    diagnostics: ExternalPass["diagnostics"] = [];
  for (const source of observation.sources) {
    const head = source.source?.head?.commit;
    if (!source.source || !head) continue;
    const uses = source.uses.filter(
      (use) => use.state === "update" && use.copyHash && !skipsAutomaticFailure(use, head),
    );
    const useIds = uses.map((use) => use.id);
    if (!useIds.length) continue;
    try {
      const preview = await service.preview(
        { kind: "update-external-skills", sourceId: source.source.id, useIds },
        { kind: "desktop", automatic: true },
      );
      if (preview.status !== "ready") throw new Error(preview.reason);
      const result = await service.apply(preview.intentId, {
        kind: "desktop",
        effectFingerprint: preview.effectFingerprint,
        approvedAt: new Date().toISOString(),
      });
      const failedTargets = await recordAutomaticOutcome(failures, uses, head, result, now);
      updates.push({
        sourceId: source.source.id,
        operationId: result.operationId,
        copiesUpdated: (result.receipts ?? []).reduce(
          (total, receipt) => total + (receipt.externalSkill?.copies ?? 0),
          0,
        ),
        failedTargets,
      });
      diagnostics.push(
        ...result.issues.map((issue) => ({
          type: "other" as const,
          message: `${source.source!.id}: ${failureReason(issue.message)}`.slice(0, 1000),
        })),
      );
    } catch (error) {
      const reason = failureReason(error instanceof Error ? error.message : "Automatic external updates failed.");
      await failures.record(
        uses.map((use) => ({
          useId: use.id,
          failure: makeFailure(use, head, reason, now),
        })),
      );
      updates.push({
        sourceId: source.source.id,
        copiesUpdated: 0,
        failedTargets: new Set(source.uses.filter((use) => useIds.includes(use.id)).map((use) => use.projectId)).size,
      });
      diagnostics.push({
        type: "other",
        message: `${source.source.id}: ${reason}`.slice(0, 1000),
      });
    }
  }
  return { updates, diagnostics };
}
async function recordAutomaticOutcome(
  failures: ExternalAutomaticFailures,
  uses: readonly ExternalUse[],
  head: string,
  result: SkillResult,
  now: () => number,
): Promise<number> {
  const failedProjects = new Set<string>();
  await failures.record(
    uses.map((use) => {
      const targets = result.targets.filter((target) => target.projectId === use.projectId);
      const failed = targets.find((target) => !["applied", "no-op"].includes(target.status));
      if (targets.length && !failed) return { useId: use.id };
      failedProjects.add(use.projectId);
      const reason = failed?.issue?.message ?? result.issues[0]?.message ?? "Automatic external updates failed.";
      return { useId: use.id, failure: { ...makeFailure(use, head, reason, now), operationId: result.operationId } };
    }),
  );
  return failedProjects.size;
}
function makeFailure(
  use: ExternalUse,
  sourceHead: string,
  reason: string,
  now: () => number,
): ExternalAutomaticFailure {
  return {
    sourceHead,
    copyHash: use.copyHash!,
    failedAt: new Date(now()).toISOString(),
    reason: failureReason(reason),
  };
}
function failureReason(reason: string): string {
  return reason.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 4096);
}
