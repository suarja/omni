import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { seedFixture, registerOperations, sourcePackage, sourceSkill } from "./skill-adoption-fixture";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { expectAgentStoresToReload } from "../helpers/agent-store-reload";
import type { RegistryIpcServices } from "../../src/main/registry-ipc";

const client = { name: "test", version: "1", harness: "codex" as const };
const body = (name: string) =>
  `---\nname: ${name}\ndescription: Use when testing package resolution.\n---\n# Updated\n`;

async function gateway() {
  const fixture = await seedFixture();
  const operations = await registerOperations(fixture);
  const requests = createAgentRequestsStore(join(fixture.userDataPath, "omni/agent-requests.json"));
  const { createAgentRouter } = await import("../../src/main/agent-gateway/router");
  const router = createAgentRouter({
    userDataPath: fixture.userDataPath,
    registry: fixture.registry,
    operations,
    bindings: fixture.bindings,
    requests,
  });
  return { ...fixture, operations, router, requests };
}

describe("package ids in gateway skill writes", () => {
  it("creates then updates with the short name and persists canonical ids through apply and receipts", async () => {
    const f = await gateway();
    const create = (await f.router.handle(
      "preview_create_skill",
      {
        sourceId: f.source.id,
        packageId: "tools",
        name: "new-demo",
        description: "Use when testing the rc.13 package id regression.",
        body: "# Demo\n",
      },
      client,
    )) as { requestId: string; skillPreview: { scope: { packageId: string } } };
    expect(create).toMatchObject({
      plan: { packageId: sourcePackage },
      skillPreview: { scope: { packageId: sourcePackage } },
    });
    await expectAgentStoresToReload(f.userDataPath);
    expect(await f.router.handle("apply", { requestId: create.requestId }, client)).toMatchObject({
      status: "applied",
    });
    await expectAgentStoresToReload(f.userDataPath);
    const update = (await f.router.handle(
      "preview_update_skill",
      {
        sourceId: f.source.id,
        packageId: "tools",
        folderName: "new-demo",
        files: [{ path: "SKILL.md", content: body("new-demo") }],
      },
      client,
    )) as { requestId: string; skillPreview: { scope: { packageId: string } } };
    expect(update).toMatchObject({
      plan: { packageId: sourcePackage },
      skillPreview: { scope: { packageId: sourcePackage } },
    });
    expect(await f.requests.get(update.requestId)).toMatchObject({
      request: { source: { packageId: sourcePackage }, request: { packageId: sourcePackage } },
      skillIntent: { source: { packageId: sourcePackage }, request: { packageId: sourcePackage } },
    });
    const applied = await f.router.handle("apply", { requestId: update.requestId }, client);
    expect(applied).toMatchObject({
      status: "applied",
      receipts: [{ packageId: sourcePackage }],
    });
    await expectAgentStoresToReload(f.userDataPath);
    const receipt = await f.router.handle("receipt", { requestId: update.requestId }, client);
    expect(receipt).toMatchObject({
      receipts: [{ skillManagement: { propagation: { source: { packageId: sourcePackage } } } }],
    });
    expect(await readFile(join(f.sourceRoot, sourcePackage, "skills/new-demo/SKILL.md"), "utf8")).toBe(
      body("new-demo"),
    );
    const journals = await readdir(join(f.userDataPath, "omni/skill-operations"));
    expect(journals.length).toBeGreaterThan(0);
    for (const journal of journals) {
      const stored = await readFile(join(f.userDataPath, "omni/skill-operations", journal), "utf8");
      expect(stored).not.toMatch(/"packageId"\s*:\s*"tools"/);
      expect(stored).toMatch(/"packageId"\s*:\s*"packages\/tools"/);
    }
  });
  it("reproduces rc.13 with build-to-show creation and explainer-motion updates", async () => {
    const f = await gateway();
    const canonical = "packages/build-to-show";
    await rename(join(f.sourceRoot, sourcePackage), join(f.sourceRoot, canonical));
    await writeFile(
      join(f.sourceRoot, "omni.marketplace.json"),
      JSON.stringify({
        format: "omni.marketplace/1",
        id: "personal",
        name: "Personal",
        createdAt: "2026-10-14T00:00:00.000Z",
        packages: [{ path: canonical }],
        createdBy: "omni-desktop/test",
      }),
    );
    await writeFile(
      join(f.sourceRoot, canonical, "omni.plugin.json"),
      JSON.stringify({
        format: "omni.plugin/1",
        id: "explainer-motion",
        name: "Motion tools",
        version: "0.1.0",
        artifacts: [],
      }),
    );
    const created = (await f.router.handle(
      "preview_create_skill",
      {
        sourceId: f.source.id,
        packageId: "build-to-show",
        name: "making-motion-promo-shorts",
        description: "Use when testing the rc.13 owner regression.",
        body: "# Motion\n",
      },
      client,
    )) as { requestId: string };
    expect(await f.router.handle("apply", { requestId: created.requestId }, client)).toMatchObject({
      status: "applied",
    });
    for (const packageId of ["build-to-show", "explainer-motion", "Motion tools"]) {
      const updated = (await f.router.handle(
        "preview_update_skill",
        {
          sourceId: f.source.id,
          packageId,
          folderName: "making-motion-promo-shorts",
          files: [{ path: "SKILL.md", content: body("making-motion-promo-shorts") }],
        },
        client,
      )) as { requestId: string };
      expect(await f.requests.get(updated.requestId)).toMatchObject({
        request: {
          source: { packageId: canonical },
          request: { packageId: canonical },
        },
      });
    }
  });
  it("resolves short names for source-only updates, sync and assignment", async () => {
    const f = await gateway();
    const source = { sourceId: f.source.id, packageId: "tools", artifactPath: sourceSkill };
    const update = await f.router.handle(
      "preview_update_skill",
      { sourceId: f.source.id, packageId: "tools", folderName: "demo", body: body("demo"), sourceOnly: true },
      client,
    );
    expect(update).toMatchObject({ sourceOnly: true, skillPreview: { scope: { packageId: sourcePackage } } });
    const sync = (await f.router.handle("preview_sync_skill", source, client)) as { requestId: string };
    expect(await f.requests.get(sync.requestId)).toMatchObject({ request: { source: { packageId: sourcePackage } } });
    await rm(join(f.projectRoot, ".agents/skills/demo"), { recursive: true });
    const assign = (await f.router.handle(
      "preview_assign",
      { ...source, projectIds: [f.project.id], harnesses: ["codex"] },
      client,
    )) as { requestId: string };
    expect(await f.requests.get(assign.requestId)).toMatchObject({
      request: { packageId: sourcePackage },
      skillIntent: { packageId: sourcePackage },
    });
    await expectAgentStoresToReload(f.userDataPath);
  });
  it("normalizes independently supplied source and write aliases before validating maintenance", async () => {
    const f = await gateway();
    const source = { sourceId: f.source.id, packageId: "tools", artifactPath: sourceSkill };
    const result = (await f.router.handle(
      "preview_update_and_maintain_skill",
      {
        source,
        request: {
          kind: "write-skill",
          sourceId: f.source.id,
          packageId: sourcePackage,
          mode: "update",
          folderName: "demo",
          files: [{ path: "SKILL.md", content: body("demo") }],
        },
      },
      client,
    )) as { requestId: string };
    expect(await f.requests.get(result.requestId)).toMatchObject({
      request: { source: { packageId: sourcePackage }, request: { packageId: sourcePackage } },
    });
    const maintain = (await f.router.handle("preview_maintain_current_skill", { source }, client)) as {
      requestId: string;
    };
    expect(await f.requests.get(maintain.requestId)).toMatchObject({
      request: { source: { packageId: sourcePackage } },
    });
    await expectAgentStoresToReload(f.userDataPath);
  });
  it("resolves a capture target and compatibility package with the short name", async () => {
    const f = await gateway();
    await mkdir(join(f.projectRoot, ".agents/skills/capture-demo"), { recursive: true });
    await writeFile(join(f.projectRoot, ".agents/skills/capture-demo/SKILL.md"), body("capture-demo"));
    const capture = await f.router.handle(
      "preview_capture",
      {
        projectId: f.project.id,
        relativePath: ".agents/skills/capture-demo/SKILL.md",
        target: { packageId: "tools" },
      },
      client,
    );
    expect(capture).toMatchObject({ requestId: expect.any(String) });
    const stored = await f.requests.get((capture as { requestId: string }).requestId);
    expect(stored).toMatchObject({ request: { target: { packageId: sourcePackage } } });
    const compatible = await f.router.handle(
      "preview_make_compatible",
      { sourceId: f.source.id, packageId: "tools", harness: "codex" },
      client,
    );
    expect(await f.requests.get((compatible as { requestId: string }).requestId)).toMatchObject({
      request: { packageId: sourcePackage },
    });
    for (const directory of [".agents/plugins", ".claude-plugin"]) {
      await mkdir(join(f.sourceRoot, directory), { recursive: true });
      await writeFile(
        join(f.sourceRoot, directory, "marketplace.json"),
        JSON.stringify({ name: "personal", owner: { name: "Fixture" }, plugins: [] }),
      );
    }
    const newPackageCapture = await f.router.handle(
      "preview_capture",
      {
        projectId: f.project.id,
        relativePath: ".agents/skills/capture-demo",
        target: {
          newPackageName: "captured-tools",
          description: "Use when checking capture history.",
          projectTo: ["codex", "claude-code"],
        },
      },
      client,
    );
    expect(newPackageCapture).toMatchObject({
      requestId: expect.any(String),
      plan: { kind: "import-artifact", visibleIn: expect.arrayContaining(["codex", "claude-code"]) },
    });
    await expectAgentStoresToReload(f.userDataPath);
  });
  it("reports an unknown package with valid ids and no reconnect action", async () => {
    const f = await gateway();
    const result = await f.router.handle(
      "preview_update_skill",
      {
        sourceId: f.source.id,
        packageId: "nope",
        folderName: "demo",
        body: body("demo"),
      },
      client,
    );
    expect(result).toMatchObject({
      status: "blocked",
      details: [{ code: "package-not-found", message: expect.stringContaining(sourcePackage) }],
    });
    expect(JSON.stringify(result)).not.toContain("reconnect");
  });
  it("reports a missing skill separately from incomplete source observation", async () => {
    const f = await gateway();
    await rm(join(f.sourceRoot, sourcePackage, sourceSkill), { recursive: true });
    const result = await f.router.handle(
      "preview_sync_skill",
      { sourceId: f.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
      client,
    );
    expect(result).toMatchObject({ status: "blocked", details: [{ code: "source-skill-unavailable" }] });
    expect(JSON.stringify(result)).not.toContain("reconnect");
  });
  it("reports a missing source-only update target without reconnect", async () => {
    const f = await gateway();
    const result = await f.router.handle(
      "preview_update_skill",
      {
        sourceId: f.source.id,
        packageId: "tools",
        folderName: "gone",
        body: body("gone"),
        sourceOnly: true,
      },
      client,
    );
    expect(result).toMatchObject({ status: "blocked", details: [{ code: "source-skill-unavailable" }] });
    expect(JSON.stringify(result)).not.toContain("reconnect");
  });
  it("keeps reconnect for a real diagnostic covering the source skill folder", async () => {
    const f = await gateway();
    const original = f.registry.observeEntryWithGrant;
    vi.spyOn(f.registry, "observeEntryWithGrant").mockImplementation(
      async (...args: Parameters<RegistryIpcServices["observeEntryWithGrant"]>) => {
        const result = await original(...args);
        if (args[0].kind !== "source" || result.status !== "observed") return result;
        return {
          ...result,
          observation: {
            ...result.observation,
            inventory: {
              ...result.observation.inventory,
              diagnostics: [
                {
                  location: `${sourcePackage}/${sourceSkill}`,
                  code: "inaccessible",
                  severity: "error",
                  message: "Unreadable fixture folder.",
                },
              ],
            },
          },
        };
      },
    );
    expect(
      await f.router.handle(
        "preview_sync_skill",
        { sourceId: f.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
        client,
      ),
    ).toMatchObject({
      status: "blocked",
      details: [{ code: "source-observation-incomplete", recoveryAction: "reconnect" }],
    });
  });
});
