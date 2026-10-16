import { observedPackages } from "./agent-gateway-helpers";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentRouter } from "../../src/main/agent-gateway/router";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { skillIntentForAgentRequest } from "../../src/main/agent-gateway/router-management";
import { parseAgentWriteRequest } from "../../src/shared/agents-ipc";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES, type Settings } from "../../src/shared/settings-ipc";
import type { SkillIntent, SkillPreview } from "../../src/shared/skill-management-ipc";

const roots: string[] = [];
const settings: Settings = {
  schemaVersion: 8,
  git: { commitChanges: false },
  agents: { approval: { personalMarketplace: "conversation", projects: "omni" }, guard: { warnProjectIds: [] } },
  ai: DEFAULT_AI_SETTINGS,
  features: DEFAULT_FEATURES,
  externalLibrary: { updates: "auto" as const },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function readyPreview(intent: SkillIntent, deleted = false): SkillPreview {
  const scope = {
    ...(intent.kind === "write" ||
    intent.kind === "assign" ||
    intent.kind === "update-and-maintain" ||
    intent.kind === "maintain-current"
      ? {
          sourceId:
            intent.kind === "write"
              ? intent.request.sourceId
              : intent.kind === "assign"
                ? intent.sourceId
                : intent.source.sourceId,
        }
      : {}),
    ...(intent.kind === "write" ||
    intent.kind === "assign" ||
    intent.kind === "update-and-maintain" ||
    intent.kind === "maintain-current"
      ? {
          packageId:
            intent.kind === "write"
              ? intent.request.packageId
              : intent.kind === "assign"
                ? intent.packageId
                : intent.source.packageId,
        }
      : {}),
    targets:
      intent.kind === "assign"
        ? intent.targets.flatMap((target) =>
            target.harnessIds.map((harnessId) => ({
              projectId: target.projectId,
              harnessId,
              bindingId: `binding-${target.projectId}`,
            })),
          )
        : intent.kind === "update-and-maintain" || intent.kind === "maintain-current"
          ? (intent.locations ?? []).map((target) => ({
              projectId: target.projectId,
              harnessId: target.harnessId,
              bindingId: `binding-${target.projectId}`,
            }))
          : [],
  };
  const plan = {
    planId: "plan-one",
    kind: "write-skill" as const,
    displayTarget: "packages/tools",
    actions: deleted
      ? [{ kind: "delete-file" as const, relativePath: "packages/tools/skills/demo/old.md" }]
      : [{ kind: "write-file" as const, relativePath: "packages/tools/skills/demo/SKILL.md", diff: "text changed" }],
    git: { mode: "not-a-repository" as const, warnings: [] },
  };
  return {
    status: "ready",
    intentId: "intent-one",
    planId: plan.planId,
    effectFingerprint: "a".repeat(64),
    scope,
    steps: [{ stepId: "step-one", scope, plan, bindingEffects: [], files: [] }],
  };
}

async function routerFor(
  input: Readonly<{
    preview?: (intent: SkillIntent) => Promise<SkillPreview>;
    settings?: Settings;
    ownership?: "personal" | "external";
  }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "omni-agent-management-"));
  roots.push(root);
  const requests = createAgentRequestsStore(join(root, "omni", "agent-requests.json"));
  const service = {
    initialize: vi.fn(async () => undefined),
    readPropagationCandidates: vi.fn(async () => [
      {
        skillId: "skill-one",
        locations: [{ projectId: "project-one", harnessId: "codex" as const, folderPath: ".agents/skills/demo" }],
      },
      {
        skillId: "skill-two",
        locations: [{ projectId: "project-two", harnessId: "claude-code" as const, folderPath: ".claude/skills/demo" }],
      },
    ]),
    preview: vi.fn(async (intent: SkillIntent) => (input.preview ? input.preview(intent) : readyPreview(intent))),
    refresh: vi.fn(),
    apply: vi.fn(),
    readResult: vi.fn(),
  };
  const router = createAgentRouter({
    userDataPath: root,
    registry: {
      observeRegisteredEntry: async () => observedPackages("packages/tools"),
      listRegistry: async () => ({
        status: "ready" as const,
        registry: {
          observeRegisteredEntry: async () => observedPackages("packages/tools"),
          revision: 1,
          projects: [],
          sources: [{ ref: { kind: "source", id: "personal" }, ownership: input.ownership ?? "personal" }],
        },
      }),
    } as never,
    bindings: {} as never,
    operations: { skillManagement: service } as never,
    requests,
    settingsStore: { read: async () => input.settings ?? settings } as never,
  });
  return { router, requests, service };
}

describe("agent gateway managed skill operations", () => {
  it("keeps the legacy assignment payload and defaults its harnesses", () => {
    const request = parseAgentWriteRequest({
      kind: "assign",
      artifactPath: "skills/demo",
      sourceId: "personal",
      packageId: "packages/tools",
      projectIds: ["project-one"],
    });
    expect(skillIntentForAgentRequest(request)).toEqual({
      kind: "assign",
      sourceId: "personal",
      packageId: "packages/tools",
      artifactPath: "skills/demo",
      targets: [{ projectId: "project-one", harnessIds: ["claude-code", "codex"] }],
    });
  });

  it("keeps ordinary update diffs in configured conversation approval", async () => {
    const { router } = await routerFor();
    const preview = await router.handle(
      "preview_update_skill",
      {
        sourceId: "personal",
        packageId: "packages/tools",
        folderName: "demo",
        body: "# Updated\n",
      },
      { name: "test", version: "1" },
    );
    expect(preview).toMatchObject({
      approval: "conversation",
      skillPreview: { steps: [{ plan: { actions: [{ diff: "text changed" }] } }] },
    });
  });

  it("routes default updates, explicit source-only updates and narrowed synchronization without logical ids", async () => {
    const { router, service } = await routerFor();
    const source = { sourceId: "personal", packageId: "packages/tools", artifactPath: "skills/demo" };
    const update = { sourceId: "personal", packageId: "packages/tools", folderName: "demo", body: "# Updated" };
    const client = { name: "test", version: "1" };
    await router.handle("preview_update_skill", update, client);
    expect(service.preview).toHaveBeenLastCalledWith(
      {
        kind: "update-and-maintain",
        source,
        request: expect.objectContaining({ kind: "write-skill", mode: "update" }),
      },
      expect.anything(),
    );
    await expect(router.handle("preview_update_skill", { ...update, sourceOnly: true }, client)).resolves.toMatchObject(
      { sourceOnly: true },
    );
    expect(service.preview).toHaveBeenLastCalledWith(
      { kind: "write", request: expect.objectContaining({ mode: "update" }) },
      expect.anything(),
    );
    await router.handle("preview_sync_skill", { ...source, projectIds: ["project-two"] }, client);
    expect(service.readPropagationCandidates).toHaveBeenCalledWith(source);
    expect(service.preview).toHaveBeenLastCalledWith(
      {
        kind: "maintain-current",
        source,
        locations: [{ projectId: "project-two", harnessId: "claude-code", folderPath: ".claude/skills/demo" }],
      },
      expect.anything(),
    );
  });

  it("routes both linked maintenance intents through one project-scoped approval", async () => {
    const { router, service } = await routerFor();
    const client = { name: "test", version: "1", harness: "codex" as const, sessionName: "session-one" };
    const source = { sourceId: "personal", packageId: "packages/tools", artifactPath: "skills/demo" };
    const location = { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/demo" };
    const request = {
      kind: "write-skill",
      sourceId: "personal",
      packageId: "packages/tools",
      mode: "update",
      folderName: "demo",
      files: [{ path: "SKILL.md", content: "# Updated\n" }],
    };
    const update = await router.handle(
      "preview_update_and_maintain_skill",
      { source, request, locations: [location] },
      client,
    );
    expect(update).toMatchObject({ approval: "omni" });
    expect(service.preview).toHaveBeenLastCalledWith(
      { kind: "update-and-maintain", source, request, locations: [location] },
      expect.objectContaining({ kind: "mcp" }),
    );
    const maintain = await router.handle(
      "preview_maintain_current_skill",
      {
        source,
        locations: [location],
        retryOf: "operation-original",
      },
      client,
    );
    expect(maintain).toMatchObject({ approval: "omni" });
    expect(service.preview).toHaveBeenLastCalledWith(
      {
        kind: "maintain-current",
        source,
        locations: [location],
        retryOf: "operation-original",
      },
      expect.objectContaining({ kind: "mcp" }),
    );
  });

  it("returns a no-write MCP preview when every linked target is retained or unavailable", async () => {
    const source = { sourceId: "personal", packageId: "packages/tools", artifactPath: "skills/demo" };
    const location = { projectId: "project-one", harnessId: "codex" as const, folderPath: ".agents/skills/demo" };
    const { router } = await routerFor({
      preview: async (intent) => {
        const preview = readyPreview(intent);
        return {
          ...preview,
          propagation: {
            mode: "maintain-current",
            source,
            targets: [{ location, state: "retained-local" }],
          },
          scope: {
            sourceId: "personal",
            packageId: "packages/tools",
            artifactPath: "skills/demo",
            targets: [],
          },
          steps: [],
        };
      },
    });
    const result = await router.handle(
      "preview_maintain_current_skill",
      {
        source,
        locations: [location],
      },
      { name: "test", version: "1" },
    );

    expect(result).toMatchObject({
      approval: "conversation",
      plan: { kind: "propagate-skill", actions: [] },
      skillPreview: { steps: [], scope: { targets: [] } },
    });
  });

  it("retains ask-in-Omni, configured approval, external ownership, and destructive replacement", async () => {
    const input = {
      sourceId: "personal",
      packageId: "packages/tools",
      folderName: "demo",
      body: "# Updated\n",
    };
    const client = { name: "test", version: "1" };
    const ask = await routerFor();
    await expect(
      ask.router.handle("preview_update_skill", { ...input, askInOmni: true }, client),
    ).resolves.toMatchObject({ approval: "omni" });

    const strict = await routerFor({
      settings: {
        ...settings,
        agents: { ...settings.agents, approval: { personalMarketplace: "omni", projects: "omni" } },
      },
    });
    await expect(strict.router.handle("preview_update_skill", input, client)).resolves.toMatchObject({
      approval: "omni",
    });

    const external = await routerFor({ ownership: "external" });
    await expect(external.router.handle("preview_update_skill", input, client)).resolves.toMatchObject({
      approval: "omni",
    });

    const destructive = await routerFor({ preview: async (intent) => readyPreview(intent, true) });
    await expect(
      destructive.router.handle("preview_update_skill", { ...input, replaceFolder: true }, client),
    ).resolves.toMatchObject({ approval: "omni" });
  });

  it("returns and stores only source replacement deletion reasons", async () => {
    const { router, requests } = await routerFor({
      preview: async (intent) => {
        const preview = readyPreview(intent);
        const deleted = readyPreview(intent, true);
        if (preview.status !== "ready" || deleted.status !== "ready") throw new Error("Expected ready fixtures.");
        return {
          ...preview,
          steps: [
            ...deleted.steps,
            ...deleted.steps.map((step) => ({
              ...step,
              stepId: "project",
              scope: { ...step.scope, targets: [{ projectId: "project-one", harnessId: "codex" as const }] },
              plan: { ...step.plan, kind: "propagate-skill" as const },
            })),
          ],
        };
      },
    });
    const preview = (await router.handle(
      "preview_update_skill",
      {
        sourceId: "personal",
        packageId: "packages/tools",
        folderName: "demo",
        files: [{ path: "SKILL.md", content: "# Demo\n" }],
        sourceOnly: true,
        replaceFolder: true,
      },
      { name: "test", version: "1" },
    )) as { requestId: string };
    expect(preview).toMatchObject({ approval: "omni", approvalReason: { code: "deletes-files", count: 1 } });
    expect(await requests.get(preview.requestId)).toMatchObject({
      approvalReason: { code: "deletes-files", count: 1 },
    });
  });

  it("uses the explicit assignment harness selection supplied by an older payload extension", async () => {
    const { router, service } = await routerFor();
    await router.handle(
      "preview_assign",
      {
        artifactPath: "skills/demo",
        sourceId: "personal",
        packageId: "packages/tools",
        projectIds: ["project-one"],
        harnesses: ["codex"],
      },
      { name: "test", version: "1" },
    );
    expect(service.preview).toHaveBeenCalledWith(
      {
        kind: "assign",
        sourceId: "personal",
        packageId: "packages/tools",
        artifactPath: "skills/demo",
        targets: [{ projectId: "project-one", harnessIds: ["codex"] }],
      },
      expect.objectContaining({ kind: "mcp" }),
    );
  });
});
