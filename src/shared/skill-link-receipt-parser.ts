import type { OperationReceipt } from "./operations-ipc";
import { assertKeys, assertRecord, readOpaque } from "./operations-ipc-parser-utils";

export function parseSkillLinkReceiptPointer(value: unknown): NonNullable<OperationReceipt["link"]> {
  const link = assertRecord(value, "Unbound resolution journal link");
  assertKeys(link, ["intentId", "stepId"], "Unbound resolution journal link");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const intentId = readOpaque(link.intentId, "Unbound resolution intent id");
  const stepId = readOpaque(link.stepId, "Unbound resolution step id");
  if (!uuid.test(intentId) || !uuid.test(stepId))
    throw new Error("Unbound resolution journal identifiers must be UUIDs.");
  return { intentId, stepId };
}

export function assertSkillLinkReceipt(
  value: Readonly<{
    kind: unknown;
    operationId: unknown;
    registered: unknown;
    bindings: unknown;
    project: unknown;
    actions: readonly unknown[];
    link?: NonNullable<OperationReceipt["link"]>;
  }>,
): void {
  if (value.link && value.kind !== "link-skill")
    throw new Error("Link pointers are only valid on unbound skill linkage receipts.");
  if (
    value.kind === "link-skill" &&
    (!value.link ||
      value.link.stepId !== value.operationId ||
      value.registered !== null ||
      value.bindings === undefined ||
      value.project === undefined ||
      value.actions.some(
        (action) =>
          typeof action === "object" && action !== null && "kind" in action && action.kind === "delete-directory",
      ))
  )
    throw new Error("Unbound linkage receipts must identify one project-rooted journal step and its Binding effects.");
}
