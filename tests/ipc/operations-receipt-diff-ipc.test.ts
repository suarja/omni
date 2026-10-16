import { describe, expect, it } from "vitest";

import { parseReceiptDiffRequest, parseReceiptDiffResponse } from "../../src/shared/operations-receipt-parsers";

describe("receipt diff IPC parsers", () => {
  it("parses a safe receipt diff request", () => {
    expect(parseReceiptDiffRequest({ operationId: "operation-one", relativePath: "packages/demo/SKILL.md" })).toEqual({
      operationId: "operation-one",
      relativePath: "packages/demo/SKILL.md",
    });
  });

  it("rejects unsafe receipt diff request fields", () => {
    expect(() => parseReceiptDiffRequest({ operationId: "operation/one", relativePath: "SKILL.md" })).toThrow();
    expect(() => parseReceiptDiffRequest({ operationId: "operation-one", relativePath: "../SKILL.md" })).toThrow();
  });

  it("parses ready and unavailable responses", () => {
    expect(
      parseReceiptDiffResponse({
        status: "ready",
        diff: { kind: "unified", text: "--- before\n+++ after\n", truncated: false },
        before: { byteLength: 4 },
        after: { byteLength: 5, changedSince: true },
      }),
    ).toMatchObject({ status: "ready", after: { changedSince: true } });
    expect(parseReceiptDiffResponse({ status: "unavailable", reason: "The backup is unavailable." })).toEqual({
      status: "unavailable",
      reason: "The backup is unavailable.",
    });
  });
});
