import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authorizeAssignmentRequest,
  completeAssignmentRequest,
  releaseAssignmentRequest,
} from "../../src/renderer/operations/assignment-agent-outcome";

afterEach(() => vi.useRealTimers());

describe("native assignment authorization", () => {
  it("refuses an incomplete authorization API before acquiring or starting effects", async () => {
    const beginAgentApply = vi.fn();
    await expect(authorizeAssignmentRequest({} as never, "request")).rejects.toThrow(/authorization is unavailable/);
    await expect(authorizeAssignmentRequest({ beginAgentApply } as never, "request")).rejects.toThrow(
      /authorization is unavailable/,
    );
    await expect(
      authorizeAssignmentRequest({ beginAgentApply, endAgentApply: vi.fn() } as never, "request"),
    ).rejects.toThrow(/authorization is unavailable/);
    expect(beginAgentApply).not.toHaveBeenCalled();
  });

  it("acquires the shared guard and carries its token through completion and release", async () => {
    const authorization = { leaseId: "lease", approvedAt: "2026-10-03T00:00:00.000Z" };
    const api = {
      beginAgentApply: vi.fn(async () => authorization),
      endAgentApply: vi.fn(async () => undefined),
      listAgentRequests: vi.fn(),
      resolveAgentRequest: vi.fn(async () => ({})),
    };
    const captured = await authorizeAssignmentRequest(api as never, "request");
    await completeAssignmentRequest(api as never, "request", [{ operationId: "receipt" }] as never, captured);
    await releaseAssignmentRequest(api as never, "request", captured);
    expect(api.listAgentRequests).not.toHaveBeenCalled();
    expect(api.beginAgentApply).toHaveBeenCalledWith({ requestId: "request" });
    expect(api.resolveAgentRequest).toHaveBeenCalledWith({
      requestId: "request",
      operationIds: ["receipt"],
      outcome: { status: "applied" },
      ...authorization,
    });
    expect(api.endAgentApply).toHaveBeenCalledWith({ requestId: "request", leaseId: "lease" });
  });

  it("refuses a request that is expired or no longer pending before starting writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T00:10:00.000Z"));
    const api = {
      beginAgentApply: vi.fn().mockRejectedValue(new Error("Agent request has expired.")),
      endAgentApply: vi.fn(),
      resolveAgentRequest: vi.fn(),
    } as never;
    await expect(authorizeAssignmentRequest(api, "request")).rejects.toThrow(/expired/);
    await expect(authorizeAssignmentRequest(api, "missing")).rejects.toThrow(/expired/);
  });

  it("carries the actual approval time through completion after the request deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T00:00:00.000Z"));
    const api = {
      listAgentRequests: vi.fn(async () => ({
        status: "ready",
        requests: [{ requestId: "request", expiresAt: "2026-10-03T00:10:00.000Z" }],
      })),
      resolveAgentRequest: vi.fn(async () => ({})),
      beginAgentApply: vi.fn(async () => ({ leaseId: "lease", approvedAt: "2026-10-03T00:00:00.000Z" })),
      endAgentApply: vi.fn(async () => undefined),
    };
    const approvedAt = await authorizeAssignmentRequest(api as never, "request");
    vi.setSystemTime(new Date("2026-10-03T00:11:00.000Z"));
    await completeAssignmentRequest(api as never, "request", [{ operationId: "receipt" }] as never, approvedAt);
    expect(api.resolveAgentRequest).toHaveBeenCalledWith({
      requestId: "request",
      operationIds: ["receipt"],
      outcome: { status: "applied" },
      approvedAt: "2026-10-03T00:00:00.000Z",
      leaseId: "lease",
    });
  });
});
