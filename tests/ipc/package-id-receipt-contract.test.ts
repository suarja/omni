import { expect, it } from "vitest";
import { parsePreviewMarketplaceResponse } from "../../src/shared/operations-ipc-parsers";
import { parseOperationReceipt } from "../../src/shared/operations-receipt-parsers";

const plan = {
  planId: "plan",
  kind: "write-skill",
  displayTarget: "packages/tools",
  packageId: "packages/tools",
  actions: [],
  git: { mode: "unavailable", warnings: [] },
};
const receipt = {
  operationId: "receipt",
  kind: "write-skill",
  status: "applied",
  appliedAt: "2026-10-14T00:00:00.000Z",
  displayTarget: "packages/tools",
  packageId: "packages/tools",
  actions: [],
  git: { mode: "unavailable" },
  registered: null,
};

it("retains canonical package ids when reading write plans and receipts", () => {
  expect(parsePreviewMarketplaceResponse({ status: "ready", plan })).toMatchObject({
    plan: { packageId: "packages/tools" },
  });
  expect(parseOperationReceipt(receipt)).toMatchObject({ packageId: "packages/tools" });
});
it("rejects unsafe package ids in plans and receipts", () => {
  for (const packageId of ["../outside", "/absolute", "packages/../outside"]) {
    expect(() => parsePreviewMarketplaceResponse({ status: "ready", plan: { ...plan, packageId } })).toThrow();
    expect(() => parseOperationReceipt({ ...receipt, packageId })).toThrow();
  }
});
