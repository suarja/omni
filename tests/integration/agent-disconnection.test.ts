import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectAgentHarnesses, harnessPaths } from "../../src/main/agent-harnesses";
import { bundleRoot, readBundle } from "../../src/main/omni-skills-bundle";
import { createDisconnectAgentsOperations } from "../../src/main/operations-disconnect-agents";
import { createRestoreOperations } from "../../src/main/operations-restore";
import { createOperationStore } from "../../src/main/operation-store";
import { createRegisterMcpOperations, planRegisterMcp } from "../../src/main/operations-register-mcp";
import { guardHookEntry, setGuardEntry } from "../../src/main/hook-entry";
import type { AgentHarness } from "../../src/shared/agents-ipc";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function seed(harness: AgentHarness) {
  const root = await mkdtemp(join(tmpdir(), "omni-disconnect-legacy-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const userDataPath = join(root, "data");
  const bundle = await readBundle(bundleRoot());
  const cliPath = join(root, "omni-mcp.mjs");
  const guardPath = join(userDataPath, "omni/guard/omni-guard.mjs");
  const paths = harnessPaths(harness);
  await mkdir(join(homeDir, paths.skills), { recursive: true });
  await writeFile(cliPath, "fixture runtime\n");
  const config = planRegisterMcp({ harness, action: "enable", homeDir, cliPath, userDataPath });
  await writeFile(join(homeDir, paths.settings), config.action!.content!);
  await writeFile(join(homeDir, paths.guardSettings), setGuardEntry(undefined, guardHookEntry(harness, guardPath))!);
  for (const skill of bundle)
    for (const file of skill.files) {
      const path = join(homeDir, paths.skills, skill.name, file.relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
  // Empty descendants must survive Undo even though they have no file hashes.
  await mkdir(join(homeDir, paths.skills, bundle[0]!.name, "references/empty"), { recursive: true });
  const operationStore = createOperationStore(join(userDataPath, "omni/operations.json"));
  return { homeDir, userDataPath, cliPath, guardPath, bundle, operationStore, paths };
}
async function tree(root: string, relative = ""): Promise<readonly string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(`${path}/`, ...(await tree(root, path)));
    } else result.push(`${path}:${await readFile(join(root, path), "utf8")}`);
  }
  return result.sort();
}
describe("legacy agent disconnection and Undo", () => {
  it("restores standalone MCP settings to their exact bytes", async () => {
    const options = await seed("codex");
    const path = join(options.homeDir, options.paths.settings);
    const before = await readFile(path);
    const operations = createRegisterMcpOperations(options);
    const preview = await operations.preview({ kind: "register-mcp", harness: "codex", action: "disable" });
    if (preview.status !== "ready") throw new Error(preview.diagnostic);
    const result = await operations.apply({ planId: preview.plan.planId });
    expect(result?.status).toBe("applied");
    const restore = createRestoreOperations({ ...options, git: { isGitAvailable: async () => false } as never });
    const undo = await restore.preview({ kind: "restore-import", operationId: result!.receipt.operationId });
    if (undo.status !== "ready") throw new Error(undo.diagnostic);
    expect((await restore.apply({ planId: undo.plan.planId }))?.status).toBe("applied");
    expect(await readFile(path)).toEqual(before);
  });
  it.each(["claude-code", "codex"] as const)(
    "keeps %s settings byte-identical through six disconnect and Undo cycles",
    async (harness) => {
      const options = await seed(harness);
      const configPath = join(options.homeDir, options.paths.settings);
      const guardPath = join(options.homeDir, options.paths.guardSettings);
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        harness === "codex"
          ? '# Personal configuration\nmodel = "fixture"\n\n' + config + '\n[appearance]\ntheme = "light"\n\n'
          : JSON.stringify({ theme: "light", ...JSON.parse(config) }) + "\n\n",
      );
      await writeFile(guardPath, JSON.stringify(JSON.parse(await readFile(guardPath, "utf8")), null, "\t") + "\n\n");
      const before = await Promise.all([readFile(configPath), readFile(guardPath)]);
      for (let cycle = 0; cycle < 6; cycle += 1) {
        const operations = createDisconnectAgentsOperations(options);
        const preview = await operations.preview({ kind: "disconnect-agents", harnesses: [harness] });
        if (preview.status !== "ready") throw new Error(preview.diagnostic);
        const result = await operations.apply({ planId: preview.plan.planId });
        expect(result?.status).toBe("applied");
        const restore = createRestoreOperations({ ...options, git: { isGitAvailable: async () => false } as never });
        const undo = await restore.preview({ kind: "restore-import", operationId: result!.receipt.operationId });
        if (undo.status !== "ready") throw new Error(undo.diagnostic);
        expect((await restore.apply({ planId: undo.plan.planId }))?.status).toBe("applied");
        expect(await Promise.all([readFile(configPath), readFile(guardPath)])).toEqual(before);
      }
    },
  );
  it.each(["claude-code", "codex"] as const)(
    "disconnects %s without earlier receipts, inspects missing skills and restores exact directories and files",
    async (harness) => {
      const options = await seed(harness);
      const skillRoot = join(options.homeDir, options.paths.skills);
      const before = await tree(skillRoot);
      const operations = createDisconnectAgentsOperations(options);
      const preview = await operations.preview({ kind: "disconnect-agents", harnesses: [harness] });
      if (preview.status !== "ready") throw new Error(preview.diagnostic);
      const result = await operations.apply({ planId: preview.plan.planId });
      expect(result?.status).toBe("applied");
      expect(await readdir(skillRoot)).toEqual([]);
      const agent = (await inspectAgentHarnesses({ ...options, harnesses: [harness] }))[0]!;
      expect(agent.registered).toBe(false);
      expect(agent.skills.every((skill) => skill.state === "missing")).toBe(true);
      const restore = createRestoreOperations({ ...options, git: { isGitAvailable: async () => false } as never });
      const undo = await restore.preview({ kind: "restore-import", operationId: result!.receipt.operationId });
      if (undo.status !== "ready") throw new Error(undo.diagnostic);
      expect((await restore.apply({ planId: undo.plan.planId }))?.status).toBe("applied");
      expect(await tree(skillRoot)).toEqual(before);
      expect((await inspectAgentHarnesses({ ...options, harnesses: [harness] }))[0]).toMatchObject({
        registered: true,
        guard: true,
      });
    },
  );
  it("keeps every byte of a manually changed legacy skill while disconnecting Codex", async () => {
    const options = await seed("codex");
    const skill = options.bundle[0]!;
    const directory = join(options.homeDir, options.paths.skills, skill.name);
    await writeFile(
      join(directory, "SKILL.md"),
      skill.files.find((file) => file.relativePath === "SKILL.md")!.content + "handwritten notes\n",
    );
    const before = await tree(directory);
    const allSkillsBefore = await tree(join(options.homeDir, options.paths.skills));
    const operations = createDisconnectAgentsOperations(options);
    const preview = await operations.preview({ kind: "disconnect-agents", harnesses: ["codex"] });
    if (preview.status !== "ready") throw new Error(preview.diagnostic);
    const result = await operations.apply({ planId: preview.plan.planId });
    expect(result?.status).toBe("applied");
    expect(await tree(directory)).toEqual(before);
    const agent = (await inspectAgentHarnesses({ ...options, harnesses: ["codex"] }))[0]!;
    expect(agent.registered).toBe(false);
    expect(agent.skills.find((item) => item.name === skill.name)?.state).toBe("outdated");
    expect(await readdir(join(options.homeDir, options.paths.skills))).toEqual([skill.name]);
    const restore = createRestoreOperations({ ...options, git: { isGitAvailable: async () => false } as never });
    const undo = await restore.preview({ kind: "restore-import", operationId: result!.receipt.operationId });
    if (undo.status !== "ready") throw new Error(undo.diagnostic);
    expect((await restore.apply({ planId: undo.plan.planId }))?.status).toBe("applied");
    expect(await tree(join(options.homeDir, options.paths.skills))).toEqual(allSkillsBefore);
  });
  it("reports empty legacy skill directories as missing", async () => {
    const options = await seed("codex");
    const directory = join(options.homeDir, options.paths.skills, options.bundle[0]!.name);
    await rm(directory, { recursive: true });
    await mkdir(directory);
    const agent = (await inspectAgentHarnesses({ ...options, harnesses: ["codex"] }))[0]!;
    expect(agent.skills[0]?.state).toBe("missing");
  });
  it("rolls back disconnection and preserves a file added after the preview", async () => {
    const options = await seed("codex");
    const skillRoot = join(options.homeDir, options.paths.skills);
    const operations = createDisconnectAgentsOperations(options);
    const preview = await operations.preview({ kind: "disconnect-agents", harnesses: ["codex"] });
    if (preview.status !== "ready") throw new Error(preview.diagnostic);
    const added = join(skillRoot, options.bundle[0]!.name, "later.md");
    await writeFile(added, "new user content\n");
    const before = await tree(skillRoot);
    expect((await operations.apply({ planId: preview.plan.planId }))?.status).toBe("failed");
    expect(await tree(skillRoot)).toEqual(before);
    expect((await inspectAgentHarnesses({ ...options, harnesses: ["codex"] }))[0]?.registered).toBe(true);
  });
});
