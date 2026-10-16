import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { createAgentRequestRefresher } from "../../src/main/agent-gateway/refresh-request";
import { createAgentApply } from "../../src/main/agent-gateway/router-apply";
import { createAgentReceiptReader } from "../../src/main/agent-gateway/router-receipt";
import type { AgentPlan, AgentWriteRequest } from "../../src/shared/agents-ipc";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES } from "../../src/shared/settings-ipc";

const roots: string[] = [];
const settings = {
  schemaVersion: 8 as const,
  git: { commitChanges: false },
  ai: DEFAULT_AI_SETTINGS,
  features: DEFAULT_FEATURES,
  externalLibrary: { updates: "auto" as const },
  agents: {
    approval: { projects: "conversation" as const, personalMarketplace: "conversation" as const },
    guard: { warnProjectIds: [] },
  },
};
const plan: AgentPlan = {
  kind: "make-compatible",
  planId: "old",
  displayTarget: "personal",
  actions: [],
  git: { mode: "disabled", warnings: [] },
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-agent-refresh-"));
  roots.push(root);
  const requests = createAgentRequestsStore(join(root, "requests.json"));
  const registry = {
    listRegistry: async () => ({
      status: "ready",
      registry: { sources: [{ ref: { id: "personal" }, ownership: "personal" }] },
    }),
  } as never;
  const request = await requests.create({
    request: { kind: "make-compatible", sourceId: "personal", harness: "codex" },
    plan,
  });
  return { requests, registry, request };
}
it("refreshes legacy effects on the original pending request and recalculates the deletion reason", async () => {
  const { requests, registry, request } = await fixture();
  const fresh: AgentPlan = { ...plan, planId: "fresh", actions: [{ kind: "delete-file", relativePath: "old.md" }] };
  const refresh = createAgentRequestRefresher({
    requests,
    registry,
    settings: { read: async () => settings } as never,
    service: {} as never,
    previewPlan: async () => fresh,
  });
  expect(await refresh(request.requestId)).toMatchObject({
    requestId: request.requestId,
    status: "pending",
    plan: fresh,
    approvalReason: { code: "deletes-files", count: 1 },
  });
  expect(await requests.list()).toHaveLength(1);
});
it("replaces a stale managed intent, keeps explicit Omni approval, and resolves the original waiting agent", async () => {
  const { requests, registry } = await fixture();
  const input = {
    kind: "write-skill" as const,
    sourceId: "personal",
    packageId: "packages/tools",
    mode: "create" as const,
    folderName: "demo",
    files: [{ path: "SKILL.md", content: "# Demo\n" }],
  };
  const skillIntent = { kind: "write" as const, request: input };
  const request = await requests.create({
    request: input,
    plan,
    intentId: "old-intent",
    skillIntent,
    approvalReason: { code: "asked-in-omni" },
    harness: "codex",
    sessionName: "session",
  });
  const fresh = { ...plan, planId: "fresh", kind: "write-skill" as const };
  const service = {
    refresh: vi.fn(async () => ({ status: "stale" })),
    preview: vi.fn(async () => ({
      status: "ready",
      intentId: "new-intent",
      planId: "fresh",
      effectFingerprint: "a".repeat(64),
      scope: { sourceId: "personal", targets: [] },
      steps: [{ plan: fresh, scope: { sourceId: "personal", targets: [] } }],
    })),
    readResult: vi.fn(async () => undefined),
  };
  const refresh = createAgentRequestRefresher({
    requests,
    registry,
    settings: { read: async () => settings } as never,
    service: service as never,
    previewPlan: vi.fn(),
  });
  const receipts = [
    {
      operationId: "new-intent",
      kind: "write-skill",
      status: "applied",
      appliedAt: new Date().toISOString(),
      actions: [],
      git: { mode: "disabled" },
      displayTarget: "personal",
      registered: null,
    },
  ];
  const operationStore = { read: async () => ({ status: "ready", receipts }) } as never;
  const receipt = createAgentReceiptReader(requests, operationStore);
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const apply = createAgentApply({
    requests: {
      ...requests,
      wait: (id, ms) => {
        const waiting = requests.wait(id, ms);
        started();
        return waiting;
      },
    },
    operations: {} as never,
    skillManagement: service as never,
    operationStore,
    previewPlan: vi.fn(),
    receipt: (item) => receipt({ requestId: item.requestId }),
    now: Date.now,
  });
  const waiting = apply({ requestId: request.requestId, waitMs: 50000 }, {} as never);
  await entered;
  expect(await refresh(request.requestId)).toMatchObject({
    requestId: request.requestId,
    intentId: "new-intent",
    skillIntent,
    approvalReason: { code: "asked-in-omni" },
  });
  expect(service.preview).toHaveBeenCalledWith(skillIntent, {
    kind: "mcp",
    requestId: request.requestId,
    harness: "codex",
    sessionName: "session",
  });
  const lease = await requests.acquireApplyAuthorization(request.requestId);
  await requests.recordApplyOutcome(
    request.requestId,
    ["receipt"],
    { status: "applied" },
    { mode: "omni", at: lease.approvedAt, harness: "codex", sessionName: "session" },
    lease.leaseId,
  );
  expect(await waiting).toMatchObject({ status: "applied", receipt: { operationId: "new-intent" } });
  expect(await receipt({ requestId: request.requestId })).toMatchObject({ status: "found" });
});
it("does not resurrect a declined request if it changes while recomputing", async () => {
  const { requests, registry, request } = await fixture();
  const refresh = createAgentRequestRefresher({
    requests,
    registry,
    settings: { read: async () => settings } as never,
    service: {} as never,
    previewPlan: async () => {
      await requests.decline(request.requestId);
      return plan;
    },
  });
  await expect(refresh(request.requestId)).rejects.toThrow("Only pending requests can be refreshed.");
  expect(await requests.get(request.requestId)).toMatchObject({ status: "declined" });
});
it("refuses an apply lease but accepts refreshes after the request was relinked", async () => {
  const { requests, request } = await fixture();
  const lease = await requests.acquireApplyAuthorization(request.requestId);
  await expect(requests.refresh(request.requestId, { plan })).rejects.toThrow(/in progress/);
  await requests.releaseApplyAuthorization(request.requestId, lease.leaseId);
  await requests.refresh(request.requestId, { plan: { ...plan, planId: "changed" } });
  await expect(requests.refresh(request.requestId, { plan })).resolves.toMatchObject({ plan });
});

it("refreshes project-only removal using project settings and excludes intentional deletions", async () => {
  const { requests, registry } = await fixture();
  const skillIntent = { kind: "remove" as const, bindingIds: ["binding"] };
  const request = await requests.create({
    request: { kind: "remove-skill", bindingIds: ["binding"] },
    plan,
    intentId: "old-intent",
    skillIntent,
    approvalReason: { code: "deletes-files", count: 1 },
  });
  const scope = { sourceId: "personal", targets: [{ projectId: "project", harnessId: "codex" }] };
  const fresh = { ...plan, kind: "remove-binding", actions: [{ kind: "delete-file", relativePath: "SKILL.md" }] };
  const refresh = createAgentRequestRefresher({
    requests,
    registry,
    settings: {
      read: async () => ({
        ...settings,
        agents: { ...settings.agents, approval: { projects: "conversation", personalMarketplace: "omni" } },
      }),
    } as never,
    service: {
      refresh: async () => ({ status: "stale" }),
      preview: async () => ({ status: "ready", intentId: "fresh", scope, steps: [{ plan: fresh, scope }] }),
    } as never,
    previewPlan: vi.fn(),
  });
  const refreshed = await refresh(request.requestId);
  expect(refreshed).toMatchObject({ requestId: request.requestId, status: "pending", intentId: "fresh", plan: fresh });
  expect(refreshed.approvalReason).toBeUndefined();
});

it.each(["make-compatible", "import-artifact", "assign"] as const)(
  "shares concurrent %s refreshes and allows a retry after failure",
  async (kind) => {
    const { requests, registry } = await fixture();
    const input: AgentWriteRequest =
      kind === "make-compatible"
        ? { kind, sourceId: "personal", harness: "codex" }
        : kind === "assign"
          ? {
              kind,
              sourceId: "personal",
              packageId: "packages/tools",
              artifactPath: "skills/demo",
              projectIds: ["project"],
            }
          : {
              kind,
              projectId: "project",
              relativePath: ".agents/skills/demo",
              target: { packageId: "packages/tools" },
            };
    const refreshedPlan: AgentPlan = kind === "assign" ? { kind, plans: [] } : { ...plan, kind };
    const request = await requests.create({ request: input, plan: refreshedPlan });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let complete!: (value: AgentPlan) => void;
    const previewPlan = vi.fn(
      () =>
        new Promise<AgentPlan>((resolve) => {
          complete = resolve;
          entered();
        }),
    );
    const refresh = createAgentRequestRefresher({
      requests,
      registry,
      settings: { read: async () => settings } as never,
      service: {} as never,
      previewPlan,
    });
    const first = refresh(request.requestId);
    const second = refresh(request.requestId);
    await started;
    expect(previewPlan).toHaveBeenCalledTimes(1);
    complete(refreshedPlan);
    const results = await Promise.all([first, second]);
    expect(results[0]).toBe(results[1]);
    previewPlan.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(refresh(request.requestId)).rejects.toThrow("Unavailable");
    previewPlan.mockResolvedValueOnce(refreshedPlan);
    await expect(refresh(request.requestId)).resolves.toMatchObject({ plan: refreshedPlan });
  },
);

it.each(["stale", "unavailable"])(
  "shares %s managed refreshes and retains the linked intent on subsequent fresh refreshes",
  async (state) => {
    const { requests, registry } = await fixture();
    const input = {
      kind: "write-skill" as const,
      sourceId: "personal",
      packageId: "packages/tools",
      mode: "create" as const,
      folderName: "demo",
      files: [{ path: "SKILL.md", content: "# Demo" }],
    };
    const request = await requests.create({
      request: input,
      plan,
      skillIntent: { kind: "write", request: input },
      intentId: "old",
    });
    const ready = {
      status: "ready",
      intentId: "new",
      scope: { sourceId: "personal", targets: [] },
      steps: [{ plan, scope: { sourceId: "personal", targets: [] } }],
    };
    const service = {
      refresh: vi
        .fn()
        .mockResolvedValueOnce(
          state === "stale" ? { status: "stale" } : { status: "blocked", details: [{ code: "intent-unavailable" }] },
        )
        .mockResolvedValue(ready),
      preview: vi.fn().mockResolvedValue(ready),
    };
    const storeRefresh = vi.spyOn(requests, "refresh");
    const refresh = createAgentRequestRefresher({
      requests,
      registry,
      settings: { read: async () => settings } as never,
      service: service as never,
      previewPlan: vi.fn(),
    });
    const [first, second] = await Promise.all([refresh(request.requestId), refresh(request.requestId)]);
    expect(first).toBe(second);
    expect(first.intentId).toBe("new");
    expect(service.preview).toHaveBeenCalledTimes(1);
    expect(await refresh(request.requestId)).toEqual(first);
    expect(service.refresh).toHaveBeenLastCalledWith("new", expect.objectContaining({ requestId: request.requestId }));
    expect(service.preview).toHaveBeenCalledTimes(1);
    expect(storeRefresh).toHaveBeenCalledTimes(1);
  },
);
