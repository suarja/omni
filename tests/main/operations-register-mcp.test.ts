import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOperationStore } from "../../src/main/operation-store";
import { createRegisterMcpOperations } from "../../src/main/operations-register-mcp";
import { createRestoreOperations } from "../../src/main/operations-restore";

const roots: string[] = [];

const claudeFixture = JSON.stringify(
  {
    theme: "dark",
    mcpServers: {
      posthog: { type: "http", url: "https://mcp.posthog.com" },
      pencil: { type: "stdio", command: "pencil", args: ["--stdio"] },
    },
    projects: {
      "/Users/example/project": {
        mcpServers: { pencil: { type: "stdio", command: "pencil", args: ["--stdio"] } },
      },
    },
  },
  null,
  2,
);

const codexFixture = `[mcp_servers.node_repl]\ncommand = "node"\nargs = [ "repl.js" ]\n\n[mcp_servers.node_repl.env]\nNODE_ENV = "development"\n\n[mcp_servers.pencil]\ncommand = "pencil"\nargs = [ "--stdio" ]\n\n[desktop]\ntheme = "dark"\n`;

async function setup(): Promise<Readonly<{ root: string; homeDir: string; userDataPath: string; cliPath: string }>> {
  const root = await mkdtemp(join(tmpdir(), "omni-register-mcp-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const userDataPath = join(root, "user-data");
  const cliPath = join(root, "app", "packages", "omni-mcp", "dist", "cli.js");
  await mkdir(homeDir, { recursive: true });
  await writeFile(join(root, "marker"), "marker");
  await mkdir(join(root, "app", "packages", "omni-mcp", "dist"), { recursive: true });
  await writeFile(cliPath, "#!/usr/bin/env node\n");
  return { root, homeDir, userDataPath, cliPath };
}

function createGitStub() {
  return {
    isGitAvailable: async () => false,
    isRepositoryRoot: async () => false,
  } as never;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("register-mcp operation", () => {
  it("adds only the user-level Claude entry and preserves every other parsed value", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    await writeFile(join(homeDir, ".claude.json"), claudeFixture);
    const operations = createRegisterMcpOperations({ homeDir, userDataPath, cliPath });

    const preview = await operations.preview({ kind: "register-mcp", harness: "claude-code", action: "enable" });

    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    expect(preview.plan.actions).toHaveLength(1);
    expect(preview.plan.actions[0]).toMatchObject({
      kind: "write-file",
      relativePath: ".claude.json",
      byteLength: expect.any(Number),
      beforeHash: expect.any(String),
    });
    const apply = await operations.apply({ planId: preview.plan.planId });
    expect(apply?.status).toBe("applied");
    const updated = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf8")) as Record<string, unknown>;
    const original = JSON.parse(claudeFixture) as Record<string, unknown>;
    expect(updated.theme).toEqual(original.theme);
    expect(updated.projects).toEqual(original.projects);
    expect((updated.mcpServers as Record<string, unknown>).posthog).toEqual(
      (original.mcpServers as Record<string, unknown>).posthog,
    );
    expect((updated.mcpServers as Record<string, unknown>).pencil).toEqual(
      (original.mcpServers as Record<string, unknown>).pencil,
    );
    expect((updated.mcpServers as Record<string, unknown>).omni).toEqual({
      type: "stdio",
      command: "node",
      args: [cliPath],
      env: { OMNI_USER_DATA: userDataPath },
    });
  });

  it("is idempotent and restores only the Omni entry while preserving provider edits", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    const settingsPath = join(homeDir, ".claude.json");
    await writeFile(settingsPath, claudeFixture);
    const store = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const operations = createRegisterMcpOperations({ homeDir, userDataPath, cliPath, operationStore: store });
    const enabled = await operations.preview({ kind: "register-mcp", harness: "claude-code", action: "enable" });
    expect(enabled.status).toBe("ready");
    if (enabled.status !== "ready") return;
    const enabledApply = await operations.apply({ planId: enabled.plan.planId });
    expect(enabledApply?.status).toBe("applied");
    const changed = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    changed.lastSeen = 1;
    await writeFile(settingsPath, JSON.stringify(changed, null, 2));
    const again = await operations.preview({ kind: "register-mcp", harness: "claude-code", action: "enable" });
    expect(again.status).toBe("ready");
    if (again.status !== "ready") return;
    expect(again.plan.actions).toEqual([]);
    const restore = createRestoreOperations({ userDataPath, operationStore: store, git: createGitStub(), homeDir });
    const restorePreview = await restore.preview({
      kind: "restore-import",
      operationId: enabledApply!.receipt.operationId,
    });
    expect(restorePreview.status).toBe("ready");
    if (restorePreview.status !== "ready") return;
    expect((await restore.apply({ planId: restorePreview.plan.planId }))?.status).toBe("applied");
    const restored = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect(restored.lastSeen).toBe(1);
    expect(restored.mcpServers).toEqual(JSON.parse(claudeFixture).mcpServers);
    const reenabled = await operations.preview({ kind: "register-mcp", harness: "claude-code", action: "enable" });
    expect(reenabled.status).toBe("ready");
    if (reenabled.status !== "ready") return;
    await operations.apply({ planId: reenabled.plan.planId });
    const disabled = await operations.preview({ kind: "register-mcp", harness: "claude-code", action: "disable" });
    expect(disabled.status).toBe("ready");
    if (disabled.status !== "ready") return;
    await operations.apply({ planId: disabled.plan.planId });
    const disabledSettings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect(disabledSettings.lastSeen).toBe(1);
    expect(disabledSettings.mcpServers).toEqual(JSON.parse(claudeFixture).mcpServers);
  });

  it("blocks a hand-modified Omni entry during restore", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    const settingsPath = join(homeDir, ".claude.json");
    await writeFile(settingsPath, claudeFixture);
    const store = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const operations = createRegisterMcpOperations({ homeDir, userDataPath, cliPath, operationStore: store });
    const enabled = await operations.preview({ kind: "register-mcp", harness: "claude-code", action: "enable" });
    expect(enabled.status).toBe("ready");
    if (enabled.status !== "ready") return;
    const applied = await operations.apply({ planId: enabled.plan.planId });
    expect(applied?.status).toBe("applied");
    const changed = JSON.parse(await readFile(settingsPath, "utf8")) as { mcpServers: { omni: { args: string[] } } };
    changed.mcpServers.omni.args = ["changed"];
    await writeFile(settingsPath, JSON.stringify(changed, null, 2));
    const restore = createRestoreOperations({ userDataPath, operationStore: store, git: createGitStub(), homeDir });
    await expect(
      restore.preview({ kind: "restore-import", operationId: applied!.receipt.operationId }),
    ).resolves.toEqual({
      status: "blocked",
      reason: "restore-drift",
      diagnostic:
        "The Omni entry in the Claude Code settings was modified after installation; remove it by hand or run the install again.",
    });
  });

  it("edits Codex text in place and leaves all non-Omni bytes identical", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    const settingsPath = join(homeDir, ".codex", "config.toml");
    await writeFile(settingsPath, codexFixture, { encoding: "utf8" });
    const operations = createRegisterMcpOperations({ homeDir, userDataPath, cliPath });
    const preview = await operations.preview({ kind: "register-mcp", harness: "codex", action: "enable" });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    await operations.apply({ planId: preview.plan.planId });
    // The block sits after the last MCP table, separated from the next table by one blank line.
    const block = `[mcp_servers.omni]\ncommand = "node"\nargs = [ "${cliPath}" ]\n\n[mcp_servers.omni.env]\nOMNI_USER_DATA = "${userDataPath}"\n\n`;
    const updated = await readFile(settingsPath, "utf8");
    const blockStart = updated.indexOf(block);
    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(updated.slice(0, blockStart) + updated.slice(blockStart + block.length)).toBe(codexFixture);
    expect(updated).toContain(`OMNI_USER_DATA = "${userDataPath}"\n\n[desktop]\ntheme = "dark"`);
  });

  it("blocks invalid JSON and a missing MCP build", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    await writeFile(join(homeDir, ".claude.json"), "{ invalid");
    const invalid = await createRegisterMcpOperations({ homeDir, userDataPath, cliPath }).preview({
      kind: "register-mcp",
      harness: "claude-code",
      action: "enable",
    });
    expect(invalid).toMatchObject({ status: "blocked" });
    if (invalid.status === "blocked") expect(invalid.diagnostic).toMatch(/valid JSON/i);
    const missing = await createRegisterMcpOperations({
      homeDir,
      userDataPath,
      cliPath: join(homeDir, "missing.js"),
    }).preview({
      kind: "register-mcp",
      harness: "codex",
      action: "enable",
    });
    expect(missing).toMatchObject({ status: "blocked" });
    if (missing.status === "blocked") expect(missing.diagnostic).toContain("Build the MCP server first");
  });

  it("creates a missing settings file for enable and does nothing for an unregistered disable", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    const operations = createRegisterMcpOperations({ homeDir, userDataPath, cliPath });
    const enable = await operations.preview({ kind: "register-mcp", harness: "claude-code", action: "enable" });
    expect(enable.status).toBe("ready");
    if (enable.status !== "ready") return;
    await operations.apply({ planId: enable.plan.planId });
    expect(JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf8"))).toEqual({
      mcpServers: { omni: { type: "stdio", command: "node", args: [cliPath], env: { OMNI_USER_DATA: userDataPath } } },
    });
    const disable = await operations.preview({ kind: "register-mcp", harness: "codex", action: "disable" });
    expect(disable.status).toBe("ready");
    if (disable.status === "ready") {
      expect(disable.plan.actions).toEqual([]);
      expect(disable.plan.notes).toContain("not registered");
    }
  });
});
