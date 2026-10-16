import { observedPackages } from "./agent-gateway-helpers";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { createAgentRouter } from "../../src/main/agent-gateway/router";
import type { AgentPlan } from "../../src/shared/agents-ipc";
import type { OperationReceipt } from "../../src/shared/operations-ipc";
import { createAgentTestRoot } from "./agent-gateway-helpers";

const roots: string[] = [];
const NOW = Date.parse("2026-09-14T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.useRealTimers();
});

describe("agent gateway consent", () => {
  it("applies a conversation-approved skill once and records consent", async () => {
    const userDataPath = await createAgentTestRoot(roots);
    const requests = createAgentRequestsStore(join(userDataPath, "omni", "agent-requests.json"), () => NOW);
    const plan: AgentPlan = {
      planId: "conversation-plan",
      kind: "write-skill",
      displayTarget: "personal",
      actions: [{ kind: "write-file", relativePath: "SKILL.md", byteLength: 8 }],
      git: { mode: "not-a-repository", warnings: [] },
    };
    const receipts: OperationReceipt[] = [];
    const receipt: OperationReceipt = {
      operationId: "conversation-receipt",
      kind: "write-skill",
      status: "applied",
      appliedAt: "2026-09-14T00:00:00.000Z",
      displayTarget: "personal",
      actions: [{ kind: "write-file", relativePath: "SKILL.md", byteLength: 8, status: "applied" }],
      git: { mode: "not-a-repository" },
      registered: null,
    };
    const scope = { sourceId: "personal", packageId: "personal", targets: [] as const };
    const managedPreview = {
      status: "ready" as const,
      intentId: "conversation-intent",
      planId: plan.planId,
      effectFingerprint: "a".repeat(64),
      scope,
      steps: [{ stepId: "source", scope, plan, bindingEffects: [], files: [] }],
    };
    const appliedReceipt = {
      ...receipt,
      provenance: {
        approval: "conversation" as const,
        agent: {
          harness: "claude-code" as const,
          sessionName: "session-one",
          requestedAt: new Date(NOW).toISOString(),
        },
      },
    };
    const managedResult = {
      intentId: managedPreview.intentId,
      operationId: managedPreview.intentId,
      status: "applied" as const,
      source: { status: "created" as const, sourceId: "personal" },
      targets: [],
      receiptIds: [receipt.operationId],
      receipts: [appliedReceipt],
      issues: [],
      recoveryAvailable: false,
    };
    const skillManagement = {
      initialize: vi.fn(async () => undefined),
      preview: vi.fn(async () => managedPreview),
      refresh: vi.fn(async () => managedPreview),
      apply: vi.fn(async () => {
        receipts.push(appliedReceipt);
        return managedResult;
      }),
      readResult: vi.fn(async () => (receipts.length ? managedResult : undefined)),
    };
    const operations = { skillManagement };
    const router = createAgentRouter({
      userDataPath,
      registry: {
        observeRegisteredEntry: async () => observedPackages("personal"),
        listRegistry: async () => ({
          status: "ready" as const,
          registry: {
            observeRegisteredEntry: async () => observedPackages("personal"),
            revision: 1,
            projects: [],
            sources: [{ ref: { kind: "source", id: "personal" }, ownership: "personal" }],
          },
        }),
      } as never,
      bindings: {} as never,
      operations: operations as never,
      requests,
      operationStore: { read: async () => ({ status: "ready" as const, receipts }) } as never,
      now: () => NOW,
    });
    const preview = (await router.handle(
      "preview_create_skill",
      {
        sourceId: "personal",
        packageId: "personal",
        name: "conversation-skill",
        description: "Use for conversation approval tests.",
        body: "# Skill\n",
        reason: "Test conversation approval.",
      },
      { name: "test", version: "1", harness: "claude-code", sessionName: "session-one" },
    )) as { requestId: string; approval: string };
    expect(preview.approval).toBe("conversation");

    const applied = await router.handle(
      "apply",
      { requestId: preview.requestId },
      { name: "test", version: "1", harness: "claude-code", sessionName: "session-one" },
    );
    expect(applied).toMatchObject({ status: "applied", receipts: [{ provenance: { approval: "conversation" } }] });
    expect(await requests.get(preview.requestId)).toMatchObject({
      status: "approved",
      receiptId: "conversation-receipt",
      consent: { mode: "conversation", harness: "claude-code", sessionName: "session-one" },
    });
    await router.handle(
      "apply",
      { requestId: preview.requestId },
      { name: "test", version: "1", harness: "claude-code", sessionName: "session-one" },
    );
    expect(skillManagement.apply).toHaveBeenCalledOnce();
  });

  it("returns stale when a restarted preview no longer matches", async () => {
    const userDataPath = await createAgentTestRoot(roots);
    const requests = createAgentRequestsStore(join(userDataPath, "omni", "agent-requests.json"), () => NOW);
    const firstPlan: AgentPlan = {
      planId: "stale-plan",
      kind: "write-skill",
      displayTarget: "personal",
      actions: [{ kind: "write-file", relativePath: "SKILL.md", beforeHash: "before-a", byteLength: 8 }],
      git: { mode: "not-a-repository", warnings: [] },
    };
    const changedPlan: AgentPlan = {
      ...firstPlan,
      planId: "fresh-plan",
      actions: [{ kind: "write-file", relativePath: "SKILL.md", beforeHash: "before-b", byteLength: 8 }],
    };
    const scope = { sourceId: "personal", packageId: "personal", targets: [] as const };
    const managedPreview = {
      status: "ready" as const,
      intentId: "stale-intent",
      planId: firstPlan.planId,
      effectFingerprint: "b".repeat(64),
      scope,
      steps: [{ stepId: "source", scope, plan: firstPlan, bindingEffects: [], files: [] }],
    };
    const skillManagement = {
      initialize: vi.fn(async () => undefined),
      preview: vi.fn(async () => managedPreview),
      refresh: vi.fn(async () => ({
        status: "stale" as const,
        intentId: managedPreview.intentId,
        reason: "The operation changed; preview again before applying.",
        details: [],
      })),
      apply: vi.fn(),
      readResult: vi.fn(async () => undefined),
    };
    const router = createAgentRouter({
      userDataPath,
      registry: {
        observeRegisteredEntry: async () => observedPackages("personal"),
        listRegistry: async () => ({
          status: "ready" as const,
          registry: {
            observeRegisteredEntry: async () => observedPackages("personal"),
            revision: 1,
            projects: [],
            sources: [{ ref: { kind: "source", id: "personal" }, ownership: "personal" }],
          },
        }),
      } as never,
      bindings: {} as never,
      operations: { skillManagement } as never,
      requests,
      operationStore: { read: async () => ({ status: "ready" as const, receipts: [] }) } as never,
      now: () => NOW,
    });
    const preview = (await router.handle(
      "preview_create_skill",
      {
        sourceId: "personal",
        packageId: "personal",
        name: "stale-skill",
        description: "Use for stale plan tests.",
        body: "# Skill\n",
        reason: "Test stale plans.",
      },
      { name: "test", version: "1", harness: "claude-code" },
    )) as { requestId: string };
    await expect(
      router.handle("apply", { requestId: preview.requestId }, { name: "test", version: "1" }),
    ).resolves.toEqual({
      status: "stale",
      message: "The files changed; preview again.",
      details: [],
    });
  });

  it("requires saved legacy assignments to be previewed through the managed service", async () => {
    const userDataPath = await createAgentTestRoot(roots);
    const requests = createAgentRequestsStore(join(userDataPath, "omni", "agent-requests.json"), () => NOW);
    const binding = {
      bindingId: "binding-one",
      sourceId: "personal",
      packageId: "pkg",
      artifactPath: "skills/example",
      kind: "skill" as const,
      projectId: "project-one",
      harnessId: "claude-code" as const,
      boundHash: "hash",
      createdAt: "2026-09-14T00:00:00.000Z",
    };
    const operations = {
      previewOperation: vi.fn(async () => ({
        status: "ready" as const,
        plan: {
          planId: "apply-plan",
          kind: "apply-plan" as const,
          displayTarget: "project-one",
          actions: [],
          git: { mode: "not-a-repository" as const, warnings: [] },
        },
      })),
      applyOperation: vi.fn(async () => ({
        status: "applied" as const,
        receipt: {
          operationId: "assignment-receipt",
          kind: "apply-plan" as const,
          status: "applied" as const,
          appliedAt: "2026-09-14T00:00:00.000Z",
          displayTarget: "project-one",
          actions: [],
          git: { mode: "not-a-repository" as const },
          registered: null,
        },
      })),
    };
    const bindings = { saveBindings: vi.fn(async () => ({ status: "ready" as const, bindings: [binding] })) };
    const request = await requests.create({
      request: {
        kind: "assign",
        artifactPath: "skills/example",
        sourceId: "personal",
        packageId: "pkg",
        projectIds: ["project-one"],
      },
      plan: {
        kind: "assign",
        bindings: [binding],
        plans: [{ projectId: "project-one", planId: "preview", status: "ready", actions: [] }],
      },
      approval: "conversation",
      harness: "claude-code",
    });
    const router = createAgentRouter({
      userDataPath,
      registry: {} as never,
      bindings: bindings as never,
      operations: operations as never,
      requests,
      operationStore: { read: async () => ({ status: "ready" as const, receipts: [] }) } as never,
      now: () => NOW,
    });
    await expect(
      router.handle("apply", { requestId: request.requestId }, { name: "test", version: "1" }),
    ).resolves.toEqual({
      status: "stale",
      message: "This saved assignment predates managed skill operations. Preview it again before applying.",
    });
    expect(bindings.saveBindings).not.toHaveBeenCalled();
    await expect(
      router.handle("apply", { requestId: request.requestId }, { name: "test", version: "1" }),
    ).resolves.toEqual({
      status: "stale",
      message: "This saved assignment predates managed skill operations. Preview it again before applying.",
    });
    expect(bindings.saveBindings).not.toHaveBeenCalled();
    expect(operations.applyOperation).not.toHaveBeenCalled();
  });
});
