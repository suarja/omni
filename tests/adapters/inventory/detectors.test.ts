import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { detectClaudeCode } from "../../../src/adapters/inventory/claude-code";
import { detectCodex } from "../../../src/adapters/inventory/codex";
import { detectCursor } from "../../../src/adapters/inventory/cursor";
import { createLocalInventoryPort } from "../../../src/adapters/inventory/local-filesystem";
import { detectOpenCode } from "../../../src/adapters/inventory/opencode";
import type { InventoryDetectorResult } from "../../../src/adapters/inventory/shared";
import type { InventoryDirectoryEntry, InventoryFilesystemPort } from "../../../src/ports/inventory";
import { InventoryFilesystemError } from "../../../src/ports/inventory";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-inventory-detectors-"));
  temporaryRoots.push(root);
  return root;
}

async function writeRootFile(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function writeSkill(root: string, relativePath: string, name: string): Promise<void> {
  await writeRootFile(root, relativePath, `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\n`);
}

function artifactAt(result: InventoryDetectorResult, relativePath: string) {
  return result.artifacts.find((artifact) => artifact.relativePath === relativePath);
}

function diagnosticsAt(result: InventoryDetectorResult, location: string) {
  return result.diagnostics.filter((diagnostic) => diagnostic.location === location);
}

function expectUnknownProviderState(result: InventoryDetectorResult): void {
  expect(result.artifacts.length).toBeGreaterThan(0);
  for (const artifact of result.artifacts) {
    expect(artifact.providerState).toEqual({
      packageState: "unknown",
      activationState: "unknown",
      authenticationPolicy: "unknown",
      authenticationState: "unknown",
    });
  }
}

function createFailingPort(port: InventoryFilesystemPort, failingDirectory: string): InventoryFilesystemPort {
  return {
    ...port,
    async listDirectory(path: string): Promise<readonly InventoryDirectoryEntry[]> {
      if (path === failingDirectory) {
        throw new Error("synthetic inaccessible location");
      }
      return port.listDirectory(path);
    },
  };
}

function createReadTrackingPort(port: InventoryFilesystemPort): { port: InventoryFilesystemPort; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    port: {
      ...port,
      async readText(path: string): Promise<string> {
        reads.push(path);
        return port.readText(path);
      },
    },
  };
}

function createFailingRealpathPort(port: InventoryFilesystemPort, failingPath: string): InventoryFilesystemPort {
  return {
    ...port,
    async realpathEvidence(path: string) {
      if (path === failingPath) throw new Error("synthetic identity failure");
      return port.realpathEvidence(path);
    },
  };
}

async function createFifo(path: string): Promise<void> {
  await execFileAsync("mkfifo", [path]);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("inventory convention detectors", () => {
  it("detects a realistic mixed-provider project without returning bodies or absolute paths", async () => {
    const root = await createRoot();
    await writeSkill(root, ".agents/skills/codex-review/SKILL.md", "codex-review");
    await writeRootFile(root, "AGENTS.md", "Project instructions that must not be returned.");
    await writeRootFile(root, ".codex-plugin/plugin.json", '{"name":"local-codex-plugin"}');
    await writeSkill(root, ".claude/skills/claude-review/SKILL.md", "claude-review");
    await writeRootFile(root, "CLAUDE.md", "Claude instructions that must not be returned.");
    await writeRootFile(root, ".claude/agents/reviewer.md", "# Reviewer agent");
    await writeRootFile(root, ".claude/commands/check.md", "# Check command");
    await writeRootFile(root, ".claude/hooks/on-save.sh", "#!/bin/sh\n");
    await writeRootFile(root, ".claude-plugin/plugin.json", '{"name":"local-claude-plugin"}');
    await writeSkill(root, ".opencode/skills/opencode-review/SKILL.md", "opencode-review");
    await writeRootFile(root, ".opencode/plugins/audit.ts", "export default {};\n");
    await writeRootFile(root, "opencode.json", '{"mcp": {"local": {}}}');
    await writeSkill(root, ".cursor/skills/cursor-review/SKILL.md", "cursor-review");
    await writeRootFile(root, ".cursor/rules/review.mdc", "---\ndescription: Review\n---\n");
    await writeRootFile(root, ".cursor/mcp.json", '{"mcpServers": {}}');
    await writeRootFile(root, ".cursor-plugin/plugin.json", '{"name":"local-cursor-plugin"}');

    const results = await Promise.all([
      detectCodex(createLocalInventoryPort(root)),
      detectClaudeCode(createLocalInventoryPort(root)),
      detectOpenCode(createLocalInventoryPort(root)),
      detectCursor(createLocalInventoryPort(root)),
    ]);
    const serialized = JSON.stringify(results);

    expect(results.map((result) => result.providerId)).toEqual(["codex", "claude-code", "opencode", "cursor"]);
    expect(results[0].artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["skill", "instruction", "plugin-manifest"]),
    );
    expect(results[1].artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["skill", "instruction", "agent", "command", "hook", "plugin-manifest"]),
    );
    expect(results[2].artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["skill", "plugin-manifest", "mcp-config"]),
    );
    expect(results[3].artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["skill", "rule", "mcp-config", "plugin-manifest"]),
    );
    expectUnknownProviderState(results[0]);
    expect(serialized).not.toContain("Project instructions that must not be returned.");
    expect(serialized).not.toContain("Claude instructions that must not be returned.");
    expect(serialized).not.toContain(root);
  });

  it.each([
    ["Codex", detectCodex, ".agents/skills/loose/SKILL.md"],
    ["Claude Code", detectClaudeCode, ".claude/skills/loose/SKILL.md"],
    ["OpenCode", detectOpenCode, ".opencode/skills/loose/SKILL.md"],
    ["Cursor", detectCursor, ".cursor/skills/loose/SKILL.md"],
  ])("detects a %s skill without a plugin manifest", async (_name, detect, skillPath) => {
    const root = await createRoot();
    await writeSkill(root, skillPath, "loose");

    const result = await detect(createLocalInventoryPort(root));

    expect(artifactAt(result, skillPath)).toMatchObject({
      kind: "skill",
      providerIds: [result.providerId],
      scope: "project",
      confidence: "exact",
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("detects all documented Claude Code marker categories", async () => {
    const root = await createRoot();
    await writeSkill(root, ".claude/skills/review/SKILL.md", "review");
    await writeRootFile(root, ".claude/agents/reviewer.md", "agent");
    await writeRootFile(root, ".claude/commands/check.md", "command");
    await writeRootFile(root, ".claude/hooks/on-save.sh", "hook");
    await writeRootFile(root, ".claude-plugin/marketplace.json", '{"name":"local"}');
    await writeRootFile(root, "CLAUDE.md", "instructions");

    const result = await detectClaudeCode(createLocalInventoryPort(root));

    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: ".claude/skills/review/SKILL.md", kind: "skill" }),
        expect.objectContaining({ relativePath: ".claude/agents/reviewer.md", kind: "agent" }),
        expect.objectContaining({ relativePath: ".claude/commands/check.md", kind: "command" }),
        expect.objectContaining({ relativePath: ".claude/hooks/on-save.sh", kind: "hook" }),
        expect.objectContaining({ relativePath: ".claude-plugin/marketplace.json", kind: "marketplace-manifest" }),
        expect.objectContaining({ relativePath: "CLAUDE.md", kind: "instruction" }),
      ]),
    );
  });

  it("detects malformed JSON and skill frontmatter while preserving other evidence", async () => {
    const root = await createRoot();
    await writeRootFile(root, ".codex-plugin/plugin.json", '{"name":');
    await writeRootFile(root, ".agents/skills/broken/SKILL.md", "---\nname: broken\n");
    await writeRootFile(root, "AGENTS.md", "valid evidence");

    const result = await detectCodex(createLocalInventoryPort(root));

    expect(artifactAt(result, "AGENTS.md")).toBeDefined();
    expect(diagnosticsAt(result, ".codex-plugin/plugin.json")).toEqual([
      expect.objectContaining({ code: "malformed", severity: "warning" }),
    ]);
    expect(diagnosticsAt(result, ".agents/skills/broken/SKILL.md")).toEqual([
      expect.objectContaining({ code: "malformed", severity: "warning" }),
    ]);
  });

  it("omits absent optional locations without fabricating provider state", async () => {
    const root = await createRoot();

    await expect(detectCursor(createLocalInventoryPort(root))).resolves.toEqual({
      providerId: "cursor",
      artifacts: [],
      diagnostics: [],
    });
  });

  it("preserves an inside-root symlink projection and canonical physical identity", async () => {
    const root = await createRoot();
    await writeSkill(root, ".shared/skills/review/SKILL.md", "review");
    await mkdir(join(root, ".cursor/skills/review"), { recursive: true });
    await symlink(join(root, ".shared/skills/review/SKILL.md"), join(root, ".cursor/skills/review/SKILL.md"));

    const result = await detectCursor(createLocalInventoryPort(root));
    const artifact = artifactAt(result, ".cursor/skills/review/SKILL.md");

    expect(artifact).toMatchObject({
      kind: "skill",
      physicalIdentity: ".shared/skills/review/SKILL.md",
      projectionPaths: [".cursor/skills/review/SKILL.md"],
      symlinkState: "inside-root",
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("deduplicates two projections of one physical skill and sorts repeated results deterministically", async () => {
    const root = await createRoot();
    await writeSkill(root, ".shared/skills/review/SKILL.md", "review");
    await mkdir(join(root, ".cursor/skills/review"), { recursive: true });
    await mkdir(join(root, ".cursor/skills/other"), { recursive: true });
    await symlink(join(root, ".shared/skills/review/SKILL.md"), join(root, ".cursor/skills/review/SKILL.md"));
    await symlink(join(root, ".shared/skills/review/SKILL.md"), join(root, ".cursor/skills/other/SKILL.md"));

    const first = await detectCursor(createLocalInventoryPort(root));
    const second = await detectCursor(createLocalInventoryPort(root));

    expect(first).toEqual(second);
    expect(first.artifacts).toHaveLength(1);
    expect(first.artifacts[0].projectionPaths).toEqual([
      ".cursor/skills/other/SKILL.md",
      ".cursor/skills/review/SKILL.md",
    ]);
    expect(first.artifacts[0].relativePath).toBe(".cursor/skills/other/SKILL.md");
    expect(first.diagnostics).toEqual([expect.objectContaining({ code: "duplicate-projection" })]);
  });

  it("returns usable evidence when one known location fails", async () => {
    const root = await createRoot();
    await writeRootFile(root, ".agents/skills/review/SKILL.md", "---\nname: review\n---\n");
    await writeRootFile(root, "AGENTS.md", "valid evidence");
    const port = createFailingPort(createLocalInventoryPort(root), ".agents/skills");

    const result = await detectCodex(port);

    expect(artifactAt(result, "AGENTS.md")).toBeDefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        location: ".agents/skills",
        code: "inaccessible",
      }),
    ]);
  });

  it.each([
    ["Codex", detectCodex, ".agents/skills", ".codex-plugin"],
    ["Claude Code", detectClaudeCode, ".claude/skills", ".claude-plugin"],
    ["OpenCode", detectOpenCode, ".opencode/skills", ".opencode/plugins"],
    ["Cursor", detectCursor, ".cursor/skills", ".cursor-plugin"],
  ])(
    "does not descend into excluded paths or read excluded %s marker bodies",
    async (_name, detect, skillRoot, jsonRoot) => {
      const root = await createRoot();
      const excludedPaths = [
        "node_modules",
        "build",
        "dist",
        ".next",
        "out",
        "coverage",
        "sessions",
        "logs",
        "cache",
        "caches",
        ".env",
        ".env.local",
      ];
      for (const excludedPath of excludedPaths) {
        await writeSkill(root, `${skillRoot}/${excludedPath}/SKILL.md`, excludedPath);
        await writeRootFile(root, `${jsonRoot}/${excludedPath}/plugin.json`, '{"name":"canary"}');
      }
      const tracked = createReadTrackingPort(createLocalInventoryPort(root));

      const result = await detect(tracked.port);

      expect(result.artifacts).toEqual([]);
      expect(tracked.reads).toEqual([]);
    },
  );

  it.each([
    ["Codex", detectCodex, ".agents/skills"],
    ["Claude Code", detectClaudeCode, ".claude/skills"],
    ["OpenCode", detectOpenCode, ".opencode/skills"],
    ["Cursor", detectCursor, ".cursor/skills"],
  ])("rejects a regular file where the %s skill tree is required", async (_name, detect, path) => {
    const root = await createRoot();
    await writeRootFile(root, path, "not a directory");

    const result = await detect(createLocalInventoryPort(root));

    expect(result.artifacts).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ location: path, code: "unsupported" })]);
  });

  it("rejects a symlink-to-file where a documented tree is required", async () => {
    const root = await createRoot();
    await writeRootFile(root, ".agents/skills-target", "not a directory");
    await mkdir(join(root, ".agents"), { recursive: true });
    await symlink(join(root, ".agents/skills-target"), join(root, ".agents/skills"));

    const result = await detectCodex(createLocalInventoryPort(root));

    expect(result.artifacts).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ location: ".agents/skills", code: "unsupported" })]);
  });

  it("rejects an unsupported filesystem object where a documented tree is required", async () => {
    const root = await createRoot();
    await mkdir(join(root, ".agents"), { recursive: true });
    await createFifo(join(root, ".agents/skills"));

    const result = await detectCodex(createLocalInventoryPort(root));

    expect(result.artifacts).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ location: ".agents/skills", code: "unsupported" })]);
  });

  it("rejects a skill without the bounded frontmatter boundary", async () => {
    const root = await createRoot();
    const path = ".agents/skills/missing-frontmatter/SKILL.md";
    const body = "# Missing frontmatter\nsecret body\n";
    await writeRootFile(root, path, body);

    const result = await detectCodex(createLocalInventoryPort(root));
    const artifact = artifactAt(result, path);

    expect(artifact).toMatchObject({ kind: "skill", relativePath: path, physicalIdentity: path });
    expect(["heuristic", "unknown"]).toContain(artifact?.confidence);
    expect(JSON.stringify(result)).not.toContain(body);
    expect(result.diagnostics).toEqual([expect.objectContaining({ location: path, code: "malformed" })]);
  });

  it("rejects a skill with an unterminated frontmatter boundary", async () => {
    const root = await createRoot();
    const path = ".agents/skills/malformed-frontmatter/SKILL.md";
    const body = "---\nname: malformed\nsecret body\n";
    await writeRootFile(root, path, body);

    const result = await detectCodex(createLocalInventoryPort(root));
    const artifact = artifactAt(result, path);

    expect(artifact).toMatchObject({ kind: "skill", relativePath: path, physicalIdentity: path });
    expect(["heuristic", "unknown"]).toContain(artifact?.confidence);
    expect(JSON.stringify(result)).not.toContain(body);
    expect(result.diagnostics).toEqual([expect.objectContaining({ location: path, code: "malformed" })]);
  });

  it("does not emit exact evidence when physical identity observation fails", async () => {
    const root = await createRoot();
    const path = "AGENTS.md";
    await writeRootFile(root, path, "valid instruction");
    const port = createFailingRealpathPort(createLocalInventoryPort(root), path);

    const result = await detectCodex(port);

    expect(result.artifacts).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ location: path, code: "inaccessible" })]);
  });

  it.each([
    ["external", "outside-root"],
    ["broken", "broken-link"],
  ])("classifies a %s skill symlink and propagates its diagnostic", async (kind, code) => {
    const root = await createRoot();
    const path = ".agents/skills/link/SKILL.md";
    await mkdir(join(root, ".agents/skills/link"), { recursive: true });
    const target = kind === "external" ? await createRoot() : join(root, "missing");
    if (kind === "external") await writeSkill(target, "SKILL.md", "external");
    await symlink(join(target, "SKILL.md"), join(root, path));

    const result = await detectCodex(createLocalInventoryPort(root));

    expect(artifactAt(result, path)).toMatchObject({ kind: "skill", symlinkState: kind });
    expect(result.diagnostics).toEqual([expect.objectContaining({ location: path, code })]);
  });

  it("propagates a bounded filesystem diagnostic while preserving other evidence", async () => {
    const root = await createRoot();
    await writeRootFile(root, "AGENTS.md", "valid evidence");
    await mkdir(join(root, ".agents/skills"), { recursive: true });
    const base = createLocalInventoryPort(root);
    const port: InventoryFilesystemPort = {
      ...base,
      async listDirectory(path: string) {
        if (path === ".agents/skills") {
          throw new InventoryFilesystemError("listDirectory", path, "oversized", "synthetic");
        }
        return base.listDirectory(path);
      },
    };

    const result = await detectCodex(port);

    expect(artifactAt(result, "AGENTS.md")).toBeDefined();
    expect(result.diagnostics).toEqual([expect.objectContaining({ location: ".agents/skills", code: "oversized" })]);
  });
});
