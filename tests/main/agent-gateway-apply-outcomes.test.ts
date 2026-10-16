import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentApply } from "../../src/main/agent-gateway/router-apply";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import type { AgentPlan } from "../../src/shared/agents-ipc";
import { parseAgentWriteRequest } from "../../src/shared/agents-ipc";
import type { OperationReceipt } from "../../src/shared/operations-ipc";

const roots: string[] = [];
const NOW = Date.parse("2026-10-03T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-agent-apply-outcome-"));
  roots.push(root);
  const requests = createAgentRequestsStore(join(root, "omni", "agent-requests.json"), () => NOW);
  const plan: AgentPlan = {
    planId: "compatibility-plan",
    kind: "make-compatible",
    displayTarget: "personal",
    actions: [],
    git: { mode: "not-a-repository", warnings: [] },
  };
  const request = await requests.create({
    request: { kind: "make-compatible", sourceId: "personal", harness: "codex" },
    plan,
    approval: "conversation",
    harness: "codex",
  });
  return { requests, plan, request };
}

function operationReceipt(operationId: string): OperationReceipt {
  return {
    operationId,
    kind: "make-compatible",
    status: "applied",
    appliedAt: new Date(NOW).toISOString(),
    displayTarget: operationId,
    actions: [],
    git: { mode: "not-a-repository" },
    registered: null,
  };
}

function applyOptions(
  requests: Awaited<ReturnType<typeof fixture>>["requests"],
  plan: AgentPlan,
  operations: Record<string, unknown>,
  receipts: OperationReceipt[],
) {
  return {
    operations: operations as never,
    requests,
    operationStore: { read: async () => ({ status: "ready" as const, receipts }) } as never,
    previewPlan: async () => plan,
    receipt: async (request: Awaited<ReturnType<typeof fixture>>["request"]) => {
      const ids = request.receiptIds ?? (request.receiptId ? [request.receiptId] : []);
      const found = ids.map((id) => receipts.find((item) => item.operationId === id));
      if (found.some((item) => !item))
        return {
          status: "missing" as const,
          missingReceiptIds: ids.filter((id) => !receipts.some((item) => item.operationId === id)),
        };
      const complete = found as OperationReceipt[];
      return complete.length
        ? { status: "found" as const, receipt: complete.at(-1)!, receipts: complete }
        : { status: "missing" as const };
    },
    now: () => NOW,
  };
}

describe("agent gateway apply outcomes", () => {
  it("records the operation receipt and replays it without applying twice", async () => {
    const { requests, plan, request } = await fixture();
    const receipt = operationReceipt("compatibility-receipt");
    const operations = { applyOperation: vi.fn(async () => ({ status: "applied" as const, receipt })) };
    const apply = createAgentApply(applyOptions(requests, plan, operations, [receipt]));

    await expect(apply({ requestId: request.requestId }, {} as never)).resolves.toMatchObject({
      status: "applied",
      receipt: { operationId: receipt.operationId },
    });
    await expect(requests.get(request.requestId)).resolves.toMatchObject({
      status: "approved",
      receiptIds: [receipt.operationId],
      applyOutcome: { status: "applied" },
    });
    await expect(apply({ requestId: request.requestId }, {} as never)).resolves.toMatchObject({
      status: "applied",
      receipt: { operationId: receipt.operationId },
    });
    expect(operations.applyOperation).toHaveBeenCalledOnce();
  });

  it("shares concurrent applies for one request", async () => {
    const { requests, plan, request } = await fixture();
    const receipt = operationReceipt("concurrent-receipt");
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    const operations = {
      applyOperation: vi.fn(async () => {
        entered?.();
        await gate;
        return { status: "applied" as const, receipt };
      }),
    };
    const apply = createAgentApply(applyOptions(requests, plan, operations, [receipt]));
    const first = apply({ requestId: request.requestId }, {} as never);
    await started;
    const second = apply({ requestId: request.requestId }, {} as never);
    release?.();
    const [result, shared] = await Promise.all([first, second]);

    expect(shared).toBe(result);
    expect(operations.applyOperation).toHaveBeenCalledOnce();
  });

  it("does not repeat writes when a terminal receipt reference is missing", async () => {
    const { requests, plan, request } = await fixture();
    await requests.resolve(request.requestId, "missing-receipt");
    await requests.recordApplyOutcome(request.requestId, ["missing-receipt"], { status: "applied" });
    const operations = { applyOperation: vi.fn() };
    const apply = createAgentApply(applyOptions(requests, plan, operations, []));

    await expect(apply({ requestId: request.requestId }, {} as never)).resolves.toMatchObject({
      status: "failed",
      missingReceiptIds: ["missing-receipt"],
      message: expect.stringContaining("do not repeat"),
    });
    expect(operations.applyOperation).not.toHaveBeenCalled();
  });

  it("requires old assignment requests to be previewed through the managed service", async () => {
    const { requests } = await fixture();
    const binding = {
      bindingId: "binding-one",
      sourceId: "personal",
      packageId: "pkg",
      artifactPath: "skills/example",
      kind: "skill" as const,
      projectId: "project-one",
      harnessId: "codex" as const,
      boundHash: "hash",
      createdAt: new Date(NOW).toISOString(),
    };
    const plan: AgentPlan = {
      kind: "assign",
      bindings: [binding],
      plans: [{ projectId: binding.projectId, planId: "old-plan", status: "ready", actions: [] }],
    };
    const request = await requests.create({
      request: {
        kind: "assign",
        artifactPath: binding.artifactPath,
        sourceId: binding.sourceId,
        packageId: binding.packageId,
        projectIds: [binding.projectId],
      },
      plan,
      approval: "conversation",
    });
    const operations = { applyOperation: vi.fn() };
    const apply = createAgentApply(applyOptions(requests, plan, operations, []));

    await expect(apply({ requestId: request.requestId }, {} as never)).resolves.toMatchObject({
      status: "stale",
      message: expect.stringContaining("Preview it again"),
    });
    expect(operations.applyOperation).not.toHaveBeenCalled();
  });
});

it("returns stale before applying an available legacy plan when the current file effects changed", async () => {
  const { requests, request } = await fixture();
  const savedPlan = {
    kind: "make-compatible" as const,
    planId: "saved",
    displayTarget: "personal",
    actions: [
      { kind: "write-file" as const, relativePath: "SKILL.md", beforeHash: "a", afterHash: "b", byteLength: 4 },
    ],
    git: { mode: "disabled" as const, warnings: [] },
  };
  const pending = await requests.create({
    request: parseAgentWriteRequest(request.request),
    approval: "conversation",
    plan: savedPlan,
  });
  const operations = {
    applyOperation: vi.fn(async () => ({ status: "applied" as const, receipt: operationReceipt("wrong") })),
  };
  const fresh = { ...savedPlan, planId: "fresh", actions: [{ ...savedPlan.actions[0], afterHash: "c" }] };
  const apply = createAgentApply(applyOptions(requests, fresh, operations, []));
  expect(await apply({ requestId: pending.requestId }, {} as never)).toEqual({
    status: "stale",
    message: "The files changed; preview again.",
  });
  expect(operations.applyOperation).not.toHaveBeenCalled();
});
