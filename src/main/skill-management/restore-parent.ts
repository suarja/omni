import type { SkillOperationJournal } from "../../application/skill-management-journal";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { SkillResult } from "../../shared/skill-management-ipc";
import type { OperationStore } from "../operation-store";

export async function recordParentRestored(
  store: OperationStore,
  journal: SkillOperationJournal,
  operationId: string,
): Promise<SkillResult> {
  const history = await store.read();
  if (history.status !== "ready") throw new Error("The restored operation history is unavailable.");
  const parent = history.receipts.find((receipt) => receipt.operationId === operationId);
  if (!parent?.skillManagement) throw new Error("The restored parent summary is unavailable.");
  const children = (parent.children ?? []).flatMap(
    (id) => history.receipts.find((receipt) => receipt.operationId === id) ?? [],
  );
  const previous = parent.skillManagement;
  const restoredBindings = new Set(
    children
      .filter((child) => child.restored && child.skillPropagation)
      .map((child) => child.skillPropagation!.currentBinding.bindingId),
  );
  const propagation = previous.propagation
    ? {
        ...previous.propagation,
        targets: previous.propagation.targets.map((target) =>
          target.result === "applied" && target.bindingId && restoredBindings.has(target.bindingId)
            ? { ...target, result: "restored" as const }
            : target,
        ),
      }
    : undefined;
  const recoveryRequired = Boolean(propagation?.targets.some((target) => target.result === "unknown"));
  const restoredResolution: SkillResult["resolution"] =
    previous.resolution?.choice === "adopt-exact"
      ? {
          ...previous.resolution,
          targets: previous.resolution.targets.map((target) => ({ ...target, status: "restored" as const })),
        }
      : previous.resolution
        ? {
            ...previous.resolution,
            targets: [{ ...previous.resolution.targets[0], status: "restored" as const }],
          }
        : undefined;
  const restoredLink: SkillResult["link"] = previous.link ? { ...previous.link, status: "restored" } : undefined;
  const restoredDetachment: SkillResult["detachment"] = previous.detachment
    ? { ...previous.detachment, status: "restored" }
    : undefined;
  const summary: Omit<SkillResult, "receipts"> = {
    ...previous,
    status: recoveryRequired ? "recovery-required" : "restored",
    recoveryAvailable: recoveryRequired,
    source: ["created", "updated"].includes(previous.source.status)
      ? { ...previous.source, status: "restored" }
      : previous.source,
    targets: previous.targets.map((target) =>
      propagation
        ? target.status === "applied" && restoredBindings.has(target.bindingId)
          ? { ...target, status: "restored" }
          : target
        : ["applied", "removed", "unknown"].includes(target.status)
          ? { ...target, status: "restored" }
          : target,
    ),
    ...(propagation ? { propagation } : {}),
    ...(restoredResolution ? { resolution: restoredResolution } : {}),
    ...(restoredLink ? { link: restoredLink } : {}),
    ...(restoredDetachment ? { detachment: restoredDetachment } : {}),
    ...(previous.capture ? { capture: { ...previous.capture, status: "restored" as const } } : {}),
  };
  if (!parent.restored) {
    const receipt: OperationReceipt = { ...parent, restored: !recoveryRequired, skillManagement: summary };
    const stored = await store.append(receipt);
    if (stored.status !== "ready") throw new Error("The restored parent receipt could not be saved.");
  }
  const saved = await journal.read(operationId);
  if (saved.status !== "ready") throw new Error("The restored parent journal is unavailable.");
  const result: SkillResult = { ...summary, receipts: children };
  await journal.write({
    ...saved.record,
    status: recoveryRequired ? "recovery-required" : "terminal",
    result,
    updatedAt: new Date().toISOString(),
    steps: saved.record.steps.map((step) =>
      propagation
        ? step.receiptId && children.some((child) => child.operationId === step.receiptId && child.restored)
          ? { ...step, status: "applied" }
          : step
        : { ...step, status: "applied" },
    ),
  });
  return result;
}
