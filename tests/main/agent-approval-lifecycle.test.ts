import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { createAgentApply } from "../../src/main/agent-gateway/router-apply";
import { parseAgentMutationResponse } from "../../src/shared/agents-ipc";

const roots: string[] = [];
const NOW = Date.parse("2026-10-11T00:00:00.000Z");
const plan = {
  kind: "make-compatible" as const,
  planId: "plan",
  displayTarget: "source",
  actions: [],
  git: { mode: "disabled" as const, warnings: [] },
};
const payload = { kind: "make-compatible" as const, sourceId: "source", harness: "codex" as const };
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-approval-lifecycle-"));
  roots.push(root);
  const file = join(root, "requests.json");
  let clock = NOW;
  const requests = createAgentRequestsStore(file, () => clock);
  return {
    requests,
    file,
    advance: () => {
      clock += 2 * 86400000;
    },
    now: () => clock,
  };
}
it("keeps two-day-old Omni requests approvable and drops conversation requests after 24 hours", async () => {
  const { requests, file, advance, now } = await fixture();
  const pending = await requests.create({ request: payload, plan, approvalReason: { code: "asked-in-omni" } });
  const conversation = await requests.create({ request: payload, plan, approval: "conversation" });
  advance();
  expect(await requests.list()).toHaveLength(1);
  expect(await requests.get(conversation.requestId)).toBeUndefined();
  await expect(requests.acquireApplyAuthorization(conversation.requestId)).rejects.toThrow(
    "This request is no longer available; preview it again.",
  );
  const lease = await requests.acquireApplyAuthorization(pending.requestId);
  await expect(
    requests.recordApplyOutcome(
      pending.requestId,
      ["receipt"],
      { status: "applied" },
      { mode: "omni", at: lease.approvedAt },
      lease.leaseId,
    ),
  ).resolves.toMatchObject({ status: "approved" });
  expect(await createAgentRequestsStore(file, now).get(pending.requestId)).toMatchObject({ status: "approved" });
});
it("reads old expired history and optional validated reasons", async () => {
  const { requests, file, now } = await fixture();
  const request = await requests.create({ request: payload, plan });
  await writeFile(file, JSON.stringify({ schemaVersion: 1, requests: [{ ...request, status: "expired" }] }));
  expect(await createAgentRequestsStore(file, now).all()).toMatchObject([{ status: "expired" }]);
  expect(
    parseAgentMutationResponse({ ...request, approvalReason: { code: "deletes-files", count: 1 } }),
  ).toHaveProperty("approvalReason.count", 1);
  expect(() =>
    parseAgentMutationResponse({ ...request, approvalReason: { code: "deletes-files", count: 0 } }),
  ).toThrow();
  expect(() => parseAgentMutationResponse({ ...request, approvalReason: { code: "unknown" } })).toThrow();
});
it("returns pending at the requested bound without applying and can replay later approval", async () => {
  const { requests, now } = await fixture();
  const request = await requests.create({ request: payload, plan, approvalReason: { code: "asked-in-omni" } });
  const receipt = { operationId: "receipt", status: "applied" };
  const operations = { applyOperation: vi.fn() };
  const apply = createAgentApply({
    requests,
    now,
    operations: operations as never,
    operationStore: {} as never,
    previewPlan: async () => plan,
    receipt: async () => ({ status: "found", receipt: receipt as never }),
  });
  expect(await apply({ requestId: request.requestId, waitMs: 0 }, {} as never)).toMatchObject({
    status: "pending",
    requestId: request.requestId,
    approvalReason: { code: "asked-in-omni" },
  });
  expect(operations.applyOperation).not.toHaveBeenCalled();
  const legacyWait = vi.fn(async () => request);
  const legacyApply = createAgentApply({
    requests: { ...requests, wait: legacyWait },
    now,
    operations: operations as never,
    operationStore: {} as never,
    previewPlan: async () => plan,
    receipt: vi.fn(),
  });
  expect(await legacyApply({ requestId: request.requestId }, {} as never)).toMatchObject({ status: "pending" });
  expect(legacyWait).toHaveBeenCalledWith(request.requestId, 600000);
  let subscribed!: () => void;
  const entered = new Promise<void>((resolve) => {
    subscribed = resolve;
  });
  const originalWait = requests.wait;
  const waitingApply = createAgentApply({
    requests: {
      ...requests,
      wait: (id, ms) => {
        const waiting = originalWait(id, ms);
        subscribed();
        return waiting;
      },
    },
    now,
    operations: operations as never,
    operationStore: {} as never,
    previewPlan: async () => plan,
    receipt: async () => ({ status: "found", receipt: receipt as never }),
  });
  const waiting = waitingApply({ requestId: request.requestId, waitMs: 50000 }, {} as never);
  await entered;
  await requests.resolve(request.requestId, "receipt");
  expect(await waiting).toMatchObject({ status: "applied", receipt });
});
it.each([-1, 50001, 0.1, "45"])("rejects an invalid wait bound %s", async (waitMs) => {
  const { requests, now } = await fixture();
  const apply = createAgentApply({
    requests,
    now,
    operations: {} as never,
    operationStore: {} as never,
    previewPlan: async () => plan,
    receipt: vi.fn(),
  });
  expect(() => apply({ requestId: "request", waitMs }, {} as never)).toThrow(/waitMs/);
});
it("bounds each concurrent pending call independently", async () => {
  const { requests, now } = await fixture();
  const request = await requests.create({ request: payload, plan });
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wait = vi.fn(async (_id: string, ms: number) => {
    if (ms > 0) {
      entered();
      await gate;
    }
    return request;
  });
  const apply = createAgentApply({
    requests: { ...requests, wait },
    now,
    operations: {} as never,
    operationStore: {} as never,
    previewPlan: async () => plan,
    receipt: vi.fn(),
  });
  const long = apply({ requestId: request.requestId, waitMs: 50000 }, {} as never);
  await started;
  const short = apply({ requestId: request.requestId, waitMs: 0 }, {} as never);
  await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(request.requestId, 0));
  expect(await short).toMatchObject({ status: "pending" });
  release();
  expect(await long).toMatchObject({ status: "pending" });
});
