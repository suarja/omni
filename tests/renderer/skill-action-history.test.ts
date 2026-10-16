import { expect, it } from "vitest";
import { t } from "../../src/renderer/i18n";
import { historyTitle } from "../../src/renderer/canvas/rail/history-view-model";
import { isReceiptRestorable } from "../../src/renderer/review/CompletedOperations";
import type { OperationReceipt } from "../../src/shared/operations-ipc";

const receipt: OperationReceipt = {
  operationId: "operation",
  kind: "make-compatible",
  status: "applied",
  appliedAt: "2026-10-12T00:00:00.000Z",
  displayTarget: "packages/build-to-show",
  actions: [],
  git: { mode: "disabled" },
  registered: { sourceId: "personal" },
  harness: "codex",
};
const french = ((key, values) => t(key, values ?? {}, "fr")) as Parameters<typeof historyTitle>[1];
it("names a plugin without its package path in History and prefixes description undo with Annulation", () => {
  const title = historyTitle(receipt, french, "fr");
  expect(title).toContain("build-to-show");
  expect(title).not.toContain("packages/");
  const described = { ...receipt, kind: "describe-plugin" as const };
  expect(historyTitle(described, french, "fr")).toBe("Description de build-to-show");
  expect(
    historyTitle(
      { ...receipt, operationId: "restore", kind: "restore-import", restores: described.operationId },
      french,
      "fr",
      undefined,
      [described],
    ),
  ).toBe("Annulation : description de build-to-show");
});
it("offers undo for a project skill operation whose exact backup is recorded on its parent", () => {
  const removed: OperationReceipt = {
    ...receipt,
    kind: "skill-management",
    displayTarget: "remove-agent · demo",
    children: [],
    skillManagement: {
      intentId: "11111111-1111-4111-8111-111111111111",
      operationId: "operation",
      status: "applied",
      source: { status: "unchanged" },
      targets: [
        {
          projectId: "project",
          harnessId: "codex",
          bindingId: "binding",
          artifactPath: ".agents/skills/demo",
          status: "removed",
        },
      ],
      receiptIds: [],
      issues: [],
      recoveryAvailable: false,
    },
  };
  expect(isReceiptRestorable(removed, [removed])).toBe(true);
  expect(isReceiptRestorable({ ...removed, restored: true }, [removed])).toBe(false);
});
