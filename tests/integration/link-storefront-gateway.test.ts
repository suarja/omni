import { mkdir, readFile, realpath, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedFixture, treeDigest } from "./skill-adoption-fixture";
import { root, run } from "../ipc/apply-ipc-helpers";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { createSettingsStore, settingsFilePath } from "../../src/main/settings-store";
import { expectAgentStoresToReload } from "../helpers/agent-store-reload";

async function setup() {
  const f = await seedFixture();
  const storefront = await realpath(await root("storefront"));
  const bare = await root("bare");
  await run("git", ["init", "--bare", "-q", bare]);
  for (const path of [f.sourceRoot, storefront]) {
    await run("git", ["init", "-q", path]);
    await run("git", ["-C", path, "config", "user.name", "Fixture"]);
    await run("git", ["-C", path, "config", "user.email", "fixture@example.com"]);
  }
  // The workshop identity is read locally; no GitHub request or remote mutation occurs.
  await run("git", ["-C", f.sourceRoot, "remote", "add", "origin", "https://github.com/fixture/workshop.git"]);
  await run("git", ["-C", f.sourceRoot, "add", "."]);
  await run("git", ["-C", f.sourceRoot, "commit", "-qm", "Fixture"]);
  const commit = (await run("git", ["-C", f.sourceRoot, "rev-parse", "HEAD"])).stdout.trim();
  await run("git", ["-C", storefront, "remote", "add", "origin", bare]);
  for (const name of ["tools", "foreign"]) {
    await mkdir(join(storefront, `plugins/${name}/.claude-plugin`), { recursive: true });
    await writeFile(join(storefront, `plugins/${name}/.claude-plugin/plugin.json`), JSON.stringify({ name }));
  }
  await writeFile(
    join(storefront, "plugins/tools/ORIGIN.md"),
    `# Origin\n\n- Source repository: fixture/workshop (private)\n- Source path: packages/tools\n- Source commit: ${commit}\n- Published: 2026-10-17\n`,
  );
  await run("git", ["-C", storefront, "add", "."]);
  await run("git", ["-C", storefront, "commit", "-qm", "Fixture storefront"]);
  const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
  const operations = registerOperationsIpcHandlers(() => undefined, f.registry, {
    userDataPath: f.userDataPath,
    bindings: f.bindings,
    applyRestore: f.applyRestore,
  });
  await operations.skillManagement.initialize();
  const requests = createAgentRequestsStore(join(f.userDataPath, "omni/agent-requests.json"));
  const settingsStore = createSettingsStore(settingsFilePath(f.userDataPath));
  const settings = await settingsStore.read();
  await settingsStore.set({
    commitChanges: settings.git.commitChanges,
    ai: settings.ai,
    features: settings.features,
    externalLibrary: settings.externalLibrary,
    agents: { ...settings.agents, approval: { ...settings.agents.approval, personalMarketplace: "conversation" } },
  });
  const { createAgentRouter } = await import("../../src/main/agent-gateway/router");
  const router = createAgentRouter({ ...f, operations, requests, settingsStore });
  return {
    ...f,
    storefront,
    bare,
    commit,
    router,
    requests,
    operations,
    settingsStore,
    client: { name: "test", version: "1", harness: "codex" as const, cwd: storefront },
  };
}

describe("agent storefront linking", () => {
  it("previews origins without writes, applies, replays and archives the link on Undo", async () => {
    const f = await setup();
    const before = await treeDigest(f.storefront);
    const preview = (await f.router.handle(
      "preview_link_storefront",
      { path: ".", reason: "Share tools." },
      f.client,
    )) as { requestId: string };
    if (process.env.OMNI_SH1_PREVIEW_EVIDENCE === "1") console.info("SH1_PREVIEW " + JSON.stringify(preview));
    expect(preview).toMatchObject({
      approval: "conversation",
      plan: {
        kind: "link-storefront",
        actions: [],
        storefrontLink: {
          path: f.storefront,
          action: "link",
          inspection: {
            plugins: [
              { pluginId: "foreign", recognition: "not-from-your-marketplace" },
              {
                pluginId: "tools",
                recognition: "recognized",
                origin: { sourcePath: "packages/tools", sourceCommit: f.commit },
              },
            ],
          },
          unlinkedPlugins: [{ pluginId: "foreign", reason: expect.stringContaining("ORIGIN.md") }],
        },
      },
    });
    expect(await treeDigest(f.storefront)).toBe(before);
    await expectAgentStoresToReload(f.userDataPath);
    const applied = (await f.router.handle("apply", { requestId: preview.requestId }, f.client)) as {
      storefrontId: string;
      receipt: { operationId: string };
    };
    expect(applied).toMatchObject({ status: "applied", storefrontId: expect.any(String) });
    expect(
      JSON.parse(await readFile(join(f.userDataPath, "omni/publications.json"), "utf8")).publications,
    ).toMatchObject([{ pluginId: "tools", baseCommit: f.commit }]);
    expect(await f.router.handle("apply", { requestId: preview.requestId }, f.client)).toMatchObject({
      storefrontId: applied.storefrontId,
    });
    const registryBefore = await readFile(join(f.userDataPath, "omni/project-source-registry.json"), "utf8");
    expect(
      await f.router.handle("preview_link_storefront", { path: f.storefront }, { ...f.client, cwd: undefined }),
    ).toMatchObject({ status: "ready", storefrontId: applied.storefrontId });
    expect(await f.requests.all()).toHaveLength(1);
    expect(await readFile(join(f.userDataPath, "omni/project-source-registry.json"), "utf8")).toBe(registryBefore);
    const undo = (await f.router.handle("preview_restore", { operationId: applied.receipt.operationId }, f.client)) as {
      requestId: string;
    };
    expect(await f.router.handle("apply", { requestId: undo.requestId }, f.client)).toMatchObject({
      status: "applied",
    });
    expect(await f.registry.listRegistry()).toMatchObject({
      registry: {
        sources: expect.arrayContaining([
          expect.objectContaining({
            ref: { kind: "source", id: applied.storefrontId },
            archivedAt: expect.any(String),
          }),
        ]),
      },
    });
    expect(await treeDigest(f.storefront)).toBe(before);
    const restored = (await f.router.handle("preview_link_storefront", { path: "." }, f.client)) as {
      requestId: string;
    };
    expect(await f.router.handle("apply", { requestId: restored.requestId }, f.client)).toMatchObject({
      storefrontId: applied.storefrontId,
    });
    await expectAgentStoresToReload(f.userDataPath);
  });
  it.each(["workshop", "project", "external"])("refuses the %s role before requesting approval", async (role) => {
    const f = await setup();
    const path = role === "workshop" ? f.sourceRoot : role === "project" ? f.projectRoot : f.storefront;
    if (role === "external") {
      const { createLocalJsonRegistryStore } = await import("../../src/adapters/registry/local-json");
      const { registerSource } = await import("../../src/domain/project-source-registry");
      const registry = createLocalJsonRegistryStore(join(f.userDataPath, "omni/project-source-registry.json"));
      const loaded = await registry.read();
      if (loaded.status !== "ready") throw new Error("Missing registry.");
      const mutation = await registry.mutate(
        loaded.state.revision,
        (state) =>
          registerSource(state, {
            displayName: "External",
            canonicalPath: path,
            ownership: "external",
            createdAt: new Date().toISOString(),
          }).nextState,
      );
      expect(mutation.status).toBe("ready");
    }
    expect(await f.router.handle("preview_link_storefront", { path }, f.client)).toMatchObject({
      status: "blocked",
      reason: "storefront-classification-conflict",
      diagnostic: expect.stringContaining(role),
    });
    expect(await f.requests.all()).toHaveLength(0);
  });
  it("rejects malformed gateway inputs and a relative path without caller cwd", async () => {
    const f = await setup();
    for (const params of [
      {},
      { path: "" },
      { path: 1 },
      { path: ".", extra: true },
      { path: ".", reason: 3 },
      { path: "bad\u0000path" },
    ])
      await expect(f.router.handle("preview_link_storefront", params, f.client)).rejects.toThrow();
    expect(
      await f.router.handle("preview_link_storefront", { path: "." }, { ...f.client, cwd: undefined }),
    ).toMatchObject({ status: "blocked", reason: "storefront-cwd-unavailable" });
    expect(await f.requests.all()).toHaveLength(0);
  });
  it("uses personalMarketplace Omni approval and supports Desktop apply", async () => {
    const f = await setup();
    const settings = await f.settingsStore.read();
    await f.settingsStore.set({
      commitChanges: settings.git.commitChanges,
      ai: settings.ai,
      features: settings.features,
      externalLibrary: settings.externalLibrary,
      agents: { ...settings.agents, approval: { ...settings.agents.approval, personalMarketplace: "omni" } },
    });
    const preview = (await f.router.handle("preview_link_storefront", { path: "." }, f.client)) as {
      requestId: string;
    };
    expect(preview).toMatchObject({ approval: "omni", approvalReason: { code: "marketplace-setting" } });
    expect(await f.router.handle("apply", { requestId: preview.requestId, waitMs: 0 }, f.client)).toMatchObject({
      status: "pending",
    });
    const refreshed = await f.router.refreshAgentRequest(preview.requestId);
    const lease = await f.requests.acquireApplyAuthorization(preview.requestId);
    if (refreshed.plan.kind === "assign") throw new Error("Wrong plan.");
    const result = await f.operations.applyOperation({
      planId: refreshed.plan.planId,
      provenance: { approval: "omni" },
    });
    if (!result) throw new Error("Missing result.");
    await f.requests.recordApplyOutcome(
      preview.requestId,
      [result.receipt.operationId],
      { status: "applied" },
      { mode: "omni", at: lease.approvedAt, harness: "codex" },
      lease.leaseId,
    );
    await f.requests.releaseApplyAuthorization(preview.requestId, lease.leaseId);
    expect(await f.router.handle("apply", { requestId: preview.requestId }, f.client)).toMatchObject({
      status: "applied",
      storefrontId: expect.any(String),
    });
  });
  it("requires a fresh preview when storefront bytes change", async () => {
    const f = await setup();
    const preview = (await f.router.handle("preview_link_storefront", { path: "." }, f.client)) as {
      requestId: string;
    };
    await writeFile(join(f.storefront, "plugins/tools/README.md"), "New content\n");
    expect(await f.router.handle("apply", { requestId: preview.requestId }, f.client)).toMatchObject({
      status: "stale",
    });
  });
  it("archives a link even when its folder is offline", async () => {
    const f = await setup();
    const preview = (await f.router.handle("preview_link_storefront", { path: "." }, f.client)) as {
      requestId: string;
    };
    const linked = (await f.router.handle("apply", { requestId: preview.requestId }, f.client)) as {
      receipt: { operationId: string };
    };
    await rename(f.storefront, f.storefront + "-offline");
    try {
      const undo = (await f.router.handle(
        "preview_restore",
        { operationId: linked.receipt.operationId },
        f.client,
      )) as { requestId: string };
      expect(undo).toMatchObject({ requestId: expect.any(String), plan: { kind: "archive-storefront", actions: [] } });
      expect(await f.router.handle("apply", { requestId: undo.requestId }, f.client)).toMatchObject({
        status: "applied",
      });
    } finally {
      await rename(f.storefront + "-offline", f.storefront);
    }
  });
  it.each(["inode", "registry"])("requires a fresh preview after the %s changes", async (change) => {
    const f = await setup();
    const preview = (await f.router.handle("preview_link_storefront", { path: "." }, f.client)) as {
      requestId: string;
    };
    if (change === "registry") {
      const project = await root("other-project");
      await f.registerProjectRoot(project);
    } else {
      await rename(f.storefront, f.storefront + "-old");
      await mkdir(f.storefront);
    }
    try {
      expect(await f.router.handle("apply", { requestId: preview.requestId }, f.client)).toMatchObject({
        status: "stale",
      });
    } finally {
      if (change === "inode") {
        const { rm } = await import("node:fs/promises");
        await rm(f.storefront, { recursive: true });
        await rename(f.storefront + "-old", f.storefront);
      }
    }
  });
});
