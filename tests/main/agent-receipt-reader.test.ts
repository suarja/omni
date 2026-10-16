import { describe, expect, it } from "vitest";

import { createAgentReceiptReader } from "../../src/main/agent-gateway/router-receipt";
import type { OperationReceipt } from "../../src/shared/operations-ipc";

const receipts: readonly OperationReceipt[] = ["first", "second"].map((operationId) => ({
  operationId,
  kind: "apply-plan",
  status: "applied",
  appliedAt: "2026-10-03T00:00:00.000Z",
  displayTarget: operationId,
  actions: [],
  git: { mode: "not-a-repository" },
  registered: null,
}));

function reader(stored: unknown, recorded = receipts) {
  return createAgentReceiptReader(
    { get: async () => stored } as never,
    { read: async () => ({ status: "ready", receipts: recorded }) } as never,
  );
}

describe("request receipt lookup", () => {
  it("returns every receipt in persisted project order and a legacy representative", async () => {
    const read = reader({ receiptId: "first", receiptIds: ["second", "first"] });
    await expect(read({ requestId: "request" })).resolves.toEqual({
      status: "found",
      receipt: receipts[0],
      receipts: [receipts[1], receipts[0]],
    });
  });

  it("reads legacy single-receipt requests and operation-specific lookups", async () => {
    const read = reader({ receiptId: "first" });
    await expect(read({ requestId: "request" })).resolves.toEqual({
      status: "found",
      receipt: receipts[0],
      receipts: [receipts[0]],
    });
    await expect(read({ operationId: "second" })).resolves.toEqual({ status: "found", receipt: receipts[1] });
  });

  it("reports a missing member instead of returning a successful incomplete aggregate", async () => {
    await expect(
      reader({ receiptId: "first", receiptIds: ["first", "lost"] })({ requestId: "request" }),
    ).resolves.toMatchObject({
      status: "missing",
      missingReceiptIds: ["lost"],
      message: expect.stringContaining("do not repeat"),
    });
  });

  it("returns missing for an unresolved or unavailable request", async () => {
    await expect(reader(undefined)({ requestId: "request" })).resolves.toEqual({ status: "missing" });
    await expect(reader({})({ requestId: "request" })).resolves.toEqual({ status: "missing" });
  });

  it("reports a successful no-op as a terminal request with no receipt", async () => {
    await expect(
      reader({ applyOutcome: { status: "no-op" }, receiptIds: [] })({ requestId: "request" }),
    ).resolves.toEqual({
      status: "none",
      message: "This request produced no operation receipt.",
    });
  });
});
