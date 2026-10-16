import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallAgentsOperations } from "../../src/main/operations-install-agents";
import { createDisconnectAgentsOperations } from "../../src/main/operations-disconnect-agents";
import { createAgentMaintenance } from "../../src/main/agent-maintenance";
import { createOperationStore } from "../../src/main/operation-store";
import { createSettingsStore, settingsFilePath } from "../../src/main/settings-store";
import { createRestoreOperations } from "../../src/main/operations-restore";
import { observeAgentHarnesses } from "../../src/main/agent-harnesses";
import type { OmniSkillBundle } from "../../src/main/omni-skills-bundle";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const bundle: OmniSkillBundle = [
  {
    name: "omni-lessons",
    files: [{ relativePath: "SKILL.md", content: "---\nname: omni-lessons\ndescription: Lessons\n---\n# Lessons\n" }],
  },
];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "omni-maintenance-"));
  roots.push(root);
  const options = {
    homeDir: join(root, "home"),
    userDataPath: join(root, "data"),
    cliPath: join(root, "cli.js"),
    guardPath: join(root, "omni-guard.mjs"),
    bundle,
  };
  await mkdir(join(options.homeDir, ".claude"), { recursive: true });
  await mkdir(join(options.homeDir, ".codex"), { recursive: true });
  await writeFile(options.cliPath, "cli");
  const operationStore = createOperationStore(join(options.userDataPath, "omni", "operations.json"));
  const settingsStore = createSettingsStore(settingsFilePath(options.userDataPath));
  const install = createInstallAgentsOperations({ ...options, operationStore });
  const preview = await install.preview({ kind: "install-agents", harnesses: ["claude-code"] });
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  expect((await install.apply({ planId: preview.plan.planId }))?.status).toBe("applied");
  return { ...options, operationStore, settingsStore };
}
describe("automatic agent maintenance", () => {
  it("updates both connected agents in one automatic receipt and restores both with one Undo", async () => {
    const options = await setup();
    const install = createInstallAgentsOperations(options);
    const connect = await install.preview({ kind: "install-agents", harnesses: ["codex"] });
    if (connect.status !== "ready") throw new Error(connect.diagnostic);
    expect((await install.apply({ planId: connect.plan.planId }))?.status).toBe("applied");
    const updatedBundle: OmniSkillBundle = [
      { ...bundle[0]!, files: [{ relativePath: "SKILL.md", content: bundle[0]!.files[0]!.content + "new release\n" }] },
    ];
    const service = createAgentMaintenance({ ...options, bundle: updatedBundle, version: "1.2.3" });
    await service.start();
    expect(service.snapshot().notice?.harnesses).toEqual(["claude-code", "codex"]);
    const loaded = await options.operationStore.read();
    if (loaded.status !== "ready") throw new Error(loaded.diagnostic);
    const updates = loaded.receipts.filter((receipt) => receipt.agentSetup?.action === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      agentSetup: { harnesses: ["claude-code", "codex"] },
      provenance: { approval: "automatic" },
    });
    expect(updates[0]!.files).toHaveLength(2);
    const restore = createRestoreOperations({ ...options, git: { isGitAvailable: async () => false } as never });
    const undo = await restore.preview({ kind: "restore-import", operationId: updates[0]!.operationId });
    if (undo.status !== "ready") throw new Error(undo.diagnostic);
    expect((await restore.apply({ planId: undo.plan.planId }))?.status).toBe("applied");
    for (const path of [".claude", ".codex"])
      expect(await readFile(join(options.homeDir, path, "skills/omni-lessons/SKILL.md"), "utf8")).toBe(
        bundle[0]!.files[0]!.content,
      );
  });
  it("reports inspection failure for one agent and still updates the other", async () => {
    const options = await setup();
    await mkdir(join(options.homeDir, ".codex/config.toml"));
    const service = createAgentMaintenance({ ...options, version: "1.2.3" });
    await service.start();
    expect(service.snapshot().notice?.harnesses).toEqual(["claude-code"]);
    expect(service.snapshot().failures).toEqual([
      expect.objectContaining({ harness: "codex", reason: expect.any(String) }),
    ]);
    await service.start();
    expect(service.snapshot().failures).toHaveLength(1);
  });
  it("updates only registered agents once per launch and records the version and automatic receipt", async () => {
    const options = await setup();
    const service = createAgentMaintenance({ ...options, version: "1.2.3" });
    await Promise.all([service.start(), service.start()]);
    expect((await options.settingsStore.read()).agents.installedByVersion).toBe("1.2.3");
    const state = service.snapshot();
    expect(state.notice).toMatchObject({ version: "1.2.3", harnesses: ["claude-code"] });
    const loaded = await options.operationStore.read();
    if (loaded.status !== "ready") throw new Error(loaded.diagnostic);
    expect(loaded.receipts).toHaveLength(2);
    expect(loaded.receipts[0]).toMatchObject({
      agentSetup: { action: "update", harnesses: ["claude-code"], version: "1.2.3" },
      provenance: { approval: "automatic" },
    });
    expect((await observeAgentHarnesses(options)).find((agent) => agent.harness === "codex")?.registered).toBe(false);
    const again = createAgentMaintenance({ ...options, version: "1.2.3" });
    await again.start();
    expect(again.snapshot().notice).toBeUndefined();
    const second = await options.operationStore.read();
    expect(second.status === "ready" && second.receipts.length).toBe(2);
  });
  it("repairs an outdated connected agent at the same version and preserves the version on settings edits", async () => {
    const options = await setup();
    await options.settingsStore.recordAgentVersion("1.2.3");
    const stale = await options.settingsStore.read();
    const updatedBundle: OmniSkillBundle = [
      {
        ...bundle[0]!,
        files: [{ relativePath: "SKILL.md", content: bundle[0]!.files[0]!.content + "updated bundle\n" }],
      },
    ];
    const service = createAgentMaintenance({ ...options, bundle: updatedBundle, version: "1.2.3" });
    await service.start();
    expect(service.snapshot().notice?.harnesses).toEqual(["claude-code"]);
    await options.settingsStore.recordAgentVersion("1.2.4");
    await options.settingsStore.set({
      commitChanges: false,
      agents: stale.agents,
      ai: stale.ai,
      features: stale.features,
      externalLibrary: stale.externalLibrary,
    });
    expect((await options.settingsStore.read()).agents.installedByVersion).toBe("1.2.4");
  });
  it("keeps local skill edits during unattended updates", async () => {
    const options = await setup();
    const file = join(options.homeDir, ".claude/skills/omni-lessons/SKILL.md");
    const edited = bundle[0]!.files[0]!.content + "my notes\n";
    await writeFile(file, edited);
    const service = createAgentMaintenance({ ...options, version: "1.2.3" });
    await service.start();
    expect(service.snapshot().failures).toEqual([
      expect.objectContaining({ harness: "claude-code", reason: expect.stringContaining("local edits") }),
    ]);
    expect(await readFile(file, "utf8")).toBe(edited);
    expect((await options.settingsStore.read()).agents.installedByVersion).toBeUndefined();
  });
  it("skips foreign skills and records an actionable failure without a retry loop", async () => {
    const options = await setup();
    const file = join(options.homeDir, ".claude/skills/omni-lessons/SKILL.md");
    await writeFile(file, "---\nname: another-tool\n---\n");
    const foreign = createAgentMaintenance({ ...options, version: "1.2.3" });
    await foreign.start();
    expect(foreign.snapshot().notice).toBeUndefined();
    expect(await readFile(file, "utf8")).toContain("another-tool");
    await writeFile(file, bundle[0]!.files[0]!.content);
    await rm(options.cliPath);
    const failed = createAgentMaintenance({ ...options, version: "1.2.3" });
    await failed.start();
    await failed.start();
    expect(failed.snapshot().failures).toEqual([
      expect.objectContaining({ harness: "claude-code", reason: expect.stringContaining("Build") }),
    ]);
    expect((await options.settingsStore.read()).agents.installedByVersion).toBeUndefined();
    await writeFile(options.cliPath, "cli");
    await failed.retry({ harness: "claude-code" });
    expect(failed.snapshot().failures).toEqual([]);
    await expect(failed.retry({ harness: "codex" })).rejects.toThrow();
  });
});
describe("agent disconnection", () => {
  it("removes older supplied Omni bytes when their installation receipt proves ownership", async () => {
    const options = await setup();
    const newBundle: OmniSkillBundle = [
      { ...bundle[0]!, files: [{ relativePath: "SKILL.md", content: bundle[0]!.files[0]!.content + "new bundle\n" }] },
    ];
    const operations = createDisconnectAgentsOperations({ ...options, bundle: newBundle });
    const preview = await operations.preview({ kind: "disconnect-agents", harnesses: ["claude-code"] });
    if (preview.status !== "ready") throw new Error(preview.diagnostic);
    expect((await operations.apply({ planId: preview.plan.planId }))?.status).toBe("applied");
    await expect(readFile(join(options.homeDir, ".claude/skills/omni-lessons/SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("restores a connection after its empty provider manifest is removed", async () => {
    const options = await setup();
    const operations = createDisconnectAgentsOperations(options);
    const preview = await operations.preview({ kind: "disconnect-agents", harnesses: ["claude-code"] });
    if (preview.status !== "ready") throw new Error(preview.diagnostic);
    const result = await operations.apply({ planId: preview.plan.planId });
    await rm(join(options.homeDir, ".claude.json"));
    await rm(join(options.homeDir, ".claude/settings.json"));
    const restore = createRestoreOperations({ ...options, git: { isGitAvailable: async () => false } as never });
    const undo = await restore.preview({ kind: "restore-import", operationId: result!.receipt.operationId });
    if (undo.status !== "ready") throw new Error(undo.diagnostic);
    expect((await restore.apply({ planId: undo.plan.planId }))?.status).toBe("applied");
    expect((await observeAgentHarnesses(options))[0]).toMatchObject({ registered: true, guard: true });
  });
  it("preserves a recreated skill instead of overwriting it during undo", async () => {
    const options = await setup();
    const operations = createDisconnectAgentsOperations(options);
    const preview = await operations.preview({ kind: "disconnect-agents", harnesses: ["claude-code"] });
    if (preview.status !== "ready") throw new Error(preview.diagnostic);
    const result = await operations.apply({ planId: preview.plan.planId });
    const directory = join(options.homeDir, ".claude/skills/omni-lessons");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "later content\n");
    const restore = createRestoreOperations({ ...options, git: { isGitAvailable: async () => false } as never });
    expect(await restore.preview({ kind: "restore-import", operationId: result!.receipt.operationId })).toMatchObject({
      status: "blocked",
      reason: "restore-drift",
    });
    expect(await readFile(join(directory, "SKILL.md"), "utf8")).toBe("later content\n");
  });
  it.each(["claude-code", "codex"] as const)(
    "uses OMNI_AGENT_HOME for %s writes, disconnection and restore without an explicit home",
    async (harness) => {
      const options = await setup();
      vi.stubEnv("OMNI_AGENT_HOME", options.homeDir);
      const { homeDir: _home, ...development } = options;
      const install = createInstallAgentsOperations({ ...development, isPackaged: false });
      const preview = await install.preview({ kind: "install-agents", harnesses: [harness], force: true });
      if (preview.status !== "ready") throw new Error(preview.diagnostic);
      expect((await install.apply({ planId: preview.plan.planId }))?.status).toBe("applied");
      const operations = createDisconnectAgentsOperations(development);
      const disconnect = await operations.preview({ kind: "disconnect-agents", harnesses: [harness] });
      if (disconnect.status !== "ready") throw new Error(disconnect.diagnostic);
      const removed = await operations.apply({ planId: disconnect.plan.planId });
      expect(removed?.status).toBe("applied");
      const restore = createRestoreOperations({ ...development, git: { isGitAvailable: async () => false } as never });
      const undo = await restore.preview({ kind: "restore-import", operationId: removed!.receipt.operationId });
      if (undo.status !== "ready") throw new Error(undo.diagnostic);
      expect((await restore.apply({ planId: undo.plan.planId }))?.status).toBe("applied");
      expect((await observeAgentHarnesses(development)).find((agent) => agent.harness === harness)).toMatchObject({
        registered: true,
        current: true,
        guard: true,
      });
    },
  );
  it("reports a partial rollback and preserves edits made after the operation wrote a file", async () => {
    const options = await setup();
    const path = join(options.homeDir, ".claude/skills/omni-lessons/SKILL.md");
    const operationStore = {
      ...options.operationStore,
      append: async () => {
        await writeFile(path, "a concurrent edit\n");
        return { status: "corrupt" as const, diagnostic: "disk unavailable", recoveryAvailable: false };
      },
    };
    const install = createInstallAgentsOperations({ ...options, operationStore });
    const preview = await install.preview({ kind: "install-agents", harnesses: ["claude-code"], force: true });
    if (preview.status !== "ready") throw new Error(preview.diagnostic);
    const result = await install.apply({ planId: preview.plan.planId });
    expect(result?.status).toBe("failed");
    expect(result?.receipt.diagnostic).toContain("Some files could not be restored");
    expect(result?.receipt.actions.find((action) => action.relativePath.endsWith("SKILL.md"))?.status).toBe("failed");
    expect(await readFile(path, "utf8")).toBe("a concurrent edit\n");
  });
  it("removes only Omni files and entries and restores them alongside later provider edits", async () => {
    const options = await setup();
    const configPath = join(options.homeDir, ".claude.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.mcpServers.other = { command: "other" };
    await writeFile(configPath, JSON.stringify(config));
    await mkdir(join(options.homeDir, ".claude/skills/user-skill"), { recursive: true });
    await writeFile(join(options.homeDir, ".claude/skills/user-skill/SKILL.md"), "user content");
    const operations = createDisconnectAgentsOperations(options);
    const preview = await operations.preview({ kind: "disconnect-agents", harnesses: ["claude-code"] });
    if (preview.status !== "ready") throw new Error(preview.diagnostic);
    const result = await operations.apply({ planId: preview.plan.planId });
    expect(result?.status).toBe("applied");
    expect(JSON.parse(await readFile(configPath, "utf8")).mcpServers).toEqual({ other: { command: "other" } });
    await expect(readFile(join(options.homeDir, ".claude/skills/omni-lessons/SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(options.homeDir, ".claude/skills/user-skill/SKILL.md"), "utf8")).toBe("user content");
    const after = JSON.parse(await readFile(configPath, "utf8"));
    after.theme = "light";
    await writeFile(configPath, JSON.stringify(after));
    const restore = createRestoreOperations({ ...options, git: { isGitAvailable: async () => false } as never });
    const undo = await restore.preview({ kind: "restore-import", operationId: result!.receipt.operationId });
    if (undo.status !== "ready") throw new Error(undo.diagnostic);
    expect((await restore.apply({ planId: undo.plan.planId }))?.status).toBe("applied");
    const restored = JSON.parse(await readFile(configPath, "utf8"));
    expect(restored.theme).toBe("light");
    expect(restored.mcpServers.omni).toBeDefined();
    expect((await observeAgentHarnesses(options))[0]?.guard).toBe(true);
  });
  it("disconnects while keeping a locally modified Omni skill", async () => {
    const options = await setup();
    await writeFile(
      join(options.homeDir, ".claude/skills/omni-lessons/SKILL.md"),
      bundle[0]!.files[0]!.content + "my edits\n",
    );
    const operations = createDisconnectAgentsOperations(options);
    const preview = await operations.preview({
      kind: "disconnect-agents",
      harnesses: ["claude-code"],
    });
    if (preview.status !== "ready") throw new Error(preview.diagnostic);
    expect((await operations.apply({ planId: preview.plan.planId }))?.status).toBe("applied");
    expect((await observeAgentHarnesses(options))[0]?.registered).toBe(false);
    expect(await readFile(join(options.homeDir, ".claude/skills/omni-lessons/SKILL.md"), "utf8")).toContain("my edits");
  });
});
