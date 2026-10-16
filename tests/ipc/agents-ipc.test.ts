import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseAgentDeclineRequest,
  parseAgentBeginApplyRequest,
  parseAgentEndApplyRequest,
  parseAgentApplyAuthorization,
  parseAgentReceiptRequest,
  parseAgentResolveRequest,
  parseAgentMutationResponse,
  parseAgentStatusResponse,
  parseAgentWriteRequest,
} from "../../src/shared/agents-ipc";

const roots: string[] = [];

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("electron");
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("agent IPC boundary", () => {
  it("parses strict preview and resolution requests", () => {
    expect(parseAgentWriteRequest({ kind: "make-compatible", sourceId: "personal", harness: "claude-code" })).toEqual({
      kind: "make-compatible",
      sourceId: "personal",
      harness: "claude-code",
    });
    expect(() =>
      parseAgentWriteRequest({
        kind: "assign",
        artifactPath: "skills/review",
        sourceId: "source",
        packageId: "pkg",
        projectIds: ["project"],
        extra: true,
      }),
    ).toThrow(/unexpected field/i);
    expect(
      parseAgentWriteRequest({
        kind: "assign",
        artifactPath: "skills/review",
        sourceId: "source",
        packageId: "pkg",
        projectIds: ["project"],
        harnesses: ["codex"],
      }),
    ).toMatchObject({ kind: "assign", harnesses: ["codex"] });
    expect(() =>
      parseAgentWriteRequest({
        kind: "assign",
        artifactPath: "skills/review",
        sourceId: "source",
        packageId: "pkg",
        projectIds: ["project"],
        harnesses: ["codex", "codex"],
      }),
    ).toThrow(/unique/i);
    expect(parseAgentWriteRequest({ kind: "remove-skill", bindingIds: ["binding-a"] })).toEqual({
      kind: "remove-skill",
      bindingIds: ["binding-a"],
    });
    expect(parseAgentWriteRequest({ kind: "restore-skill", operationId: "operation-a" })).toEqual({
      kind: "restore-skill",
      operationId: "operation-a",
    });
    expect(parseAgentResolveRequest({ requestId: "request", operationId: "operation" })).toEqual({
      requestId: "request",
      operationId: "operation",
    });
    expect(
      parseAgentResolveRequest({
        requestId: "request",
        operationIds: ["first", "second"],
        outcome: { status: "failed", message: "Project two failed." },
        approvedAt: "2026-10-03T00:00:00.000Z",
        leaseId: "apply-lease",
      }),
    ).toEqual({
      requestId: "request",
      operationIds: ["first", "second"],
      outcome: { status: "failed", message: "Project two failed." },
      approvedAt: "2026-10-03T00:00:00.000Z",
      leaseId: "apply-lease",
    });
    expect(() =>
      parseAgentResolveRequest({
        requestId: "request",
        operationId: "legacy",
        operationIds: ["aggregate"],
        outcome: { status: "applied" },
      }),
    ).toThrow(/unexpected field/i);
    expect(() =>
      parseAgentResolveRequest({
        requestId: "request",
        operationIds: ["duplicate", "duplicate"],
        outcome: { status: "applied" },
      }),
    ).toThrow(/unique/i);
    expect(() =>
      parseAgentResolveRequest({
        requestId: "request",
        operationIds: ["receipt"],
        outcome: { status: "applied", message: "unexpected" },
      }),
    ).toThrow(/message/i);
    expect(() =>
      parseAgentResolveRequest({
        requestId: "request",
        operationIds: ["receipt"],
        outcome: { status: "applied" },
        approvedAt: "not-a-time",
      }),
    ).toThrow(/approval time/i);
    expect(parseAgentDeclineRequest({ requestId: "request" })).toEqual({ requestId: "request" });
    expect(parseAgentBeginApplyRequest({ requestId: "request" })).toEqual({ requestId: "request" });
    expect(parseAgentEndApplyRequest({ requestId: "request", leaseId: "lease" })).toEqual({
      requestId: "request",
      leaseId: "lease",
    });
    expect(parseAgentApplyAuthorization({ leaseId: "lease", approvedAt: "2026-10-03T00:00:00.000Z" })).toEqual({
      leaseId: "lease",
      approvedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(parseAgentReceiptRequest({ requestId: "request" })).toEqual({ requestId: "request" });
    expect(() => parseAgentReceiptRequest({ requestId: "request", operationId: "operation" })).toThrow();
    expect(
      parseAgentStatusResponse({
        socketPath: "~/.config/omni/agent.sock",
        tokenCreatedAt: "2026-09-14T00:00:00.000Z",
        counts: { pending: 1, today: 2, total: 3 },
      }),
    ).toMatchObject({ counts: { pending: 1, today: 2, total: 3 } });
  });

  it("reads strict additive apply outcomes while accepting legacy stored requests", () => {
    const legacy = {
      requestId: "request",
      createdAt: "2026-09-14T00:00:00.000Z",
      expiresAt: "2026-09-14T00:10:00.000Z",
      request: { kind: "make-compatible", sourceId: "source", harness: "codex" },
      plan: {
        planId: "plan",
        kind: "make-compatible",
        displayTarget: "target",
        actions: [],
        git: { mode: "not-a-repository", warnings: [] },
      },
      approval: "omni",
      status: "approved",
      receiptId: "legacy-receipt",
    };
    expect(parseAgentMutationResponse(legacy)).toMatchObject({ receiptId: "legacy-receipt" });
    expect(
      parseAgentMutationResponse({
        ...legacy,
        receiptIds: ["first", "second"],
        receiptId: "second",
        applyOutcome: { status: "failed", message: "Second project failed." },
      }),
    ).toMatchObject({
      receiptIds: ["first", "second"],
      applyOutcome: { status: "failed", message: "Second project failed." },
    });
    expect(() =>
      parseAgentMutationResponse({
        ...legacy,
        receiptIds: ["first", "first"],
        applyOutcome: { status: "failed" },
      }),
    ).toThrow(/unique/i);
    expect(() =>
      parseAgentMutationResponse({
        ...legacy,
        receiptIds: ["first"],
        applyOutcome: { status: "failed", message: "bad\nmessage" },
      }),
    ).toThrow(/message/i);
    expect(
      parseAgentMutationResponse({
        ...legacy,
        status: "approved",
        receiptId: undefined,
        receiptIds: [],
        applyOutcome: { status: "no-op" },
      }),
    ).toMatchObject({ receiptIds: [], applyOutcome: { status: "no-op" } });
  });

  it("parses pending propagation plans and distinguishes unknown kinds from invalid Git state", () => {
    const pending = {
      requestId: "propagation-request",
      createdAt: "2026-10-11T00:00:00.000Z",
      expiresAt: "2026-10-11T00:10:00.000Z",
      approval: "omni",
      status: "pending",
      request: {
        kind: "maintain-current",
        source: { sourceId: "source", packageId: "packages/tools", artifactPath: "skills/demo" },
      },
      plan: {
        planId: "propagation-plan",
        kind: "propagate-skill",
        displayTarget: "Demo",
        actions: [],
        git: { mode: "not-a-repository", warnings: [] },
      },
    };
    expect(parseAgentMutationResponse(pending).plan.kind).toBe("propagate-skill");
    expect(() => parseAgentMutationResponse({ ...pending, plan: { ...pending.plan, kind: "unknown" } })).toThrow(
      "Operation plan kind is invalid.",
    );
    expect(() =>
      parseAgentMutationResponse({ ...pending, plan: { ...pending.plan, git: { warnings: false } } }),
    ).toThrow("Operation plan Git state is invalid.");
  });

  it("registers handlers that list and rotate agent state", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "omni-agent-ipc-"));
    roots.push(userDataPath);
    const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
    vi.doMock("electron", () => ({
      ipcMain: {
        handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
          handlers.set(channel, handler),
      },
    }));
    const { registerAgentIpcHandlers } = await import("../../src/main/agent-gateway/ipc");
    const { createAgentRequestsStore } = await import("../../src/main/agent-gateway/requests-store");
    const { createAgentTokenManager } = await import("../../src/main/agent-gateway/auth");
    const { AGENTS_IPC_CHANNELS } = await import("../../src/shared/agents-ipc");
    const cliPath = join(userDataPath, "cli.js");
    await writeFile(cliPath, "cli");
    const requests = createAgentRequestsStore(join(userDataPath, "omni/agent-requests.json"));
    const refresh = vi.fn(async (requestId: string) => ({ requestId }) as never);
    registerAgentIpcHandlers(() => undefined, {
      refreshAgentRequest: refresh,
      requests,
      tokenManager: createAgentTokenManager(userDataPath),
      socketPath: "~/.omni/agent.sock",
      userDataPath,
      homeDir: userDataPath,
      cliPath,
      lastSeen: {
        lastSeen: async () => ({ "claude-code": "2026-09-14T00:00:00.000Z", codex: undefined }),
        record: async () => undefined,
      },
    });
    await expect(handlers.get(AGENTS_IPC_CHANNELS.list)?.({}, {})).resolves.toMatchObject({
      status: "ready",
      requests: [],
    });
    await expect(handlers.get(AGENTS_IPC_CHANNELS.rotateToken)?.({}, {})).resolves.toMatchObject({
      socketPath: "~/.omni/agent.sock",
      counts: { total: 0 },
      harnesses: [
        {
          harness: "claude-code",
          detected: false,
          registered: false,
          settingsPath: "~/.claude.json",
          skillsPath: "~/.claude/skills",
          current: false,
          skills: expect.any(Array),
          lastSeenAt: "2026-09-14T00:00:00.000Z",
        },
        { harness: "codex", registered: false, settingsPath: "~/.codex/config.toml", current: false },
      ],
    });
    const pending = await requests.create({
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
    await expect(handlers.get(AGENTS_IPC_CHANNELS.refresh)?.({}, { requestId: pending.requestId })).resolves.toEqual({
      requestId: pending.requestId,
    });
    expect(refresh).toHaveBeenCalledWith(pending.requestId);
    await expect(
      handlers.get(AGENTS_IPC_CHANNELS.refresh)?.({}, { requestId: pending.requestId, extra: true }),
    ).rejects.toThrow(/unexpected field/i);
    const authorization = await handlers.get(AGENTS_IPC_CHANNELS.beginApply)?.({}, { requestId: pending.requestId });
    expect(authorization).toMatchObject({ leaseId: expect.any(String), approvedAt: expect.any(String) });
    const lease = authorization as { leaseId: string; approvedAt: string };
    await expect(handlers.get(AGENTS_IPC_CHANNELS.decline)?.({}, { requestId: pending.requestId })).rejects.toThrow(
      /in progress/i,
    );
    await expect(
      handlers.get(AGENTS_IPC_CHANNELS.resolve)?.(
        {},
        {
          requestId: pending.requestId,
          operationIds: ["receipt-one", "receipt-two"],
          outcome: { status: "failed", message: "Second project failed." },
          approvedAt: lease.approvedAt,
          leaseId: lease.leaseId,
        },
      ),
    ).resolves.toMatchObject({
      status: "approved",
      receiptId: "receipt-two",
      receiptIds: ["receipt-one", "receipt-two"],
      applyOutcome: { status: "failed", message: "Second project failed." },
      consent: { mode: "omni", harness: "codex", at: lease.approvedAt },
    });
    await expect(
      handlers.get(AGENTS_IPC_CHANNELS.endApply)?.({}, { requestId: pending.requestId, leaseId: lease.leaseId }),
    ).resolves.toBeUndefined();
  });
});
