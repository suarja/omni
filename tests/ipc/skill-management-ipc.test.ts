import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseSkillActor,
  parseSkillIntent,
  parseSkillManagementApplyRequest,
  parseSkillPreview,
} from "../../src/shared/skill-management-ipc";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("electron");
});

describe("skill management IPC boundary", () => {
  it("reads project skills only for a trusted sender with a valid project request and response", async () => {
    type Handler = (event: { trusted?: boolean }, request: unknown) => Promise<unknown>;
    const handlers = new Map<string, Handler>();
    vi.doMock("electron", () => ({
      ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    }));
    const { registerSkillManagementIpcHandlers } = await import("../../src/main/skill-management/ipc");
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
    const view = {
      projectId: "project-a",
      skills: [],
      activeSkillCount: { "claude-code": 0, codex: 0 },
      startupCost: { "claude-code": 0, codex: 0 },
      diagnostics: [],
    };
    const readProjectSkills = vi.fn(async () => view);
    registerSkillManagementIpcHandlers(
      (event) => {
        if (!(event as { trusted?: boolean }).trusted) throw new Error("Untrusted renderer.");
      },
      { readProjectSkills } as never,
    );
    const handler = handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.projectSkills)!;
    await expect(handler({}, { projectId: "project-a" })).rejects.toThrow(/untrusted/i);
    await expect(handler({ trusted: true }, { projectId: "../project" })).rejects.toThrow();
    await expect(handler({ trusted: true }, { projectId: "project-a", force: true })).rejects.toThrow();
    expect(readProjectSkills).not.toHaveBeenCalled();
    await expect(handler({ trusted: true }, { projectId: "project-a" })).resolves.toEqual(view);
    expect(readProjectSkills).toHaveBeenCalledWith("project-a");
    readProjectSkills.mockResolvedValueOnce({ ...view, startupCost: { "claude-code": -1, codex: 0 } });
    await expect(handler({ trusted: true }, { projectId: "project-a" })).rejects.toThrow();
  });

  it("accepts explicit child and package target selections with registered IDs only", () => {
    expect(
      parseSkillIntent({
        kind: "assign",
        sourceId: "personal-source",
        packageId: "packages/tools",
        artifactPath: "skills/release-notes/SKILL.md",
        targets: [{ projectId: "project-a", harnessIds: ["codex", "claude-code"] }],
      }),
    ).toEqual({
      kind: "assign",
      sourceId: "personal-source",
      packageId: "packages/tools",
      artifactPath: "skills/release-notes/SKILL.md",
      targets: [{ projectId: "project-a", harnessIds: ["codex", "claude-code"] }],
    });
  });

  it("rejects unexpected fields, duplicate IDs, empty selections, unsupported harnesses, and unsafe paths", () => {
    expect(() => parseSkillIntent({ kind: "remove", bindingIds: ["binding-a"], force: true })).toThrow(
      /unexpected field/u,
    );
    expect(() => parseSkillIntent({ kind: "remove", bindingIds: ["binding-a", "binding-a"] })).toThrow(/unique/u);
    expect(() => parseSkillIntent({ kind: "remove", bindingIds: [] })).toThrow(/non-empty/u);
    expect(() =>
      parseSkillIntent({
        kind: "assign",
        sourceId: "source-a",
        packageId: "packages/tools",
        targets: [{ projectId: "project-a", harnessIds: ["bash"] }],
      }),
    ).toThrow(/Harness/u);
    expect(() =>
      parseSkillIntent({
        kind: "assign",
        sourceId: "source-a",
        packageId: "../outside",
        targets: [{ projectId: "project-a", harnessIds: ["codex"] }],
      }),
    ).toThrow(/relative/u);
  });

  it("retains the existing write file and text-size limits", () => {
    const request = {
      kind: "write" as const,
      request: {
        kind: "write-skill" as const,
        sourceId: "source-a",
        packageId: "packages/tools",
        mode: "create" as const,
        folderName: "release-notes",
        files: [
          { path: "SKILL.md", content: "# A\n" },
          { path: "reference.md", content: "x".repeat(256 * 1024) },
        ],
      },
    };
    expect(() => parseSkillIntent(request)).toThrow(/too large/u);
  });

  it("accepts exact maintenance locations and rejects ambiguous or extra target fields", () => {
    const intent = {
      kind: "maintain-current",
      source: { sourceId: "source-a", packageId: "packages/tools", artifactPath: "skills/tool" },
      locations: [{ projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/tool" }],
    };
    expect(parseSkillIntent(intent)).toMatchObject({ kind: "maintain-current", source: intent.source });
    expect(parseSkillIntent({ kind: "maintain-current", source: intent.source }).kind).toBe("maintain-current");
    expect(() => parseSkillIntent({ ...intent, skillId: "skill-a" })).toThrow(/unexpected field/u);
    expect(() =>
      parseSkillIntent({
        ...intent,
        locations: [
          ...intent.locations,
          { projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/tool" },
        ],
      }),
    ).toThrow(/unique/u);
    expect(() =>
      parseSkillIntent({
        ...intent,
        locations: [{ ...intent.locations[0], root: "/tmp" }],
      }),
    ).toThrow(/unexpected field/u);
  });

  it("parses and validates complete-tree propagation preview summaries", () => {
    const preview = {
      status: "ready",
      intentId: "intent-a",
      planId: "plan-a",
      effectFingerprint: "a".repeat(64),
      scope: {
        sourceId: "source-a",
        packageId: "packages/tools",
        artifactPath: "skills/tool",
        targets: [],
      },
      steps: [],
      propagation: {
        mode: "maintain-current",
        source: { sourceId: "source-a", packageId: "packages/tools", artifactPath: "skills/tool" },
        targets: [
          {
            skillId: "skill-a",
            location: { projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/tool" },
            bindingId: "binding-a",
            state: "eligible",
            files: [
              { path: "assets/icon.bin", state: "change", beforeHash: "b".repeat(64), afterHash: "c".repeat(64) },
            ],
          },
        ],
      },
    };
    expect(parseSkillPreview(preview)).toMatchObject({
      propagation: { targets: [{ skillId: "skill-a", state: "eligible", files: [{ path: "assets/icon.bin" }] }] },
    });
    const { skillId: _skillId, ...targetWithoutSkillId } = preview.propagation.targets[0]!;
    expect(() =>
      parseSkillPreview({
        ...preview,
        propagation: { ...preview.propagation, targets: [targetWithoutSkillId] },
      }),
    ).toThrow(/logical skill id/u);
    expect(() =>
      parseSkillPreview({
        ...preview,
        propagation: {
          ...preview.propagation,
          targets: [{ ...preview.propagation.targets[0], files: [{ path: "../escape", state: "change" }] }],
        },
      }),
    ).toThrow(/relative/u);
  });

  it("validates authorization fingerprints and response DTOs", () => {
    expect(() => parseSkillManagementApplyRequest({ intentId: "intent-a", effectFingerprint: "not-a-hash" })).toThrow(
      /fingerprint/u,
    );
    expect(() => parseSkillActor({ kind: "mcp", requestId: "request-a", approved: true })).toThrow(/unexpected field/u);
    expect(
      parseSkillPreview({
        status: "ready",
        intentId: "intent-a",
        planId: "plan-a",
        effectFingerprint: "a".repeat(64),
        scope: { sourceId: "source-a", packageId: "packages/tools", targets: [] },
        steps: [],
      }),
    ).toMatchObject({ status: "ready", intentId: "intent-a" });
  });

  it("registers trusted desktop handlers, validates DTOs, and sends explicit consent to the service", async () => {
    type Handler = (event: { trusted?: boolean }, request: unknown) => Promise<unknown>;
    const handlers = new Map<string, Handler>();
    vi.doMock("electron", () => ({
      ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    }));
    const { registerSkillManagementIpcHandlers } = await import("../../src/main/skill-management/ipc");
    const preview = { status: "blocked" as const, intentId: "intent-a", reason: "Needs attention", details: [] };
    const result = {
      intentId: "intent-a",
      operationId: "intent-a",
      status: "no-op" as const,
      source: { status: "unchanged" as const },
      targets: [],
      receiptIds: [],
      issues: [],
      recoveryAvailable: false,
    };
    const service = {
      initialize: vi.fn(async () => undefined),
      preview: vi.fn(async () => preview),
      refresh: vi.fn(async () => preview),
      apply: vi.fn(async () => result),
      readResult: vi.fn(async () => result),
    };
    const authorizeSender = vi.fn((event: { trusted?: boolean }) => {
      if (!event.trusted) throw new Error("Untrusted renderer.");
    });
    registerSkillManagementIpcHandlers(authorizeSender as never, service as never);
    const channels = (await import("../../src/shared/skill-management-ipc")).SKILL_MANAGEMENT_IPC_CHANNELS;
    const handler = handlers.get(channels.preview);
    expect(handler).toBeDefined();
    await expect(
      handler!(
        {},
        {
          intent: {
            kind: "write",
            request: {
              kind: "write-skill",
              sourceId: "source-a",
              packageId: "packages/tools",
              mode: "create",
              folderName: "demo",
              files: [{ path: "SKILL.md", content: "# Demo" }],
            },
          },
        },
      ),
    ).rejects.toThrow(/untrusted/i);
    await expect(
      handler!({ trusted: true }, { intent: { kind: "remove", bindingIds: ["binding-a"] }, force: true }),
    ).rejects.toThrow(/unexpected field/i);
    await expect(
      handler!({ trusted: true }, { intent: { kind: "remove", bindingIds: ["binding-a"] } }),
    ).resolves.toEqual(preview);
    const applyHandler = handlers.get(channels.apply);
    await expect(
      applyHandler!({ trusted: true }, { intentId: "intent-a", effectFingerprint: "a".repeat(64) }),
    ).resolves.toEqual(result);
    expect(service.apply).toHaveBeenCalledWith("intent-a", {
      kind: "desktop",
      effectFingerprint: "a".repeat(64),
      approvedAt: expect.any(String),
    });
    expect(authorizeSender).toHaveBeenCalledTimes(4);
  });

  it("does not let a connected agent request widen its previewed write", async () => {
    type Handler = (event: unknown, request: unknown) => Promise<unknown>;
    const handlers = new Map<string, Handler>();
    vi.doMock("electron", () => ({
      ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    }));
    const { registerSkillManagementIpcHandlers } = await import("../../src/main/skill-management/ipc");
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
    const request = {
      kind: "write-skill" as const,
      sourceId: "source-a",
      packageId: "packages/tools",
      mode: "update" as const,
      folderName: "demo",
      files: [{ path: "SKILL.md", content: "# Demo" }],
    };
    const pending = { requestId: "request-a", request, status: "pending", approval: "conversation" };
    const service = {
      initialize: vi.fn(async () => undefined),
      preview: vi.fn(async () => ({
        status: "blocked" as const,
        intentId: "intent-a",
        reason: "Blocked",
        details: [],
      })),
      refresh: vi.fn(async () => ({
        status: "blocked" as const,
        intentId: "intent-a",
        reason: "Blocked",
        details: [],
      })),
      apply: vi.fn(),
      readResult: vi.fn(),
    };
    registerSkillManagementIpcHandlers(() => undefined, service as never, { get: vi.fn(async () => pending) } as never);
    const preview = handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!;
    await expect(
      preview(
        {},
        {
          requestId: "request-a",
          intent: { kind: "write", request: { ...request, replaceFolder: true } },
        },
      ),
    ).rejects.toThrow(/does not match this draft/i);
    await preview({}, { requestId: "request-a", intent: { kind: "write", request } });
    expect(service.preview).toHaveBeenCalledWith(expect.objectContaining({ kind: "write", request }), {
      kind: "mcp",
      requestId: "request-a",
    });
  });

  it("records a no-op as the terminal result of a linked Desktop request", async () => {
    type Handler = (event: unknown, request: unknown) => Promise<unknown>;
    const handlers = new Map<string, Handler>();
    vi.doMock("electron", () => ({
      ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    }));
    const { registerSkillManagementIpcHandlers } = await import("../../src/main/skill-management/ipc");
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
    const noOp = {
      intentId: "intent-a",
      operationId: "intent-a",
      status: "no-op" as const,
      source: { status: "unchanged" as const },
      targets: [],
      receiptIds: [],
      issues: [],
      recoveryAvailable: false,
    };
    const pending = {
      requestId: "request-a",
      request: { kind: "remove-skill", bindingIds: ["binding-a"] },
      intentId: "intent-a",
      skillIntent: { kind: "remove", bindingIds: ["binding-a"] },
      status: "pending",
      approval: "omni",
      harness: "codex",
    };
    const lease = { leaseId: "lease-a", approvedAt: "2026-10-07T10:00:00.000Z" };
    const requests = {
      get: vi.fn(async () => pending),
      acquireApplyAuthorization: vi.fn(async () => lease),
      releaseApplyAuthorization: vi.fn(async () => undefined),
      recordApplyOutcome: vi.fn(async () => pending),
    };
    const service = {
      initialize: vi.fn(async () => undefined),
      preview: vi.fn(),
      refresh: vi.fn(),
      apply: vi.fn(async () => noOp),
      readResult: vi.fn(),
    };
    registerSkillManagementIpcHandlers(() => undefined, service as never, requests as never);

    await expect(
      handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
        {},
        {
          requestId: "request-a",
          intentId: "intent-a",
          effectFingerprint: "a".repeat(64),
        },
      ),
    ).resolves.toEqual(noOp);
    expect(requests.recordApplyOutcome).toHaveBeenCalledWith(
      "request-a",
      [],
      { status: "no-op" },
      { mode: "omni", at: lease.approvedAt, harness: "codex" },
      lease.leaseId,
    );
    expect(requests.releaseApplyAuthorization).not.toHaveBeenCalled();
  });
});
