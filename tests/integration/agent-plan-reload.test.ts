import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seedFixture, registerOperations, sourcePackage } from "./skill-adoption-fixture";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { createSettingsStore, settingsFilePath } from "../../src/main/settings-store";
import type { AgentPlan } from "../../src/shared/agents-ipc";
import type { SkillPreview, SkillResult } from "../../src/shared/skill-management-ipc";
import { expectAgentStoresToReload } from "../helpers/agent-store-reload";

type Preview = Readonly<{
  requestId: string;
  approval: "omni" | "conversation";
  plan: AgentPlan;
  skillPreview: Extract<SkillPreview, { status: "ready" }>;
}>;

it("reloads complete linked write, assignment, propagation, removal, forget and restore records", async () => {
  const f = await seedFixture();
  const requests = createAgentRequestsStore(join(f.userDataPath, "omni/agent-requests.json"));
  const settingsStore = createSettingsStore(settingsFilePath(f.userDataPath));
  const settings = await settingsStore.read();
  await settingsStore.set({
    commitChanges: false,
    agents: { ...settings.agents, approval: { personalMarketplace: "conversation", projects: "conversation" } },
    ai: settings.ai,
    features: settings.features,
    externalLibrary: settings.externalLibrary,
  });
  const operations = await registerOperations(f);
  const { createAgentRouter } = await import("../../src/main/agent-gateway/router");
  const { registerSkillManagementIpcHandlers } = await import("../../src/main/skill-management/ipc");
  const router = createAgentRouter({
    userDataPath: f.userDataPath,
    registry: f.registry,
    bindings: f.bindings,
    operations,
    requests,
    settingsStore,
  });
  const desktop = registerSkillManagementIpcHandlers(() => undefined, operations.skillManagement, requests);
  const client = { name: "reload", version: "1", harness: "codex" as const, sessionName: "reload-session" };
  const preview = async (method: string, params: unknown): Promise<Preview> => {
    const result = (await router.handle(method, params, client)) as Preview;
    expect(result, JSON.stringify(result)).toHaveProperty("requestId");
    await expectAgentStoresToReload(f.userDataPath);
    return result;
  };
  const apply = async (p: Preview): Promise<SkillResult> => {
    const result =
      p.approval === "omni"
        ? await desktop.applySkillOperation({
            requestId: p.requestId,
            intentId: p.skillPreview.intentId,
            effectFingerprint: p.skillPreview.effectFingerprint,
          })
        : ((await router.handle("apply", { requestId: p.requestId }, client)) as SkillResult);
    expect(result.status).toMatch(/^(applied|restored)$/);
    await expectAgentStoresToReload(f.userDataPath);
    return result;
  };
  const source = { sourceId: f.source.id, packageId: sourcePackage, artifactPath: "skills/reload-demo" };
  const create = await preview("preview_create_skill", {
    sourceId: f.source.id,
    packageId: "tools",
    name: "reload-demo",
    description: "Use when checking persisted agent plans.",
    body: "# Original\n",
    files: [{ path: "notes.md", content: "Support bytes.\n" }],
  });
  expect(create.plan).toMatchObject({ kind: "write-skill", packageId: sourcePackage });
  const created = await apply(create);
  const sourceRestore = await preview("preview_restore", { operationId: created.operationId });
  expect(sourceRestore.plan).toMatchObject({
    kind: "restore-import",
    actions: expect.arrayContaining([expect.anything()]),
  });
  const assigned = await preview("preview_assign", { ...source, projectIds: [f.project.id], harnesses: ["codex"] });
  expect(assigned.plan).toMatchObject({
    kind: "assign",
    plans: [{ actions: [expect.anything()] }],
    bindings: [expect.anything()],
  });
  await apply(assigned);
  const files = [
    {
      path: "SKILL.md",
      content: "---\nname: reload-demo\ndescription: Use when checking persisted agent plans.\n---\n# Updated\n",
    },
  ];
  const update = await preview("preview_update_skill", {
    sourceId: f.source.id,
    packageId: "tools",
    folderName: "reload-demo",
    files,
    sourceOnly: true,
  });
  expect(update.plan).toMatchObject({ kind: "write-skill", packageId: sourcePackage });
  await apply(update);
  const maintain = await preview("preview_maintain_current_skill", { source });
  expect(maintain.plan).toMatchObject({ kind: "propagate-skill", actions: [expect.anything()] });
  await apply(maintain);
  const propagated = await preview("preview_update_and_maintain_skill", {
    source,
    request: {
      kind: "write-skill",
      sourceId: f.source.id,
      packageId: "tools",
      mode: "update",
      folderName: "reload-demo",
      files: [{ path: "SKILL.md", content: files[0]!.content + "Another revision.\n" }],
    },
  });
  expect(propagated.skillPreview.steps).toHaveLength(2);
  await apply(propagated);
  await apply(
    await preview("preview_create_skill", {
      sourceId: f.source.id,
      packageId: "tools",
      name: "removable-demo",
      description: "Use when checking removal history.",
      body: "# Removal\n",
    }),
  );
  const removable = await preview("preview_assign", {
    sourceId: f.source.id,
    packageId: "tools",
    artifactPath: "skills/removable-demo",
    projectIds: [f.project.id],
    harnesses: ["codex"],
  });
  await apply(removable);
  const bindingId = removable.skillPreview.scope.targets[0]!.bindingId!;
  const removed = await preview("preview_remove", { bindingIds: [bindingId] });
  expect(removed.plan).toMatchObject({ kind: "remove-binding", actions: [expect.anything()] });
  const removal = await apply(removed);
  const restore = await preview("preview_restore", { operationId: removal.operationId });
  expect(restore.plan.kind).toBe("restore-apply");
  await apply(restore);
  await rm(join(f.projectRoot, ".agents/skills/removable-demo"), { recursive: true });
  const forget = await preview("preview_remove", { bindingIds: [bindingId] });
  expect(forget.plan).toMatchObject({
    kind: "remove-binding",
    actions: [],
    notes: expect.arrayContaining([expect.stringContaining("Forget this use")]),
  });
  const forgotten = await apply(forget);
  const restoreForgotten = await preview("preview_restore", { operationId: forgotten.operationId });
  expect(restoreForgotten.plan).toMatchObject({ kind: "restore-apply", actions: [] });
  await apply(restoreForgotten);
});
