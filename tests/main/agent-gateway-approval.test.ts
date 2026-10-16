import { describe, expect, it } from "vitest";
import { deriveApprovalInput, resolveApproval } from "../../src/main/agent-gateway/approval";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES, type Settings } from "../../src/shared/settings-ipc";
import type { OperationPlan } from "../../src/shared/operations-ipc";
import type { AgentPlan, AgentWriteRequest } from "../../src/shared/agents-ipc";
import type { SkillIntent, SkillPreview } from "../../src/shared/skill-management-ipc";

const settings: Settings = {
  schemaVersion: 8,
  git: { commitChanges: true },
  agents: {
    approval: { personalMarketplace: "conversation", projects: "conversation" },
    guard: { warnProjectIds: [] },
  },
  ai: DEFAULT_AI_SETTINGS,
  features: DEFAULT_FEATURES,
  externalLibrary: { updates: "auto" as const },
};
const plan: OperationPlan = {
  kind: "make-compatible",
  planId: "p",
  displayTarget: "skill",
  actions: [],
  git: { mode: "disabled", warnings: [] },
};
const write = {
  kind: "write-skill" as const,
  sourceId: "personal",
  packageId: "packages/tools",
  mode: "update" as const,
  folderName: "demo",
  files: [{ path: "SKILL.md", content: "# Demo\n" }],
};
const source = { sourceId: "personal", packageId: "packages/tools", artifactPath: "skills/demo" };
const target = { projectId: "project", harnessId: "codex" as const };
const registry = {
  listRegistry: async () => ({
    status: "ready",
    registry: { sources: [{ ref: { id: "personal" }, ownership: "personal" }] },
  }),
} as never;
function policy(marketplace: "conversation" | "omni", projects: "conversation" | "omni"): Settings {
  return { ...settings, agents: { ...settings.agents, approval: { personalMarketplace: marketplace, projects } } };
}
function preview(sourceDeletes = 0, targetDeletes = 0, hasSource = true): Extract<SkillPreview, { status: "ready" }> {
  const actions = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ kind: "delete-file" as const, relativePath: `old-${index}.md` }));
  const sourceScope = { sourceId: "personal", targets: [] };
  const targetScope = { sourceId: "personal", targets: [target] };
  return {
    status: "ready",
    intentId: "intent",
    planId: "preview",
    effectFingerprint: "a".repeat(64),
    scope: { sourceId: "personal", targets: [target] },
    steps: [
      ...(hasSource
        ? [
            {
              stepId: "source",
              scope: sourceScope,
              plan: { ...plan, kind: "write-skill" as const, actions: actions(sourceDeletes) },
              bindingEffects: [],
              files: [],
            },
          ]
        : []),
      {
        stepId: "project",
        scope: targetScope,
        plan: { ...plan, kind: "propagate-skill" as const, actions: actions(targetDeletes) },
        bindingEffects: [],
        files: [],
      },
    ],
  };
}
function decide(
  operation: AgentWriteRequest | SkillIntent,
  evidence: AgentPlan | Extract<SkillPreview, { status: "ready" }>,
  savedSettings = settings,
  overrides: Record<string, unknown> = {},
) {
  return resolveApproval({
    ...deriveApprovalInput(operation, evidence),
    settings: savedSettings,
    registry,
    ...overrides,
  });
}
describe("one agent approval decision", () => {
  it.each([
    {
      kind: "import-artifact",
      projectId: "project",
      relativePath: "skills/demo",
      target: { packageId: "packages/tools" },
    },
    { kind: "make-compatible", sourceId: "personal", harness: "codex" },
  ] as const)("keeps ordinary $kind text changes in conversation and escalates legacy deletions", async (request) => {
    expect(
      await decide(request, { ...plan, actions: [{ kind: "write-file", relativePath: "SKILL.md", diff: "changed" }] }),
    ).toEqual({ mode: "conversation" });
    expect(await decide(request, { ...plan, actions: [{ kind: "delete-file", relativePath: "old.md" }] })).toEqual({
      mode: "omni",
      reason: { code: "deletes-files", count: 1 },
    });
  });
  it.each([
    {
      kind: "assign",
      sourceId: "personal",
      packageId: "packages/tools",
      targets: [{ projectId: "project", harnessIds: ["codex"] }],
    },
    { kind: "remove", bindingIds: ["binding"] },
    { kind: "maintain-current", source },
  ] as const)("uses only the project setting for $kind", async (intent) => {
    expect(await decide(intent, preview(0, 1, false), policy("omni", "conversation"))).toEqual({
      mode: "conversation",
    });
    expect(await decide(intent, preview(0, 0, false), policy("conversation", "omni"))).toEqual({
      mode: "omni",
      reason: { code: "projects-setting" },
    });
  });
  it("uses only the marketplace setting for a source-only write", async () => {
    const evidence = { ...preview(), scope: { sourceId: "personal", targets: [] }, steps: preview().steps.slice(0, 1) };
    expect(await decide({ kind: "write", request: write }, evidence, policy("conversation", "omni"))).toEqual({
      mode: "conversation",
    });
    expect(await decide({ kind: "write", request: write }, evidence, policy("omni", "conversation"))).toEqual({
      mode: "omni",
      reason: { code: "marketplace-setting" },
    });
  });
  it.each([
    ["conversation", "conversation", { mode: "conversation" }],
    ["omni", "conversation", { mode: "omni", reason: { code: "marketplace-setting" } }],
    ["conversation", "omni", { mode: "omni", reason: { code: "projects-setting" } }],
    ["omni", "omni", { mode: "omni", reason: { code: "projects-setting" } }],
  ] as const)(
    "uses the stricter setting for source and project writes (%s, %s)",
    async (market, projects, expected) => {
      expect(
        await decide({ kind: "update-and-maintain", source, request: write }, preview(), policy(market, projects)),
      ).toEqual(expected);
    },
  );
  it.each(["write", "update-and-maintain"] as const)(
    "escalates only source replacement side effects for %s",
    async (kind) => {
      const operation =
        kind === "write"
          ? { kind, request: { ...write, replaceFolder: true } }
          : { kind, source, request: { ...write, replaceFolder: true } };
      expect(await decide(operation, preview(1, 2))).toEqual({
        mode: "omni",
        reason: { code: "deletes-files", count: 1 },
      });
      expect(await decide(operation, preview(0, 2))).toEqual({ mode: "conversation" });
      expect(await decide({ ...operation, request: write }, preview(1, 2))).toEqual({ mode: "conversation" });
    },
  );
  it("does not escalate restore deletions and follows the restored scope's setting", async () => {
    const intent = { kind: "restore" as const, operationId: "operation" };
    expect(await decide(intent, preview(0, 1, false), policy("omni", "conversation"))).toEqual({
      mode: "conversation",
    });
    expect(
      await decide(intent, {
        ...preview(1),
        scope: { sourceId: "personal", targets: [] },
        steps: preview(1).steps.slice(0, 1),
      }),
    ).toEqual({ mode: "conversation" });
  });
  it("returns explicit approval, unavailable registry, ownership, and conflict reasons in order", async () => {
    const operation = { kind: "make-compatible" as const, sourceId: "external", harness: "codex" as const };
    expect(await decide(operation, plan, settings, { askInOmni: true, registry: {} })).toEqual({
      mode: "omni",
      reason: { code: "asked-in-omni" },
    });
    expect(await decide(operation, plan, settings, { registry: {} })).toEqual({
      mode: "omni",
      reason: { code: "registry-unavailable" },
    });
    expect(await decide(operation, plan)).toEqual({ mode: "omni", reason: { code: "not-owned-source" } });
    const archived = {
      listRegistry: async () => ({
        status: "ready",
        registry: { sources: [{ ref: { id: "personal" }, ownership: "personal", archivedAt: "today" }] },
      }),
    };
    expect(await decide({ ...operation, sourceId: "personal" }, plan, settings, { registry: archived })).toEqual({
      mode: "omni",
      reason: { code: "not-owned-source" },
    });
    expect(
      await decide({ kind: "assign", sourceId: "personal", packageId: "packages/tools", targets: [] }, {
        kind: "assign",
        plans: [{ status: "conflict", actions: [] }],
      } as never),
    ).toEqual({ mode: "omni", reason: { code: "conflict" } });
  });
  it("asks in Omni before installing a skill from a marketplace the owner does not own", async () => {
    const external = {
      ...preview(),
      scope: { sourceId: "external", targets: [target] },
      steps: [],
    };
    expect(
      await decide(
        { kind: "assign", source: { ...source, sourceId: "external" }, targets: [target] } as never,
        external,
      ),
    ).toEqual({ mode: "omni", reason: { code: "not-owned-source" } });
  });
});

it("requires public-publication approval for every agent publish, even with conversation settings", async () => {
  const request = { kind: "publish-plugin" as const, pluginId: "demo", storefrontId: "shop" };
  const publicationPlan: OperationPlan = { ...plan, kind: "publish-plugin" };
  expect(await decide(request, publicationPlan)).toEqual({ mode: "omni", reason: { code: "public-publication" } });
  expect(await decide(request, publicationPlan, settings, { askInOmni: true, registry: {} })).toEqual({
    mode: "omni",
    reason: { code: "public-publication" },
  });
});
