import type { SkillEffectBuild, SkillManagementService } from "../../application/skill-management";
import type { SkillJournalRead } from "../../application/skill-management-journal";
import type { OperationStore } from "../operation-store";
import type { createLegacyBindingBridge } from "./legacy-binding-bridge";
import type { createLegacyBindingRecovery } from "./legacy-binding-recovery";
import type { createSkillPropagationAdapter } from "./propagation-composition";
import { blockedRestore } from "./unbound-service-routes";

export async function previewInterruptedLegacyBridgeRestore(
  read: SkillJournalRead,
  store: OperationStore,
  recovery: ReturnType<typeof createLegacyBindingRecovery> | undefined,
  intentId: string,
): Promise<SkillEffectBuild | undefined> {
  if (
    read.status !== "ready" ||
    read.record.status !== "recovery-required" ||
    read.record.intent.kind !== "restore" ||
    !read.record.effect?.steps.some(({ plan }) => plan.kind === "bridge-skill-uses")
  )
    return undefined;
  const history = await store.read();
  const originalId = read.record.intent.operationId;
  const original =
    history.status === "ready" ? history.receipts.find(({ operationId }) => operationId === originalId) : undefined;
  return original && recovery
    ? recovery.preview(original, intentId, read.record)
    : blockedRestore(
        "Legacy bridge recovery is unavailable.",
        "legacy-bridge-recovery-unavailable",
        "Inspect the original bridge receipt and refresh recovery.",
      );
}

export function withLegacyBindingBridge(
  service: SkillManagementService,
  bridge: ReturnType<typeof createLegacyBindingBridge> | undefined,
  propagation?: Pick<ReturnType<typeof createSkillPropagationAdapter>, "readCandidates">,
  completion?: ReturnType<typeof import("./project-skill-assignment").createProjectSkillAssignmentCompletion>,
): SkillManagementService {
  const forgottenBindings = new Set<string>();
  return {
    ...service,
    readLegacyBridgeDiagnostic: () => {
      const diagnostic = bridge?.readDiagnostic();
      return (
        diagnostic && {
          ...diagnostic,
          skippedLocations: diagnostic.skippedLocations
            .map((location) => ({
              ...location,
              bindingIds: location.bindingIds.filter((id) => !forgottenBindings.has(id)),
            }))
            .filter((location) => location.bindingIds.length > 0),
        }
      );
    },
    async initialize(): Promise<void> {
      await service.initialize();
      await bridge?.run();
      await completion?.reconcileAssignmentBridges();
    },
    async apply(intentId, authorization): ReturnType<SkillManagementService["apply"]> {
      const result = await service.apply(intentId, authorization);
      // Completed binding-only effects update the cached diagnostic without rescanning or bridging peer uses.
      for (const receipt of result.receipts ?? []) {
        if (receipt.status !== "applied" || receipt.files?.length !== 0) continue;
        if (receipt.kind === "remove-binding")
          for (const effect of receipt.bindings ?? []) forgottenBindings.add(effect.bindingId);
        if (receipt.kind === "restore-apply")
          for (const target of result.targets)
            if (target.status === "restored" && target.bindingId) forgottenBindings.delete(target.bindingId);
      }
      if (result.status === "applied" && result.receipts?.some(({ kind }) => kind === "apply-plan")) {
        await bridge?.run(await completion?.assignmentBindingIds(result));
        return completion ? completion.recordAssignmentBridge(result) : result;
      }
      return result;
    },
    readPropagationCandidates(source): ReturnType<NonNullable<SkillManagementService["readPropagationCandidates"]>> {
      if (!propagation) throw new Error("Skill propagation is unavailable in this session.");
      return propagation.readCandidates(source);
    },
  };
}
