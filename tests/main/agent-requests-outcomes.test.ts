import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentRequestsStore, waitForRequestChange } from "../../src/main/agent-gateway/requests-store";

const roots: string[] = [];
const NOW = Date.parse("2026-10-03T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-agent-outcome-"));
  roots.push(root);
  const file = join(root, "omni", "agent-requests.json");
  const store = createAgentRequestsStore(file, () => NOW);
  const request = await store.create({
    request: { kind: "make-compatible", sourceId: "source", harness: "codex" },
    plan: {
      planId: "plan",
      kind: "make-compatible",
      displayTarget: "target",
      actions: [],
      git: { mode: "not-a-repository", warnings: [] },
    },
    harness: "codex",
  });
  return { file, store, request };
}

describe("agent apply outcomes", () => {
  it("atomically records ordered receipts once on an approved request and preserves consent", async () => {
    const { file, store, request } = await storeFixture();
    const consent = { mode: "omni" as const, at: new Date(NOW).toISOString(), harness: "codex" as const };
    await store.resolve(request.requestId, "receipt-last", consent);
    const outcome = { status: "failed" as const, message: "A later project failed." };
    await expect(
      store.recordApplyOutcome(request.requestId, ["receipt-first", "receipt-last"], outcome),
    ).resolves.toMatchObject({
      status: "approved",
      receiptId: "receipt-last",
      receiptIds: ["receipt-first", "receipt-last"],
      applyOutcome: outcome,
      consent,
    });
    const persisted = createAgentRequestsStore(file, () => NOW);
    await expect(persisted.get(request.requestId)).resolves.toMatchObject({
      receiptIds: ["receipt-first", "receipt-last"],
      applyOutcome: outcome,
      consent,
    });
    await expect(
      store.recordApplyOutcome(request.requestId, ["receipt-first", "receipt-last"], outcome),
    ).resolves.toMatchObject({
      applyOutcome: outcome,
    });
    await expect(store.recordApplyOutcome(request.requestId, ["different"], { status: "applied" })).rejects.toThrow(
      /terminal apply outcome/i,
    );
    const disk = JSON.parse(await readFile(file, "utf8")) as { requests: Array<Record<string, unknown>> };
    expect(disk.requests[0]).toMatchObject({
      receiptId: "receipt-last",
      receiptIds: ["receipt-first", "receipt-last"],
    });
  });

  it("requires explicit consent to atomically approve and complete a pending request", async () => {
    const { store, request } = await storeFixture();
    const consent = { mode: "omni" as const, at: new Date(NOW).toISOString(), harness: "codex" as const };
    await expect(
      store.recordApplyOutcome(request.requestId, ["receipt"], { status: "applied" }, consent),
    ).rejects.toThrow(/active apply lease/i);
    const lease = await store.acquireApplyAuthorization(request.requestId);
    await expect(
      store.recordApplyOutcome(request.requestId, ["receipt"], { status: "applied" }, undefined, lease.leaseId),
    ).rejects.toThrow(/explicit consent/i);
    await expect(
      store.recordApplyOutcome(request.requestId, ["receipt"], { status: "applied" }, consent, lease.leaseId),
    ).resolves.toMatchObject({
      status: "approved",
      receiptIds: ["receipt"],
      applyOutcome: { status: "applied" },
      consent,
    });
  });

  it("reserves native applies against decline, legacy resolve, and competing apply starts", async () => {
    const { file, store, request } = await storeFixture();
    const lease = await store.acquireApplyAuthorization(request.requestId);
    expect(lease.approvedAt).toBe(new Date(NOW).toISOString());
    await expect(store.acquireApplyAuthorization(request.requestId)).rejects.toThrow(/already in progress/i);
    await expect(store.decline(request.requestId)).rejects.toThrow(/in progress/i);
    await expect(store.resolve(request.requestId, "legacy-receipt")).rejects.toThrow(/in progress/i);
    await expect(
      store.recordApplyOutcome(
        request.requestId,
        ["receipt"],
        { status: "applied" },
        { mode: "omni", at: lease.approvedAt, harness: "codex" },
      ),
    ).rejects.toThrow(/lease does not match/i);

    await expect(
      store.recordApplyOutcome(
        request.requestId,
        ["receipt"],
        { status: "applied" },
        { mode: "omni", at: lease.approvedAt, harness: "codex" },
        lease.leaseId,
      ),
    ).resolves.toMatchObject({ status: "approved", receiptIds: ["receipt"] });
    await store.releaseApplyAuthorization(request.requestId, lease.leaseId);
    await expect(createAgentRequestsStore(file, () => NOW).get(request.requestId)).resolves.toMatchObject({
      status: "approved",
      applyOutcome: { status: "applied" },
    });
  });

  it("releases a native apply reservation so the request can be declined after a paused apply", async () => {
    const { store, request } = await storeFixture();
    const lease = await store.acquireApplyAuthorization(request.requestId);
    await store.releaseApplyAuthorization(request.requestId, lease.leaseId);
    await expect(store.decline(request.requestId)).resolves.toMatchObject({ status: "declined" });
  });

  it("does not use stored timestamps as an apply authorization window", async () => {
    const { store } = await storeFixture();
    const future = await store.create({
      request: { kind: "make-compatible", sourceId: "future-source", harness: "codex" },
      plan: {
        planId: "future-plan",
        kind: "make-compatible",
        displayTarget: "target",
        actions: [],
        git: { mode: "not-a-repository", warnings: [] },
      },
      harness: "codex",
      createdAt: new Date(NOW + 1_000).toISOString(),
      expiresAt: new Date(NOW + 10_000).toISOString(),
    });
    await expect(store.acquireApplyAuthorization(future.requestId)).resolves.toHaveProperty("leaseId");
  });

  it("ignores another request notification and returns the target's terminal aggregate", async () => {
    const { store } = await storeFixture();
    const target = await store.create({
      request: { kind: "make-compatible", sourceId: "target-source", harness: "codex" },
      plan: {
        planId: "target-plan",
        kind: "make-compatible",
        displayTarget: "target",
        actions: [],
        git: { mode: "not-a-repository", warnings: [] },
      },
      harness: "codex",
    });
    const unrelated = await store.create({
      request: { kind: "make-compatible", sourceId: "other-source", harness: "codex" },
      plan: {
        planId: "other-plan",
        kind: "make-compatible",
        displayTarget: "other",
        actions: [],
        git: { mode: "not-a-repository", warnings: [] },
      },
      harness: "codex",
    });
    const waiting = store.wait(target.requestId, 5_000);
    await store.decline(unrelated.requestId);
    const lease = await store.acquireApplyAuthorization(target.requestId);
    await store.recordApplyOutcome(
      target.requestId,
      ["first", "last"],
      { status: "failed", message: "Later project failed." },
      { mode: "omni", at: new Date(NOW).toISOString(), harness: "codex" },
      lease.leaseId,
    );
    await expect(waiting).resolves.toMatchObject({
      requestId: target.requestId,
      status: "approved",
      receiptIds: ["first", "last"],
      applyOutcome: { status: "failed", message: "Later project failed." },
    });
  });

  it("rechecks after subscribing so a terminal change in the gap cannot be missed", async () => {
    let request: { status: "pending" | "approved" } = { status: "pending" };
    let listener: (() => void) | undefined;
    let markSubscribed!: () => void;
    const subscribed = new Promise<void>((resolve) => (markSubscribed = resolve));
    const waiting = waitForRequestChange(
      async () => request,
      (notify) => {
        listener = notify;
        request = { status: "approved" };
        markSubscribed();
        return () => {
          listener = undefined;
        };
      },
      (current) => current.status === "pending",
      () => 5_000,
    );
    await subscribed;
    await expect(waiting).resolves.toEqual({ status: "approved" });
    expect(listener).toBeUndefined();
  });

  it("keeps a terminal apply outcome when decline and legacy resolve race afterward", async () => {
    const { file, store, request } = await storeFixture();
    const lease = await store.acquireApplyAuthorization(request.requestId);
    const consent = { mode: "omni" as const, at: new Date(NOW).toISOString(), harness: "codex" as const };
    const completion = store.recordApplyOutcome(
      request.requestId,
      ["first", "last"],
      { status: "applied" },
      consent,
      lease.leaseId,
    );
    const decline = store.decline(request.requestId);
    const legacyResolve = store.resolve(request.requestId, "legacy-receipt");
    await Promise.all([completion, decline, legacyResolve]);
    await expect(createAgentRequestsStore(file, () => NOW).get(request.requestId)).resolves.toMatchObject({
      status: "approved",
      receiptId: "last",
      receiptIds: ["first", "last"],
      applyOutcome: { status: "applied" },
    });
  });

  it("keeps old pending requests without dropping a concurrently created request", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-expiry-race-"));
    roots.push(root);
    let clock = NOW;
    const file = join(root, "omni", "agent-requests.json");
    const store = createAgentRequestsStore(file, () => clock);
    const plan = {
      planId: "plan",
      kind: "make-compatible" as const,
      displayTarget: "target",
      actions: [],
      git: { mode: "not-a-repository" as const, warnings: [] },
    };
    const expiring = await store.create({
      request: { kind: "make-compatible", sourceId: "source", harness: "codex" },
      plan,
      harness: "codex",
      expiresAt: new Date(NOW + 1).toISOString(),
    });
    clock = NOW + 2;
    const expiredRead = store.get(expiring.requestId);
    const added = store.create({
      request: { kind: "make-compatible", sourceId: "new-source", harness: "codex" },
      plan,
      harness: "codex",
    });
    const [, created] = await Promise.all([expiredRead, added]);
    const reopened = createAgentRequestsStore(file, () => clock);
    await expect(reopened.all()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: expiring.requestId, status: "pending" }),
        expect.objectContaining({ requestId: created.requestId, status: "pending" }),
      ]),
    );
  });

  it("accepts captured authorization regardless of expiresAt but rejects a mismatched lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-late-outcome-"));
    roots.push(root);
    let clock = NOW;
    const store = createAgentRequestsStore(join(root, "omni", "agent-requests.json"), () => clock);
    const request = await store.create({
      request: { kind: "make-compatible", sourceId: "source", harness: "codex" },
      plan: {
        planId: "plan",
        kind: "make-compatible",
        displayTarget: "target",
        actions: [],
        git: { mode: "not-a-repository", warnings: [] },
      },
      harness: "codex",
      expiresAt: new Date(NOW + 1_000).toISOString(),
    });
    const lease = await store.acquireApplyAuthorization(request.requestId);
    clock = NOW + 2_000;
    await expect(store.get(request.requestId)).resolves.toMatchObject({ status: "pending" });
    await expect(
      store.recordApplyOutcome(
        request.requestId,
        ["receipt"],
        { status: "applied" },
        { mode: "omni", at: lease.approvedAt, harness: "codex" },
        lease.leaseId,
      ),
    ).resolves.toMatchObject({ status: "approved", applyOutcome: { status: "applied" } });

    const another = await store.create({
      request: { kind: "make-compatible", sourceId: "another", harness: "codex" },
      plan: {
        planId: "another-plan",
        kind: "make-compatible",
        displayTarget: "target",
        actions: [],
        git: { mode: "not-a-repository", warnings: [] },
      },
      harness: "codex",
      createdAt: new Date(clock).toISOString(),
      expiresAt: new Date(clock + 1_000).toISOString(),
    });
    const anotherLease = await store.acquireApplyAuthorization(another.requestId);
    await expect(
      store.recordApplyOutcome(
        another.requestId,
        ["late"],
        { status: "applied" },
        { mode: "omni", at: new Date(clock - 1_000).toISOString(), harness: "codex" },
        anotherLease.leaseId,
      ),
    ).rejects.toThrow(/active lease/i);
  });
});
