import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOperationStore } from "../../src/main/operation-store";
import { createInstallAgentsOperations } from "../../src/main/operations-install-agents";
import { createRestoreOperations } from "../../src/main/operations-restore";
import { bundleRoot, readBundle } from "../../src/main/omni-skills-bundle";
import { parsePreviewMarketplaceResponse } from "../../src/shared/operations-ipc";

const roots: string[] = [];
const claudeFixture = JSON.stringify({ theme: "dark", mcpServers: { pencil: { command: "pencil" } } }, null, 2);
const codexFixture = `[mcp_servers.pencil]\ncommand = "pencil"\nargs = [ "--stdio" ]\n\n[desktop]\ntheme = "dark"\n`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<Readonly<{ homeDir: string; userDataPath: string; cliPath: string }>> {
  const root = await mkdtemp(join(tmpdir(), "omni-install-agents-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const userDataPath = join(root, "user-data");
  const cliPath = join(root, "cli.js");
  await mkdir(join(homeDir, ".claude"), { recursive: true });
  await mkdir(join(homeDir, ".codex"), { recursive: true });
  await writeFile(join(homeDir, ".claude.json"), claudeFixture);
  await writeFile(join(homeDir, ".codex", "config.toml"), codexFixture);
  await writeFile(cliPath, "cli\n");
  return { homeDir, userDataPath, cliPath };
}

function gitStub() {
  return { isGitAvailable: async () => false, isRepositoryRoot: async () => false } as never;
}

describe("install-agents operation", () => {
  it("rewrites every Omni file on force reinstall even when the agent is complete", async () => {
    const options = await setup();
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const operations = createInstallAgentsOperations({ ...options, bundle });
    const first = await operations.preview({ kind: "install-agents", harnesses: ["codex"] });
    if (first.status !== "ready") throw new Error(first.diagnostic);
    expect((await operations.apply({ planId: first.plan.planId }))?.status).toBe("applied");
    const forced = await operations.preview({ kind: "install-agents", harnesses: ["codex"], force: true });
    if (forced.status !== "ready") throw new Error(forced.diagnostic);
    expect(forced.plan.actions.filter((action) => action.kind === "write-file")).toHaveLength(
      2 + bundle.reduce((count, skill) => count + skill.files.length, 0),
    );
    expect((await operations.apply({ planId: forced.plan.planId }))?.status).toBe("applied");
  });
  it("restores the Omni entry and skills while preserving provider edits", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const store = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const operations = createInstallAgentsOperations({ homeDir, userDataPath, cliPath, bundle, operationStore: store });
    const preview = await operations.preview({ kind: "install-agents", harnesses: ["claude-code", "codex"] });

    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    expect(preview.plan.kind).toBe("install-agents");
    expect(preview.plan.harnesses).toEqual([
      expect.objectContaining({
        harness: "claude-code",
        mcp: "add",
        skills: expect.objectContaining({ add: expect.any(Array) }),
      }),
      expect.objectContaining({ harness: "codex", mcp: "add" }),
    ]);
    expect(preview.plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: ".claude.json" }),
        expect.objectContaining({ relativePath: ".codex/config.toml" }),
      ]),
    );
    expect(preview.plan.actions.some((action) => action.relativePath.endsWith("/SKILL.md"))).toBe(true);

    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied?.status).toBe("applied");
    expect(applied?.receipt).toMatchObject({
      kind: "install-agents",
      registered: null,
      createdDirectories: expect.any(Array),
    });
    expect(JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf8")).mcpServers.omni.env).toEqual({
      OMNI_USER_DATA: userDataPath,
    });
    expect(
      (await readFile(join(homeDir, ".codex", "config.toml"), "utf8")).match(/\[mcp_servers\.omni\.env\]/gu),
    ).toHaveLength(1);
    const changedClaude = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf8")) as Record<string, unknown>;
    changedClaude.lastSeen = 1;
    await writeFile(join(homeDir, ".claude.json"), JSON.stringify(changedClaude, null, 2));
    await writeFile(
      join(homeDir, ".codex", "config.toml"),
      `${await readFile(join(homeDir, ".codex", "config.toml"), "utf8")}# Provider comment\n`,
    );
    const nothing = await operations.preview({ kind: "install-agents", harnesses: ["claude-code"] });
    expect(nothing).toMatchObject({
      status: "ready",
      plan: { actions: [], harnesses: [{ status: "nothing-to-do", mcp: "keep" }] },
    });

    const restore = createRestoreOperations({ userDataPath, operationStore: store, git: gitStub(), homeDir });
    const restorePreview = await restore.preview({ kind: "restore-import", operationId: applied!.receipt.operationId });
    expect(restorePreview.status).toBe("ready");
    if (restorePreview.status !== "ready") return;
    const restored = await restore.apply({ planId: restorePreview.plan.planId });
    expect(restored?.status).toBe("applied");
    const restoredClaude = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf8")) as Record<string, unknown>;
    expect(restoredClaude.lastSeen).toBe(1);
    expect(restoredClaude.mcpServers).toEqual({ pencil: { command: "pencil" } });
    expect(await readFile(join(homeDir, ".codex", "config.toml"), "utf8")).toContain("# Provider comment");
    expect(await readFile(join(homeDir, ".codex", "config.toml"), "utf8")).not.toContain("mcp_servers.omni");
    await expect(readdir(join(homeDir, ".claude"))).resolves.toEqual([]);
    await expect(readdir(join(homeDir, ".codex"))).resolves.toEqual(["config.toml"]);
  });

  it("blocks a hand-modified Omni settings entry with a plain restore reason", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const store = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const operations = createInstallAgentsOperations({ homeDir, userDataPath, cliPath, bundle, operationStore: store });
    const preview = await operations.preview({ kind: "install-agents", harnesses: ["claude-code"] });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied?.status).toBe("applied");
    const settingsPath = join(homeDir, ".claude.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { mcpServers: { omni: { args: string[] } } };
    settings.mcpServers.omni.args = ["changed"];
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));

    const restore = createRestoreOperations({ userDataPath, operationStore: store, git: gitStub(), homeDir });
    await expect(
      restore.preview({ kind: "restore-import", operationId: applied!.receipt.operationId }),
    ).resolves.toEqual({
      status: "blocked",
      reason: "restore-drift",
      diagnostic:
        "The Omni entry in the Claude Code settings was modified after installation; remove it by hand or run the install again.",
    });
  });

  it("deletes a created settings file only when it is untouched and keeps later additions", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    await rm(join(homeDir, ".claude.json"));
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const store = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const operations = createInstallAgentsOperations({ homeDir, userDataPath, cliPath, bundle, operationStore: store });
    const preview = await operations.preview({ kind: "install-agents", harnesses: ["claude-code"] });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied?.status).toBe("applied");
    const restore = createRestoreOperations({ userDataPath, operationStore: store, git: gitStub(), homeDir });
    const untouchedPreview = await restore.preview({
      kind: "restore-import",
      operationId: applied!.receipt.operationId,
    });
    expect(untouchedPreview.status).toBe("ready");
    if (untouchedPreview.status !== "ready") return;
    expect((await restore.apply({ planId: untouchedPreview.plan.planId }))?.status).toBe("applied");
    await expect(readFile(join(homeDir, ".claude.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const secondPreview = await operations.preview({ kind: "install-agents", harnesses: ["claude-code"] });
    expect(secondPreview.status).toBe("ready");
    if (secondPreview.status !== "ready") return;
    const secondApplied = await operations.apply({ planId: secondPreview.plan.planId });
    expect(secondApplied?.status).toBe("applied");
    const secondSettingsPath = join(homeDir, ".claude.json");
    const extended = JSON.parse(await readFile(secondSettingsPath, "utf8")) as Record<string, unknown>;
    extended.lastSeen = 1;
    await writeFile(secondSettingsPath, JSON.stringify(extended, null, 2));
    const extendedPreview = await restore.preview({
      kind: "restore-import",
      operationId: secondApplied!.receipt.operationId,
    });
    expect(extendedPreview.status).toBe("ready");
    if (extendedPreview.status !== "ready") return;
    expect((await restore.apply({ planId: extendedPreview.plan.planId }))?.status).toBe("applied");
    const kept = JSON.parse(await readFile(secondSettingsPath, "utf8")) as Record<string, unknown>;
    expect(kept.lastSeen).toBe(1);
    expect(kept.mcpServers).toEqual({});
  });

  it("updates an outdated skill file by file, removes extra files, and restores them", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const lessons = bundle.find((skill) => skill.name === "omni-lessons")!;
    const folder = join(homeDir, ".claude", "skills", "omni-lessons");
    await mkdir(folder, { recursive: true });
    for (const file of lessons.files) await writeFile(join(folder, file.relativePath), `${file.content}\nstale\n`);
    await writeFile(join(folder, "notes.md"), "extra\n");
    const store = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const operations = createInstallAgentsOperations({ homeDir, userDataPath, cliPath, bundle, operationStore: store });

    const preview = await operations.preview({ kind: "install-agents", harnesses: ["claude-code"] });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    expect(preview.plan.harnesses?.[0]?.skills.update).toEqual(["omni-lessons"]);
    const lessonActions = preview.plan.actions.filter((action) => action.relativePath.includes("/omni-lessons/"));
    expect(lessonActions.filter((action) => action.kind === "write-file").every((action) => action.diff)).toBe(true);
    expect(lessonActions).toContainEqual(
      expect.objectContaining({ kind: "delete-file", relativePath: ".claude/skills/omni-lessons/notes.md" }),
    );

    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied?.status).toBe("applied");
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(
      lessons.files.find((file) => file.relativePath === "SKILL.md")!.content,
    );
    await expect(readdir(folder)).resolves.not.toContain("notes.md");

    const restore = createRestoreOperations({ userDataPath, operationStore: store, git: gitStub(), homeDir });
    const restorePreview = await restore.preview({ kind: "restore-import", operationId: applied!.receipt.operationId });
    expect(restorePreview.status).toBe("ready");
    if (restorePreview.status !== "ready") return;
    expect((await restore.apply({ planId: restorePreview.plan.planId }))?.status).toBe("applied");
    expect(await readFile(join(folder, "notes.md"), "utf8")).toBe("extra\n");
    expect((await readFile(join(folder, "SKILL.md"), "utf8")).endsWith("\nstale\n")).toBe(true);
  });

  it("returns IPC-safe diagnostics for every blocked preview", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    await mkdir(join(homeDir, ".claude", "skills", "omni-lessons"), { recursive: true });
    await writeFile(join(homeDir, ".claude", "skills", "omni-lessons", "SKILL.md"), "---\nname: other\n---\n");
    await rm(join(homeDir, ".codex"), { recursive: true, force: true });
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const operations = createInstallAgentsOperations({ homeDir, userDataPath, cliPath, bundle });
    for (const harnesses of [["claude-code"], ["codex"]] as const) {
      const preview = await operations.preview({ kind: "install-agents", harnesses });
      expect(preview.status).toBe("blocked");
      expect(() => parsePreviewMarketplaceResponse(preview)).not.toThrow();
    }
  });

  it("blocks a foreign skill folder without overwriting it", async () => {
    const { homeDir, userDataPath, cliPath } = await setup();
    await mkdir(join(homeDir, ".claude", "skills", "omni-lessons"), { recursive: true });
    await writeFile(join(homeDir, ".claude", "skills", "omni-lessons", "SKILL.md"), "---\nname: another-skill\n---\n");
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const operations = createInstallAgentsOperations({ homeDir, userDataPath, cliPath, bundle });

    await expect(operations.preview({ kind: "install-agents", harnesses: ["claude-code"] })).resolves.toMatchObject({
      status: "blocked",
      reason: "skill-foreign",
      diagnostic: expect.stringContaining("The omni-lessons folder in the Claude Code skills belongs to another skill"),
    });
  });
});
