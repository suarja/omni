import { expect, it } from "vitest";
import { assertProviderCommandOutcome } from "../../src/main/workshop-delivery/provider-cli";
import { parseWorkshopDelivery, workshopPushSchema } from "../../src/shared/workshop-delivery-ipc";
import { parseOperationReceipt } from "../../src/shared/operations-receipt-parsers";

it("rejects provider partial failures even when their CLI exits successfully", () => {
  expect(() =>
    assertProviderCommandOutcome(
      JSON.stringify({ upgradedRoots: ["fixture"], errors: [{ message: "offline" }] }, null, 2),
    ),
  ).toThrow(/failure/);
  expect(() => assertProviderCommandOutcome('progress\n{"status":"error"}')).toThrow(/failure/);
  expect(() => assertProviderCommandOutcome("")).toThrow(/no update result/);
  expect(() =>
    assertProviderCommandOutcome(JSON.stringify({ upgradedRoots: ["fixture"], errors: [] }, null, 2)),
  ).not.toThrow();
});
it("round-trips a workshop push receipt and rejects unknown fields at IPC", () => {
  const receipt = {
    operationId: "receipt",
    kind: "write-skill",
    status: "applied",
    appliedAt: "2026-10-22T00:00:00.000Z",
    displayTarget: "fixture",
    actions: [],
    git: { mode: "commit", commit: "a".repeat(40) },
    registered: { sourceId: "workshop" },
    workshopPush: { status: "failed", commit: "a".repeat(40), ahead: 2, behind: 0, diagnostic: "Offline. Retry." },
  };
  expect(parseOperationReceipt(receipt).workshopPush).toEqual(receipt.workshopPush);
  expect(() => workshopPushSchema.parse({ ...receipt.workshopPush, force: true })).toThrow();
  expect(() =>
    parseWorkshopDelivery({
      status: "ready",
      workshop: null,
      plugins: { status: "ready", behind: -1, installations: [], diagnostics: [] },
      projects: [],
      diagnostics: [],
    }),
  ).toThrow();
});
