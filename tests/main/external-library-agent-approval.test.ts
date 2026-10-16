import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { externalOperationFixture } from "../helpers/external-operations-fixture";
import { createAgentRouter } from "../../src/main/agent-gateway/router";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { expectAgentStoresToReload } from "../helpers/agent-store-reload";
import { registerSkillManagementIpcHandlers } from "../../src/main/skill-management/ipc";

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused" },
  dialog: {},
  ipcMain: { handle: vi.fn() },
}));
it.each(["conversation", "omni"] as const)(
  "installs through preview, %s approval and apply with a receipt",
  async (approval) => {
    const f = await externalOperationFixture(),
      settings = await f.settings.read();
    await f.settings.set({
      commitChanges: settings.git.commitChanges,
      agents: { ...settings.agents, approval: { ...settings.agents.approval, projects: approval } },
      ai: settings.ai,
      features: settings.features,
      externalLibrary: settings.externalLibrary,
    });
    const requests = createAgentRequestsStore(join(f.data, "omni/agent-requests.json"));
    const router = createAgentRouter({
      userDataPath: f.data,
      registry: f.registry,
      operations: f.operations,
      requests,
      bindings: {} as never,
      settingsStore: f.settings,
    });
    const client = { name: "fixture", version: "1", harness: "codex" as const };
    const list = (await router.handle("list_external_library", {}, client)) as {
      sources: { skills: { useIds: string[] }[]; uses: { state: string }[] }[];
    };
    expect(list.sources.some((source) => source.skills.some((skill) => !skill.useIds.length))).toBe(true);
    expect(list.sources.some((source) => source.uses.some((use) => use.state === "update"))).toBe(true);
    const preview = (await router.handle(
      "preview_install_external",
      {
        sourceId: "fixture/tools",
        skillPath: "skills/unused",
        skillName: "unused",
        targets: [{ projectId: "project-a", harnessIds: ["codex"] }],
        conflict: "refuse",
      },
      client,
    )) as { approval: string; requestId: string; skillPreview: { intentId: string; effectFingerprint: string } };
    expect(preview.approval).toBe(approval);
    await expectAgentStoresToReload(f.data);
    if (approval === "omni") {
      expect(await router.handle("apply", { requestId: preview.requestId, waitMs: 0 }, client)).toMatchObject({
        status: "pending",
      });
      await expect(readFile(join(f.projectA, ".agents/skills/unused/SKILL.md"))).rejects.toThrow();
      const api = registerSkillManagementIpcHandlers(() => undefined, f.service, requests);
      expect(
        (
          await api.applySkillOperation({
            requestId: preview.requestId,
            intentId: preview.skillPreview.intentId,
            effectFingerprint: preview.skillPreview.effectFingerprint,
          })
        ).status,
      ).toBe("applied");
    }
    expect(await router.handle("apply", { requestId: preview.requestId, waitMs: 0 }, client)).toMatchObject({
      status: "applied",
    });
    expect(await readFile(join(f.projectA, ".agents/skills/unused/SKILL.md"), "utf8")).toContain("Base unused.");
    await expectAgentStoresToReload(f.data);
  },
);
it("keeps replacement pending in Omni even when project writes allow conversation approval", async () => {
  const f = await externalOperationFixture(),
    current = await f.settings.read();
  await f.settings.set({
    commitChanges: false,
    agents: { ...current.agents, approval: { personalMarketplace: "conversation", projects: "conversation" } },
    ai: current.ai,
    features: current.features,
    externalLibrary: current.externalLibrary,
  });
  const requests = createAgentRequestsStore(join(f.data, "omni/agent-requests.json"));
  const router = createAgentRouter({
    userDataPath: f.data,
    registry: f.registry,
    operations: f.operations,
    requests,
    bindings: {} as never,
    settingsStore: f.settings,
  });
  const client = { name: "fixture", version: "1" };
  const before = await readFile(join(f.projectA, ".agents/skills/current/SKILL.md"), "utf8");
  const preview = (await router.handle(
    "preview_install_external",
    {
      sourceId: "fixture/tools",
      skillPath: "skills/unused",
      skillName: "current",
      targets: [{ projectId: "project-a", harnessIds: ["codex"] }],
      conflict: "replace",
    },
    client,
  )) as { approval: string; approvalReason: { code: string }; requestId: string };
  expect(preview).toMatchObject({ approval: "omni", approvalReason: { code: "conflict" } });
  expect(await router.handle("apply", { requestId: preview.requestId, waitMs: 0 }, client)).toMatchObject({
    status: "pending",
  });
  expect(await readFile(join(f.projectA, ".agents/skills/current/SKILL.md"), "utf8")).toBe(before);
});
