import { mkdir, readFile, realpath, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { seedFixture, treeDigest, sourcePackage, sourceSkill } from "./skill-adoption-fixture";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { expectAgentStoresToReload } from "../helpers/agent-store-reload";
import { createSettingsStore, settingsFilePath } from "../../src/main/settings-store";
import { REGISTRY_IPC_CHANNELS } from "../../src/shared/registry-ipc";
import { handlers, run } from "../ipc/apply-ipc-helpers";

// Keep project fixtures inside the disposable profile; no owner or real project is touched.
async function setup(home?: "profile") {
  const f = await seedFixture();
  await mkdir(join(f.userDataPath, "new-project"));
  await mkdir(join(f.userDataPath, "sibling-project"));
  const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
  const operations = registerOperationsIpcHandlers(() => undefined, f.registry, {
    userDataPath: f.userDataPath,
    bindings: f.bindings,
    applyRestore: f.applyRestore,
    projectRegistrationPolicy: {
      homeDir: home === "profile" ? await realpath(f.userDataPath) : "/fixture-home",
      systemRoots: ["/System"],
      temporaryRoots: [],
    },
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
    agents: { approval: { ...settings.agents.approval, projects: "conversation" }, guard: settings.agents.guard },
  });
  const { createAgentRouter } = await import("../../src/main/agent-gateway/router");
  const router = createAgentRouter({
    userDataPath: f.userDataPath,
    registry: f.registry,
    operations,
    bindings: f.bindings,
    requests,
    settingsStore,
  });
  const cwd = await realpath(join(f.userDataPath, "new-project"));
  return {
    ...f,
    router,
    operations,
    requests,
    settingsStore,
    cwd,
    client: { name: "test", version: "1", harness: "codex" as const, cwd },
  };
}

describe("agent project registration", () => {
  it.each([false, true])(
    "registers a sibling with Git=%s, exposes registry/grants, chains assignment and archives on Undo",
    async (repository) => {
      const f = await setup();
      const target = await realpath(join(f.userDataPath, "sibling-project"));
      if (repository) await run("git", ["init", "-q", target]);
      const before = await treeDigest(target);
      const preview = (await f.router.handle(
        "preview_register_project",
        { path: target, reason: "Assign the chosen skill." },
        f.client,
      )) as { requestId: string };
      expect(preview).toMatchObject({ approval: "conversation", plan: { kind: "register-project", actions: [] } });
      await expectAgentStoresToReload(f.userDataPath);
      const result = (await f.router.handle("apply", { requestId: preview.requestId }, f.client)) as {
        projectId: string;
        receipt: { operationId: string };
      };
      expect(result).toMatchObject({
        status: "applied",
        projectId: expect.any(String),
        receipt: { project: { id: expect.any(String) } },
      });
      expect(await treeDigest(target)).toBe(before);
      expect(await handlers.get(REGISTRY_IPC_CHANNELS.listRegistry)!({}, {})).toMatchObject({
        registry: {
          projects: expect.arrayContaining([
            expect.objectContaining({ ref: { kind: "project", id: result.projectId } }),
          ]),
        },
      });
      expect(await f.registry.getGrantForEntry({ kind: "project", id: result.projectId })).toEqual(expect.any(String));
      expect(await f.router.handle("receipt", { requestId: preview.requestId }, f.client)).toMatchObject({
        status: "found",
        receipt: { project: { id: result.projectId } },
      });
      expect(await f.router.handle("apply", { requestId: preview.requestId }, f.client)).toMatchObject({
        status: "applied",
        projectId: result.projectId,
      });
      await expectAgentStoresToReload(f.userDataPath);
      expect(
        await f.router.handle(
          "preview_assign",
          {
            sourceId: f.source.id,
            packageId: sourcePackage,
            artifactPath: sourceSkill,
            projectIds: [result.projectId],
            harnesses: ["codex"],
          },
          f.client,
        ),
      ).toMatchObject({ requestId: expect.any(String) });
      const undo = await f.operations.previewOperation({
        kind: "restore-import",
        operationId: result.receipt.operationId,
      });
      expect(undo.status).toBe("ready");
      if (undo.status !== "ready") throw new Error("Missing Undo.");
      expect(await f.operations.applyOperation({ planId: undo.plan.planId })).toMatchObject({ status: "applied" });
      expect(await f.registry.listRegistry()).toMatchObject({
        registry: {
          projects: expect.arrayContaining([
            expect.objectContaining({ ref: { kind: "project", id: result.projectId }, archivedAt: expect.any(String) }),
          ]),
        },
      });
      expect(await treeDigest(target)).toBe(before);
    },
  );
  it("returns an active project's id without a preview request or registry write", async () => {
    const f = await setup();
    const client = f.client;
    const before = await readFile(join(f.userDataPath, "omni/project-source-registry.json"), "utf8");
    expect(
      await f.router.handle("preview_register_project", { path: await realpath(f.projectRoot) }, client),
    ).toMatchObject({
      status: "ready",
      projectId: f.project.id,
    });
    expect(await f.requests.all()).toHaveLength(0);
    expect(await readFile(join(f.userDataPath, "omni/project-source-registry.json"), "utf8")).toBe(before);
  });
  it("restores an archived project with the same id", async () => {
    const f = await setup();
    const listed = await f.registry.listRegistry();
    if (listed.status !== "ready") throw new Error("Missing registry.");
    await handlers.get(REGISTRY_IPC_CHANNELS.archiveEntry)!(
      {},
      { kind: "project", id: f.project.id, expectedRevision: listed.registry.revision },
    );
    const client = f.client;
    const preview = (await f.router.handle(
      "preview_register_project",
      { path: await realpath(f.projectRoot) },
      client,
    )) as { requestId: string };
    expect(preview).toMatchObject({ plan: { projectRegistration: { action: "restore", projectId: f.project.id } } });
    await expectAgentStoresToReload(f.userDataPath);
    expect(await f.router.handle("apply", { requestId: preview.requestId }, client)).toMatchObject({
      status: "applied",
      projectId: f.project.id,
    });
    await expectAgentStoresToReload(f.userDataPath);
  });
  it("honours Omni approval and applies through the existing Desktop operation API", async () => {
    const f = await setup();
    const settings = await f.settingsStore.read();
    await f.settingsStore.set({
      commitChanges: settings.git.commitChanges,
      ai: settings.ai,
      features: settings.features,
      externalLibrary: settings.externalLibrary,
      agents: { ...settings.agents, approval: { ...settings.agents.approval, projects: "omni" } },
    });
    const preview = (await f.router.handle("preview_register_project", {}, f.client)) as { requestId: string };
    expect(preview).toMatchObject({ approval: "omni", approvalReason: { code: "projects-setting" } });
    expect(await f.router.handle("apply", { requestId: preview.requestId, waitMs: 0 }, f.client)).toMatchObject({
      status: "pending",
    });
    const refreshed = await f.router.refreshAgentRequest(preview.requestId);
    const lease = await f.requests.acquireApplyAuthorization(preview.requestId);
    if (refreshed.plan.kind === "assign") throw new Error("Wrong plan.");
    const applied = await f.operations.applyOperation({
      planId: refreshed.plan.planId,
      provenance: { approval: "omni" },
    });
    if (!applied) throw new Error("Missing apply result.");
    await f.requests.recordApplyOutcome(
      preview.requestId,
      [applied.receipt.operationId],
      { status: "applied" },
      { mode: "omni", at: lease.approvedAt, harness: "codex" },
      lease.leaseId,
    );
    await f.requests.releaseApplyAuthorization(preview.requestId, lease.leaseId);
    expect(await f.router.handle("apply", { requestId: preview.requestId }, f.client)).toMatchObject({
      status: "applied",
      projectId: applied.receipt.project?.id,
    });
  });
  it("blocks explicit marketplace roots without requests", async () => {
    const f = await setup();
    expect(
      await f.router.handle("preview_register_project", { path: await realpath(f.sourceRoot) }, f.client),
    ).toMatchObject({ status: "blocked", reason: "project-marketplace-overlap" });
    expect(await f.requests.all()).toHaveLength(0);
  });
  it("accepts an absolute path without caller cwd and reloads its durable request", async () => {
    const f = await setup();
    const client = { name: "test", version: "1", harness: "codex" as const };
    const preview = (await f.router.handle("preview_register_project", { path: f.cwd }, client)) as {
      requestId: string;
    };
    expect(preview).toMatchObject({ requestId: expect.any(String) });
    await expectAgentStoresToReload(f.userDataPath);
    expect(await f.router.handle("apply", { requestId: preview.requestId }, client)).toMatchObject({
      status: "applied",
      projectId: expect.any(String),
    });
  });
  it.each([undefined, "../sibling-project"])("blocks path %s without caller cwd", async (path) => {
    const f = await setup();
    expect(
      await f.router.handle("preview_register_project", path ? { path } : {}, { ...f.client, cwd: undefined }),
    ).toMatchObject({ status: "blocked", reason: "project-cwd-unavailable" });
    expect(await f.requests.all()).toHaveLength(0);
  });
  it("resolves a relative sibling path against the caller folder", async () => {
    const f = await setup();
    expect(await f.router.handle("preview_register_project", { path: "../sibling-project" }, f.client)).toMatchObject({
      plan: { projectRegistration: { path: await realpath(join(f.userDataPath, "sibling-project")) } },
    });
  });
  it("names both folders for a sibling and only one for the session folder", async () => {
    const f = await setup();
    const target = await realpath(join(f.userDataPath, "sibling-project"));
    const sibling = (await f.router.handle("preview_register_project", { path: target }, f.client)) as {
      plan: { notes: string[] };
    };
    expect(sibling.plan.notes[0]).toBe(
      `Register project sibling-project (${target}) — not this session's folder (${f.cwd}). Omni will read its skills; nothing is written in the folder. Undo archives it.`,
    );
    const own = (await f.router.handle("preview_register_project", {}, f.client)) as { plan: { notes: string[] } };
    expect(own.plan.notes[0]).toBe(
      `Register project new-project (${f.cwd}). Omni will read its skills; nothing is written in the folder. Undo archives it.`,
    );
  });
  it("blocks an explicit target when the registry is unavailable", async () => {
    const f = await setup();
    vi.spyOn(f.registry, "listRegistry").mockResolvedValue({
      status: "corrupt",
      diagnostic: "Registry fixture is unavailable.",
      recoveryAvailable: false,
    });
    expect(await f.router.handle("preview_register_project", { path: f.cwd }, f.client)).toMatchObject({
      status: "blocked",
      reason: "registry-unavailable",
    });
    expect(await f.requests.all()).toHaveLength(0);
  });
  it("names both home-relative folders and identifies a sibling Git root", async () => {
    const f = await setup("profile");
    const target = await realpath(join(f.userDataPath, "sibling-project"));
    await run("git", ["init", "-q", target]);
    await mkdir(join(target, "docs"));
    const preview = (await f.router.handle(
      "preview_register_project",
      { path: "../sibling-project/docs" },
      f.client,
    )) as { plan: { notes: string[] } };
    expect(preview.plan.notes[0]).toBe(
      "Register project sibling-project (~/sibling-project, git root) — not this session's folder (~/new-project). Omni will read its skills; nothing is written in the folder. Undo archives it.",
    );
  });
  it("keeps a session inside the target Git root in a single-folder summary", async () => {
    const f = await setup();
    await run("git", ["init", "-q", f.cwd]);
    const docs = join(f.cwd, "docs");
    await mkdir(docs);
    const preview = (await f.router.handle(
      "preview_register_project",
      { path: f.cwd },
      { ...f.client, cwd: docs },
    )) as { plan: { notes: string[] } };
    expect(preview.plan.notes[0]).toBe(
      `Register project new-project (${f.cwd}, git root). Omni will read its skills; nothing is written in the folder. Undo archives it.`,
    );
  });
  it("blocks an explicit target when a marketplace locator is unavailable", async () => {
    const f = await setup();
    vi.spyOn(f.registry as Required<typeof f.registry>, "getRegisteredLocator").mockResolvedValue(undefined);
    expect(await f.router.handle("preview_register_project", { path: f.cwd }, f.client)).toMatchObject({
      status: "blocked",
      reason: "registry-unavailable",
    });
    expect(await f.requests.all()).toHaveLength(0);
  });
  it("refuses to apply an explicit target after its inode changes", async () => {
    const f = await setup();
    const preview = (await f.router.handle("preview_register_project", { path: "../sibling-project" }, f.client)) as {
      requestId: string;
    };
    const target = join(f.userDataPath, "sibling-project");
    await rename(target, target + "-moved");
    await mkdir(target);
    expect(await f.router.handle("apply", { requestId: preview.requestId }, f.client)).toMatchObject({
      status: "stale",
    });
  });
  it("refuses to apply an explicit target after the registry revision changes", async () => {
    const f = await setup();
    const preview = (await f.router.handle("preview_register_project", { path: "../sibling-project" }, f.client)) as {
      requestId: string;
    };
    await f.registerProjectRoot(f.cwd);
    expect(await f.router.handle("apply", { requestId: preview.requestId }, f.client)).toMatchObject({
      status: "stale",
    });
  });
  it("refuses to apply when a previewed folder is replaced by a symlink", async () => {
    const f = await setup();
    const preview = (await f.router.handle(
      "preview_register_project",
      { path: f.cwd },
      { ...f.client, cwd: await realpath(f.projectRoot) },
    )) as { requestId: string };
    await rename(f.cwd, f.cwd + "-moved");
    await symlink(f.cwd + "-moved", f.cwd);
    expect(await f.router.handle("apply", { requestId: preview.requestId }, f.client)).toMatchObject({
      status: "stale",
    });
  });
});
