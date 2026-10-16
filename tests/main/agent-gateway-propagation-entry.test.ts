import { describe, expect, it, vi } from "vitest";

import { createJobTools } from "../../src/main/agents/tools";
import { previewSkill } from "../../src/main/agent-gateway/router-skill";
import type { AgentWriteRequest } from "../../src/shared/agents-ipc";

const source = { sourceId: "personal", packageId: "packages/tools", artifactPath: "skills/demo" };
const client = { name: "test", version: "1" };
const update = { sourceId: source.sourceId, packageId: source.packageId, folderName: "demo", body: "# Updated\n" };
const alpha = { projectId: "alpha", harnessId: "codex" as const, folderPath: ".agents/skills/demo" };
const beta = { ...alpha, projectId: "beta" };
const preview = vi.fn(async (request: AgentWriteRequest, _client: unknown, askInOmni?: boolean) => ({
  request,
  askInOmni,
}));
const candidates = vi.fn(async () => [
  { skillId: "alpha-skill", locations: [alpha] },
  { skillId: "beta-skill", locations: [beta] },
]);

describe("agent propagation entry points", () => {
  it("exposes source-only updates and source-keyed synchronization to Desktop agents", () => {
    const tools = createJobTools({
      router: { handle: vi.fn() },
      client,
      grants: {
        projectId: "alpha",
        projectRoot: "/project",
        marketplaceRoot: "/source",
        sourceId: "personal",
        packageId: "packages/tools",
      },
      methods: ["preview_update_skill", "preview_sync_skill"],
    });
    expect(tools.map((tool) => tool.name)).toEqual(["omni_preview_sync_skill", "omni_preview_update_skill"]);
    const sync = tools.find((tool) => tool.name === "omni_preview_sync_skill")!;
    const updateTool = tools.find((tool) => tool.name === "omni_preview_update_skill")!;
    expect(sync.parameters).toMatchObject({
      required: ["sourceId", "packageId", "artifactPath"],
      additionalProperties: false,
    });
    expect(sync.parameters).not.toHaveProperty("properties.skillId");
    expect(updateTool.parameters).toHaveProperty("properties.sourceOnly", expect.objectContaining({ type: "boolean" }));
  });

  it("includes linked uses in an ordinary source update and preserves explicit source-only scope", async () => {
    expect(await previewSkill("preview_update_skill", update, client, preview, candidates)).toMatchObject({
      request: { kind: "update-and-maintain", source, request: { kind: "write-skill", mode: "update" } },
    });
    expect(
      await previewSkill("preview_update_skill", { ...update, sourceOnly: true }, client, preview, candidates),
    ).toMatchObject({
      request: { kind: "write-skill", mode: "update" },
    });
  });

  it("syncs an exact marketplace source without skill ids and narrows by requested projects", async () => {
    expect(await previewSkill("preview_sync_skill", source, client, preview, candidates)).toEqual({
      request: { kind: "maintain-current", source },
      askInOmni: undefined,
    });
    expect(
      await previewSkill(
        "preview_sync_skill",
        { ...source, projectIds: ["beta"], askInOmni: true },
        client,
        preview,
        candidates,
      ),
    ).toEqual({
      request: { kind: "maintain-current", source, locations: [beta] },
      askInOmni: true,
    });
    expect(candidates).toHaveBeenCalledWith(source);
    await expect(
      previewSkill("preview_sync_skill", { ...source, projectIds: ["unknown"] }, client, preview, candidates),
    ).rejects.toThrow(/linked copy/i);
    await expect(
      previewSkill("preview_sync_skill", { ...source, projectIds: [] }, client, preview, candidates),
    ).rejects.toThrow(/projects/i);
    await expect(
      previewSkill("preview_sync_skill", { ...source, projectIds: ["beta", "beta"] }, client, preview, candidates),
    ).rejects.toThrow(/unique/i);
  });
});
