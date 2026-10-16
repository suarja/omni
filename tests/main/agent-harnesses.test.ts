import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { agentHomeDir, mcpCliPath, observeAgentHarnesses } from "../../src/main/agent-harnesses";
import { readBundle } from "../../src/main/omni-skills-bundle";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<Readonly<{ root: string; homeDir: string; bundleRoot: string }>> {
  const root = await mkdtemp(join(tmpdir(), "omni-agent-harnesses-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const bundleRoot = join(root, "bundle");
  await mkdir(join(homeDir, ".claude"), { recursive: true });
  await mkdir(join(homeDir, ".codex"), { recursive: true });
  await mkdir(join(bundleRoot, "omni-lessons"), { recursive: true });
  await writeFile(
    join(bundleRoot, "omni-lessons", "SKILL.md"),
    "---\nname: omni-lessons\ndescription: Test skill\n---\n\n# Lessons\n",
  );
  return { root, homeDir, bundleRoot };
}

describe("agent harness observation", () => {
  it("uses the development agent home for observation and ignores it in packaged builds", async () => {
    const { homeDir, bundleRoot, root } = await setup();
    vi.stubEnv("OMNI_AGENT_HOME", homeDir);
    expect(agentHomeDir({ isPackaged: false })).toBe(homeDir);
    expect(agentHomeDir({ isPackaged: true })).toBe(homedir());
    expect(agentHomeDir({ homeDir: root, isPackaged: false })).toBe(root);
    const observed = await observeAgentHarnesses({
      isPackaged: false,
      bundle: await readBundle(bundleRoot),
      userDataPath: join(root, "data"),
    });
    expect(observed.every((item) => item.detected)).toBe(true);
    vi.stubEnv("OMNI_AGENT_HOME", "relative-home");
    expect(() => agentHomeDir({ isPackaged: false })).toThrow("absolute");
  });
  it("prefers the Desktop-managed MCP runtime after it has been materialized", async () => {
    const { root, homeDir } = await setup();
    const userDataPath = join(root, "omni-data");
    const runtimePath = join(userDataPath, "omni", "mcp", "omni-mcp.mjs");
    await mkdir(join(userDataPath, "omni", "mcp"), { recursive: true });
    await writeFile(runtimePath, "portable-runtime\n");

    expect(mcpCliPath({ userDataPath, appPath: homeDir })).toBe(runtimePath);
  });

  it("reports missing, installed, outdated, and foreign skill states", async () => {
    const { homeDir, bundleRoot } = await setup();
    const bundle = await readBundle(bundleRoot);
    const claudeSkills = join(homeDir, ".claude", "skills");
    const codexSkills = join(homeDir, ".codex", "skills");
    await mkdir(join(claudeSkills, "omni-lessons"), { recursive: true });
    await writeFile(
      join(claudeSkills, "omni-lessons", "SKILL.md"),
      await readFile(join(bundleRoot, "omni-lessons", "SKILL.md")),
    );
    await mkdir(join(codexSkills, "omni-lessons"), { recursive: true });
    await writeFile(join(codexSkills, "omni-lessons", "SKILL.md"), "---\nname: someone-else\n---\n\n# Foreign\n");
    await writeFile(join(claudeSkills, "omni-lessons", "extra.md"), "foreign extra\n");

    const observed = await observeAgentHarnesses({ homeDir, bundle, userDataPath: join(homeDir, "omni-data") });

    expect(observed).toEqual([
      expect.objectContaining({
        harness: "claude-code",
        detected: true,
        skillsPath: "~/.claude/skills",
        skills: [{ name: "omni-lessons", state: "outdated" }],
      }),
      expect.objectContaining({
        harness: "codex",
        detected: true,
        skills: [{ name: "omni-lessons", state: "foreign" }],
      }),
    ]);
  });

  it("marks a missing home as undetected and keeps the stable public shape", async () => {
    const { root, bundleRoot } = await setup();
    const observed = await observeAgentHarnesses({
      homeDir: join(root, "missing-home"),
      bundle: await readBundle(bundleRoot),
      userDataPath: join(root, "omni-data"),
    });

    expect(observed).toEqual([
      expect.objectContaining({ harness: "claude-code", detected: false, registered: false, current: false }),
      expect.objectContaining({ harness: "codex", detected: false, registered: false, current: false }),
    ]);
  });
});
