import { observedPackages } from "./agent-gateway-helpers";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentGateway, type AgentRouter } from "../../src/main/agent-gateway/server";
import { createAgentToken } from "../../src/main/agent-gateway/auth";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { createAgentRouter } from "../../src/main/agent-gateway/router";
import { createLastSeenStore } from "../../src/main/agent-gateway/last-seen-store";
import type { AgentPlan } from "../../src/shared/agents-ipc";
import type { OperationReceipt } from "../../src/shared/operations-ipc";
import { connect, hello, response } from "./agent-gateway-helpers";

const roots: string[] = [];
const gateways: Array<{ stop(): Promise<void> }> = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "omni-agent-gateway-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.useRealTimers();
});

async function startedGateway(userDataPath: string, router: AgentRouter) {
  const gateway = createAgentGateway({ userDataPath, router });
  gateways.push(gateway);
  await gateway.start();
  return gateway;
}

describe("agent gateway socket", () => {
  it("turns preview_create_skill into an approved write-skill request and receipt", async () => {
    const userDataPath = await root();
    const requestFile = join(userDataPath, "omni", "agent-requests.json");
    const plan: AgentPlan = {
      planId: "skill-plan",
      kind: "write-skill",
      displayTarget: "packages/pstack",
      actions: [],
      git: { mode: "commit", warnings: [] },
    };
    const receipt: OperationReceipt = {
      operationId: "skill-receipt",
      kind: "write-skill",
      status: "applied",
      appliedAt: "2026-09-14T00:00:00.000Z",
      displayTarget: "packages/pstack",
      actions: [],
      git: { mode: "commit" },
      registered: { sourceId: "personal" },
    };
    const scope = { sourceId: "personal", packageId: "packages/pstack", targets: [] as const };
    const managedPreview = {
      status: "ready" as const,
      intentId: "skill-intent-one",
      planId: plan.planId,
      effectFingerprint: "a".repeat(64),
      scope,
      steps: [{ stepId: "source", scope, plan, bindingEffects: [], files: [] }],
    };
    const managedResult = {
      intentId: managedPreview.intentId,
      operationId: managedPreview.intentId,
      status: "applied" as const,
      source: { status: "created" as const, sourceId: "personal" },
      targets: [],
      receiptIds: [receipt.operationId],
      receipts: [receipt],
      issues: [],
      recoveryAvailable: false,
    };
    const receipts: OperationReceipt[] = [];
    const skillManagement = {
      initialize: vi.fn(async () => undefined),
      preview: vi.fn(async () => managedPreview),
      refresh: vi.fn(async () => managedPreview),
      apply: vi.fn(async () => {
        receipts.push(receipt);
        return managedResult;
      }),
      readResult: vi.fn(async () => (receipts.length ? managedResult : undefined)),
    };
    const requests = createAgentRequestsStore(requestFile, () => Date.parse("2026-09-14T00:00:00.000Z"));
    const router = createAgentRouter({
      userDataPath,
      appVersion: "1.0.0",
      registry: {
        observeRegisteredEntry: async () => observedPackages("packages/pstack"),
        listRegistry: async () => ({
          status: "ready" as const,
          registry: {
            observeRegisteredEntry: async () => observedPackages("packages/pstack"),
            revision: 1,
            projects: [],
            sources: [{ ref: { kind: "source", id: "personal" }, ownership: "personal" }],
          },
        }),
      } as never,
      bindings: {} as never,
      operations: { skillManagement } as never,
      requests,
      operationStore: { read: async () => ({ status: "ready" as const, receipts }) } as never,
      settingsStore: {
        read: async () => ({
          schemaVersion: 6,
          git: { commitChanges: false },
          agents: {
            approval: { personalMarketplace: "conversation", projects: "omni" },
            guard: { warnProjectIds: [] },
          },
          ai: {},
          features: {},
        }),
      } as never,
      now: () => Date.parse("2026-09-14T00:00:00.000Z"),
    });
    const preview = (await router.handle(
      "preview_create_skill",
      {
        sourceId: "personal",
        packageId: "packages/pstack",
        name: "lesson-capture",
        description: "Use when recording a durable lesson.",
        body: "# Lesson capture\n",
        reason: "Capture the lesson.",
      },
      { name: "test", version: "1", harness: "claude-code", sessionName: "session-one" },
    )) as { requestId: string; plan: AgentPlan; intentId: string };
    expect(preview.plan).toEqual(plan);
    expect(preview.intentId).toBe(managedPreview.intentId);
    expect(skillManagement.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "write",
        request: expect.objectContaining({ kind: "write-skill", mode: "create", folderName: "lesson-capture" }),
      }),
      expect.objectContaining({ kind: "mcp", harness: "claude-code", sessionName: "session-one" }),
    );
    await expect(requests.get(preview.requestId)).resolves.toMatchObject({
      request: { kind: "write-skill", packageId: "packages/pstack" },
      intentId: managedPreview.intentId,
    });
    await expect(
      router.handle("apply", { requestId: preview.requestId }, { name: "test", version: "1" }),
    ).resolves.toMatchObject({
      status: "applied",
      receipts: [receipt],
    });
    expect(skillManagement.apply).toHaveBeenCalledOnce();
    await expect(requests.get(preview.requestId)).resolves.toMatchObject({
      status: "approved",
      receiptId: receipt.operationId,
      consent: { mode: "conversation", harness: "claude-code", sessionName: "session-one" },
    });
  });

  it("closes a connection whose first hello frame has the wrong token", async () => {
    const userDataPath = await root();
    const token = await createAgentToken(userDataPath);
    const gateway = createAgentGateway({
      userDataPath,
      router: { handle: async () => ({ ok: true }) },
    });
    await gateway.start();
    const socket = await connect(gateway.socketPath);
    socket.write(
      `${JSON.stringify({ id: "1", method: "hello", params: { token: "wrong", client: { name: "test", version: "1" } } })}\n`,
    );
    await expect(once(socket, "close")).resolves.toBeDefined();
    expect(token).toMatch(/^[a-f0-9]{64}$/u);
    socket.destroy();
    await gateway.stop();
  });

  it("notifies the owner when an identified harness completes hello", async () => {
    const userDataPath = await root();
    const token = await createAgentToken(userDataPath);
    const identified = vi.fn();
    const lastSeen = createLastSeenStore(userDataPath, () => Date.parse("2026-09-14T00:00:00.000Z"));
    const gateway = createAgentGateway({
      userDataPath,
      router: { handle: async () => ({ ok: true }) },
      identifyClient: async () => ({ harness: "claude-code" as const }),
      onClientIdentified: async (client) => {
        identified(client);
        if (client.harness) await lastSeen.record(client.harness);
      },
    });
    gateways.push(gateway);
    await gateway.start();
    const socket = await connect(gateway.socketPath);
    await hello(socket, token);
    await vi.waitFor(() =>
      expect(identified).toHaveBeenCalledWith(expect.objectContaining({ harness: "claude-code" })),
    );
    await vi.waitFor(async () => {
      await expect(lastSeen.lastSeen()).resolves.toMatchObject({ "claude-code": "2026-09-14T00:00:00.000Z" });
    });
    socket.destroy();
  });

  it("keeps hello immediate and waits for client identity before routing requests", async () => {
    const userDataPath = await root();
    const token = await createAgentToken(userDataPath);
    let resolveIdentity!: (value: Partial<{ harness: "claude-code" }>) => void;
    const identity = new Promise<Partial<{ harness: "claude-code" }>>((resolve) => (resolveIdentity = resolve));
    const seen: string[] = [];
    const gateway = createAgentGateway({
      userDataPath,
      router: {
        handle: async (_method, _params, client) => {
          seen.push(client.harness ?? "pending");
          return { harness: client.harness ?? null };
        },
      },
      identifyClient: () => identity,
      onClientIdentified: async () => {
        throw new Error("optional metadata write failed");
      },
    });
    gateways.push(gateway);
    await gateway.start();
    const socket = await connect(gateway.socketPath);
    await expect(hello(socket, token)).resolves.toMatchObject({ result: { status: "ready" } });

    let requestHandled = false;
    const pendingResponse = response(socket).then((value) => {
      requestHandled = true;
      return value;
    });
    socket.write(`${JSON.stringify({ id: "status-before-identity", method: "status", params: {} })}\n`);
    await Promise.resolve();
    expect(requestHandled).toBe(false);
    resolveIdentity({ harness: "claude-code" });
    await expect(pendingResponse).resolves.toMatchObject({ result: { harness: "claude-code" } });
    expect(seen).toEqual(["claude-code"]);
    socket.destroy();
  });

  it("waits for delayed identity metadata before routing an immediate request", async () => {
    const userDataPath = await root();
    const token = await createAgentToken(userDataPath);
    const gateway = createAgentGateway({
      userDataPath,
      router: { handle: async (_method, _params, client) => client },
      identifyClient: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { harness: "codex", sessionName: "session-one", cwd: "/tmp/project" };
      },
    });
    gateways.push(gateway);
    await gateway.start();
    const socket = await connect(gateway.socketPath);
    await hello(socket, token);
    socket.write(`${JSON.stringify({ id: "immediate", method: "status", params: {} })}\n`);
    await expect(response(socket)).resolves.toMatchObject({
      id: "immediate",
      result: { harness: "codex", sessionName: "session-one", cwd: "/tmp/project" },
    });
    socket.destroy();
  });

  it("routes with base client metadata after the identity deadline", async () => {
    const userDataPath = await root();
    const token = await createAgentToken(userDataPath);
    const gateway = createAgentGateway({
      userDataPath,
      router: { handle: async (_method, _params, client) => client },
      identifyClient: () => new Promise(() => undefined),
    });
    gateways.push(gateway);
    await gateway.start();
    const socket = await connect(gateway.socketPath);
    await hello(socket, token);
    const requestStartedAt = Date.now();
    socket.write(`${JSON.stringify({ id: "deadline", method: "status", params: {} })}\n`);
    await expect(response(socket)).resolves.toMatchObject({
      id: "deadline",
      result: { name: "test", version: "1" },
    });
    const elapsed = Date.now() - requestStartedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(3_000);
    socket.destroy();
  }, 5000);

  it("rejects overlapping requests during identity lookup and accepts the next request after completion", async () => {
    const userDataPath = await root();
    const token = await createAgentToken(userDataPath);
    let resolveIdentity!: (value: { cwd: string }) => void;
    const identity = new Promise<{ cwd: string }>((resolve) => (resolveIdentity = resolve));
    const handled: number[] = [];
    const gateway = createAgentGateway({
      userDataPath,
      identifyClient: () => identity,
      router: {
        handle: async (_method, params, client) => {
          const value = (params as { value: number }).value;
          handled.push(value);
          return { value, cwd: client.cwd };
        },
      },
    });
    gateways.push(gateway);
    await gateway.start();
    const socket = await connect(gateway.socketPath);
    await hello(socket, token);
    const busyResponse = response(socket);
    socket.write(
      [1, 2].map((value) => JSON.stringify({ id: value, method: "ordered", params: { value } })).join("\n") + "\n",
    );
    await expect(busyResponse).resolves.toMatchObject({ id: 2, error: { code: "busy" } });
    expect(handled).toEqual([]);

    const firstResponse = response(socket);
    resolveIdentity({ cwd: "/tmp/project" });
    await expect(firstResponse).resolves.toMatchObject({ id: 1, result: { value: 1, cwd: "/tmp/project" } });
    socket.write(`${JSON.stringify({ id: 3, method: "ordered", params: { value: 3 } })}\n`);
    await expect(response(socket)).resolves.toMatchObject({ id: 3, result: { value: 3, cwd: "/tmp/project" } });
    expect(handled).toEqual([1, 3]);
    socket.destroy();
  });

  it("does not identify a client when the identifier has no harness", async () => {
    const userDataPath = await root();
    const token = await createAgentToken(userDataPath);
    const identified = vi.fn();
    const lastSeen = createLastSeenStore(userDataPath);
    const gateway = createAgentGateway({
      userDataPath,
      router: { handle: async () => ({ ok: true }) },
      onClientIdentified: async (client) => {
        identified(client);
        if (client.harness) await lastSeen.record(client.harness);
      },
    });
    gateways.push(gateway);
    await gateway.start();
    const socket = await connect(gateway.socketPath);
    await hello(socket, token);
    await vi.waitFor(() => expect(identified).toHaveBeenCalled());
    expect(identified.mock.calls[0]?.[0]).not.toHaveProperty("harness");
    await expect(lastSeen.lastSeen()).resolves.toEqual({ "claude-code": undefined, codex: undefined });
    socket.destroy();
  });

  it("rejects an oversized frame and serves authenticated requests", async () => {
    const userDataPath = await root();
    const token = await createAgentToken(userDataPath);
    const gateway = await startedGateway(userDataPath, { handle: async (method) => ({ method }) });
    const socket = await connect(gateway.socketPath);
    const greeting = await hello(socket, token);
    expect(greeting.result).toEqual({ status: "ready" });
    socket.write(`${JSON.stringify({ id: "status", method: "status", params: {} })}\n`);
    expect((await response(socket)).result).toEqual({ method: "status" });
    socket.write(`${"x".repeat(256 * 1024 + 1)}\n`);
    await expect(once(socket, "close")).resolves.toBeDefined();
    socket.destroy();
  });

  it("enforces twenty requests per second on one connection", async () => {
    const userDataPath = await root();
    const token = await createAgentToken(userDataPath);
    const gateway = await startedGateway(userDataPath, { handle: async () => ({ ok: true }) });
    const socket = await connect(gateway.socketPath);
    await hello(socket, token);
    for (let index = 0; index < 20; index += 1) {
      socket.write(`${JSON.stringify({ id: index, method: "status", params: {} })}\n`);
      expect((await response(socket)).result).toEqual({ ok: true });
    }
    socket.write(`${JSON.stringify({ id: 21, method: "status", params: {} })}\n`);
    expect((await response(socket)).error).toMatchObject({ code: "rate-limit" });
    socket.destroy();
  });

  it("closes an authenticated connection after five minutes of inactivity", async () => {
    vi.useFakeTimers();
    const userDataPath = await root();
    const token = await createAgentToken(userDataPath);
    const gateway = await startedGateway(userDataPath, { handle: async () => ({ ok: true }) });
    const socket = await connect(gateway.socketPath);
    await hello(socket, token);
    const closed = once(socket, "close");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    await expect(closed).resolves.toBeDefined();
  });

  it("persists pending requests and waits for an IPC-side resolution", async () => {
    const userDataPath = await root();
    const requestFile = join(userDataPath, "omni", "agent-requests.json");
    const plan: AgentPlan = {
      planId: "plan-one",
      kind: "make-compatible",
      displayTarget: "claude-plugins",
      actions: [],
      git: { mode: "commit", warnings: [] },
    };
    const receipt: OperationReceipt = {
      operationId: "receipt-one",
      kind: "make-compatible",
      status: "applied",
      appliedAt: "2026-09-14T00:00:00.000Z",
      displayTarget: "claude-plugins",
      actions: [],
      git: { mode: "commit" },
      registered: null,
    };
    const requests = createAgentRequestsStore(requestFile, () => Date.parse("2026-09-14T00:00:00.000Z"));
    const operationStore = { read: async () => ({ status: "ready" as const, receipts: [receipt] }) } as never;
    const router = createAgentRouter({
      userDataPath,
      appVersion: "1.0.0",
      registry: { observeRegisteredEntry: async () => observedPackages("claude-plugins") } as never,
      bindings: {} as never,
      operations: { previewOperation: async () => ({ status: "ready" as const, plan }) } as never,
      requests,
      operationStore,
      settingsStore: {
        read: async () => ({
          schemaVersion: 2,
          git: { commitChanges: true },
          agents: { approval: { personalMarketplace: "omni", projects: "omni" } },
        }),
      } as never,
    });
    const preview = (await router.handle(
      "preview_make_compatible",
      { sourceId: "personal", harness: "claude-code", packageId: "claude-plugins" },
      { name: "test", version: "1", harness: "claude-code" },
    )) as { requestId: string; plan: AgentPlan };
    expect(preview.plan).toEqual(plan);
    const restarted = createAgentRequestsStore(requestFile, () => Date.parse("2026-09-14T00:00:00.000Z"));
    await expect(restarted.get(preview.requestId)).resolves.toMatchObject({ status: "pending" });
    const applying = router.handle(
      "apply",
      { requestId: preview.requestId },
      { name: "test", version: "1", harness: "claude-code" },
    );
    await requests.resolve(preview.requestId, receipt.operationId);
    await expect(applying).resolves.toMatchObject({ status: "applied", receipt });
  });

  it("returns declined outcomes and keeps pending requests past expiresAt", async () => {
    const userDataPath = await root();
    const now = Date.parse("2026-09-14T00:00:00.000Z");
    const plan: AgentPlan = {
      planId: "plan-one",
      kind: "make-compatible",
      displayTarget: "target",
      actions: [],
      git: { mode: "commit", warnings: [] },
    };
    const request = { kind: "make-compatible" as const, sourceId: "source", harness: "codex" as const };
    const requests = createAgentRequestsStore(join(userDataPath, "omni", "agent-requests.json"), () => now);
    const declined = await requests.create({ request, plan });
    await requests.decline(declined.requestId);
    await expect(requests.get(declined.requestId)).resolves.toMatchObject({ status: "declined" });
    const expired = await requests.create({ request, plan, expiresAt: new Date(now - 1).toISOString() });
    await expect(requests.get(expired.requestId)).resolves.toMatchObject({ status: "pending" });
  });
});
