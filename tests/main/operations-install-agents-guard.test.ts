import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOperationStore } from "../../src/main/operation-store";
import { createInstallAgentsOperations } from "../../src/main/operations-install-agents";
import { createRestoreOperations } from "../../src/main/operations-restore";
import { bundleRoot, readBundle } from "../../src/main/omni-skills-bundle";

const roots: string[] = [];
const claudeHooksFixture = JSON.stringify(
  {
    theme: "dark",
    hooks: { PreToolUse: [{ matcher: "SomeOtherTool", hooks: [{ type: "command", command: "echo other" }] }] },
  },
  null,
  2,
);
const codexHooksFixture = `${JSON.stringify(
  { hooks: { PreToolUse: [{ matcher: "SomeOtherTool", hooks: [{ type: "command", command: "echo other" }] }] } },
  null,
  2,
)}\n`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<Readonly<{ homeDir: string; userDataPath: string; cliPath: string }>> {
  const root = await mkdtemp(join(tmpdir(), "omni-install-agents-guard-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const userDataPath = join(root, "user-data");
  const cliPath = join(root, "cli.js");
  await mkdir(join(homeDir, ".claude"), { recursive: true });
  await mkdir(join(homeDir, ".codex"), { recursive: true });
  await writeFile(join(homeDir, ".claude", "settings.json"), claudeHooksFixture);
  await writeFile(join(homeDir, ".codex", "hooks.json"), codexHooksFixture);
  await writeFile(cliPath, "cli\n");
  return { homeDir, userDataPath, cliPath };
}

function gitStub() {
  return { isGitAvailable: async () => false, isRepositoryRoot: async () => false } as never;
}

describe("install-agents guard hook (Brief B1)", () => {
  it("adds only Omni's guard entry, preserving pre-existing hooks, then restores byte-identical files", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const store = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const operations = createInstallAgentsOperations({ homeDir, userDataPath, cliPath, bundle, operationStore: store });
    const preview = await operations.preview({ kind: "install-agents", harnesses: ["claude-code", "codex"] });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    expect(preview.plan.harnesses).toEqual([
      expect.objectContaining({ harness: "claude-code", guard: "add" }),
      expect.objectContaining({ harness: "codex", guard: "add" }),
    ]);
    const guardActions = preview.plan.actions.filter(
      (action) => action.relativePath === ".claude/settings.json" || action.relativePath === ".codex/hooks.json",
    );
    expect(guardActions).toHaveLength(2);
    expect(guardActions.every((action) => Boolean(action.diff))).toBe(true);

    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied?.status).toBe("applied");

    const claudeSettings = JSON.parse(await readFile(join(homeDir, ".claude", "settings.json"), "utf8")) as {
      hooks: { PreToolUse: readonly { matcher: string; hooks: readonly { command: string }[] }[] };
    };
    expect(claudeSettings.hooks.PreToolUse).toHaveLength(2);
    expect(claudeSettings.hooks.PreToolUse.some((entry) => entry.matcher === "SomeOtherTool")).toBe(true);
    const omniClaudeEntry = claudeSettings.hooks.PreToolUse.find((entry) => entry.matcher !== "SomeOtherTool");
    expect(omniClaudeEntry?.hooks[0]?.command).toContain("omni-guard.mjs");
    expect(omniClaudeEntry?.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash");

    const codexHooks = JSON.parse(await readFile(join(homeDir, ".codex", "hooks.json"), "utf8")) as {
      hooks: { PreToolUse: readonly { matcher: string; hooks: readonly { command: string }[] }[] };
    };
    expect(codexHooks.hooks.PreToolUse).toHaveLength(2);
    const omniCodexEntry = codexHooks.hooks.PreToolUse.find((entry) => entry.matcher !== "SomeOtherTool");
    expect(omniCodexEntry?.matcher).toBe("apply_patch|Edit|Write|Bash");
    expect(omniCodexEntry?.hooks[0]?.command).toContain("omni-guard.mjs");

    const restore = createRestoreOperations({ userDataPath, operationStore: store, git: gitStub(), homeDir });
    const restorePreview = await restore.preview({ kind: "restore-import", operationId: applied!.receipt.operationId });
    expect(restorePreview.status).toBe("ready");
    if (restorePreview.status !== "ready") return;
    const restored = await restore.apply({ planId: restorePreview.plan.planId });
    expect(restored?.status).toBe("applied");
    expect(JSON.parse(await readFile(join(homeDir, ".claude", "settings.json"), "utf8"))).toEqual(
      JSON.parse(claudeHooksFixture),
    );
    expect(JSON.parse(await readFile(join(homeDir, ".codex", "hooks.json"), "utf8"))).toEqual(
      JSON.parse(codexHooksFixture),
    );
  });

  it("round-trips byte-identically through a no-trailing-newline settings.json with other keys and hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-install-agents-guard-format-"));
    roots.push(root);
    const homeDir = join(root, "home");
    const userDataPath = join(root, "user-data");
    const cliPath = join(root, "cli.js");
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeFile(cliPath, "cli\n");
    // The owner's real ~/.claude/settings.json: 2-space JSON, no trailing newline, other keys,
    // another user PreToolUse hook.
    const original = JSON.stringify(
      {
        permissions: { allow: ["Bash(pnpm test:*)"] },
        hooks: {
          PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo user-hook" }] }],
          PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo post" }] }],
        },
      },
      null,
      2,
    );
    expect(original.endsWith("\n")).toBe(false);
    const settingsPath = join(homeDir, ".claude", "settings.json");
    await writeFile(settingsPath, original);

    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const store = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const operations = createInstallAgentsOperations({ homeDir, userDataPath, cliPath, bundle, operationStore: store });
    const preview = await operations.preview({ kind: "install-agents", harnesses: ["claude-code"] });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied?.status).toBe("applied");
    const afterInstall = await readFile(settingsPath, "utf8");
    expect(afterInstall).not.toBe(original);
    expect(afterInstall.endsWith("\n")).toBe(false);
    expect(afterInstall).toContain('    "PreToolUse"');
    expect(afterInstall).toContain("post");

    const restore = createRestoreOperations({ userDataPath, operationStore: store, git: gitStub(), homeDir });
    const restorePreview = await restore.preview({ kind: "restore-import", operationId: applied!.receipt.operationId });
    expect(restorePreview.status).toBe("ready");
    if (restorePreview.status !== "ready") return;
    const restored = await restore.apply({ planId: restorePreview.plan.planId });
    expect(restored?.status).toBe("applied");
    expect(await readFile(settingsPath, "utf8")).toBe(original);
  });

  it("deletes a guard file Omni created from scratch on restore, for both harnesses", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-install-agents-guard-fresh-"));
    roots.push(root);
    const homeDir = join(root, "home");
    const userDataPath = join(root, "user-data");
    const cliPath = join(root, "cli.js");
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeFile(cliPath, "cli\n");
    // No pre-existing .claude/settings.json or .codex/hooks.json: Omni creates both from
    // scratch, so restore must delete them entirely rather than leave an empty shell.
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const store = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const operations = createInstallAgentsOperations({ homeDir, userDataPath, cliPath, bundle, operationStore: store });
    const preview = await operations.preview({ kind: "install-agents", harnesses: ["claude-code", "codex"] });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied?.status).toBe("applied");
    await expect(readFile(join(homeDir, ".claude", "settings.json"))).resolves.toBeDefined();
    await expect(readFile(join(homeDir, ".codex", "hooks.json"))).resolves.toBeDefined();

    const restore = createRestoreOperations({ userDataPath, operationStore: store, git: gitStub(), homeDir });
    const restorePreview = await restore.preview({ kind: "restore-import", operationId: applied!.receipt.operationId });
    expect(restorePreview.status).toBe("ready");
    if (restorePreview.status !== "ready") return;
    const restored = await restore.apply({ planId: restorePreview.plan.planId });
    expect(restored?.status).toBe("applied");
    await expect(readFile(join(homeDir, ".claude", "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(homeDir, ".codex", "hooks.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks restore with a plain reason when Omni's guard entry was hand-modified", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const store = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const operations = createInstallAgentsOperations({ homeDir, userDataPath, cliPath, bundle, operationStore: store });
    const preview = await operations.preview({ kind: "install-agents", harnesses: ["claude-code"] });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied?.status).toBe("applied");

    const settingsPath = join(homeDir, ".claude", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string; timeout: number }[] }[] };
    };
    const omniEntry = settings.hooks.PreToolUse.find((entry) => entry.hooks[0]?.command.includes("omni-guard.mjs"))!;
    omniEntry.hooks[0]!.timeout = 99;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));

    const restore = createRestoreOperations({ userDataPath, operationStore: store, git: gitStub(), homeDir });
    await expect(
      restore.preview({ kind: "restore-import", operationId: applied!.receipt.operationId }),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "restore-drift",
      diagnostic: expect.stringContaining("modified after installation"),
    });
  });

  it("restores the previous MCP entry, not a blanket removal, when install updated an existing one", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    const oldOmniEntry = { type: "stdio", command: "node", args: ["/old/path/omni-mcp.mjs"] };
    await writeFile(
      join(homeDir, ".claude.json"),
      JSON.stringify({ theme: "dark", mcpServers: { omni: oldOmniEntry, pencil: { command: "pencil" } } }, null, 2),
    );
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const store = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const operations = createInstallAgentsOperations({ homeDir, userDataPath, cliPath, bundle, operationStore: store });
    const preview = await operations.preview({ kind: "install-agents", harnesses: ["claude-code"] });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    expect(preview.plan.harnesses).toEqual([expect.objectContaining({ harness: "claude-code", mcp: "add" })]);

    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied?.status).toBe("applied");
    const afterInstall = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf8")) as {
      mcpServers: { omni: { args: string[] } };
    };
    expect(afterInstall.mcpServers.omni.args).toEqual([cliPath]);

    const restore = createRestoreOperations({ userDataPath, operationStore: store, git: gitStub(), homeDir });
    const restorePreview = await restore.preview({ kind: "restore-import", operationId: applied!.receipt.operationId });
    expect(restorePreview.status).toBe("ready");
    if (restorePreview.status !== "ready") return;
    const restored = await restore.apply({ planId: restorePreview.plan.planId });
    expect(restored?.status).toBe("applied");
    const afterRestore = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(afterRestore.mcpServers.omni).toEqual(oldOmniEntry);
    expect(afterRestore.mcpServers.pencil).toEqual({ command: "pencil" });
  });
});
