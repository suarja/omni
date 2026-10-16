import { existsSync } from "node:fs";
import { readFile, lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { AgentHarness } from "../shared/agents-ipc";
import { parseFrontmatter } from "../adapters/inventory/frontmatter";
import type { OmniSkillBundle, OmniSkillBundleItem } from "./omni-skills-bundle";
import { bundleRoot, readBundle } from "./omni-skills-bundle";
import { isMissing, readOptionalText } from "./fs-optional";
import { mcpEntryState } from "./mcp-entry";
import { guardEntryState } from "./hook-entry";
import { resolveResource, resourcesArePackaged, type ResourceOptions } from "./omni-resources";
import { userMcpRuntimePath } from "./omni-mcp-runtime";
import { userGuardScriptPath } from "./omni-guard-runtime";

const MCP_RELATIVE_PATHS = {
  "claude-code": {
    home: ".claude",
    settings: ".claude.json",
    display: "~/.claude.json",
    skills: ".claude/skills",
    skillsDisplay: "~/.claude/skills",
    guardSettings: ".claude/settings.json",
    guardSettingsDisplay: "~/.claude/settings.json",
  },
  codex: {
    home: ".codex",
    settings: ".codex/config.toml",
    display: "~/.codex/config.toml",
    skills: ".codex/skills",
    skillsDisplay: "~/.codex/skills",
    guardSettings: ".codex/hooks.json",
    guardSettingsDisplay: "~/.codex/hooks.json",
  },
} as const;
const MCP_RUNTIME_RELATIVE_PATH = join("plugins", "omni", "runtime", "omni-mcp.mjs");
const MCP_BUILD_RELATIVE_PATH = join("packages", "omni-mcp", "dist", "cli.js");
const GUARD_SCRIPT_RELATIVE_PATH = join("resources", "guard", "omni-guard.mjs");

export type AgentHarnessObservation = Readonly<{
  harness: AgentHarness;
  detected: boolean;
  registered: boolean;
  current: boolean;
  settingsPath: string;
  skillsPath: string;
  skills: readonly Readonly<{ name: string; state: "installed" | "outdated" | "missing" | "foreign" }>[];
  // Omni's PreToolUse guard hook is present and matches exactly what Omni would write today
  // (item 7). A harness only counts as fully installed once this is also true.
  guard: boolean;
  lastSeenAt?: string;
}>;
export type AgentHarnessInspection = AgentHarnessObservation &
  Readonly<{
    skillDetails: readonly Readonly<{
      name: string;
      state: "installed" | "outdated" | "missing" | "foreign";
      foreignName?: string;
      files: readonly string[];
      contents: ReadonlyMap<string, string>;
    }>[];
  }>;
export type AgentHarnessOptions = ResourceOptions &
  Readonly<{
    userDataPath: string;
    homeDir?: string;
    bundle?: OmniSkillBundle;
    cliPath?: string;
    guardPath?: string;
    harnesses?: readonly AgentHarness[];
  }>;

/** Development reception must never address the owner's real agent folders. */
export function agentHomeDir(options: Readonly<{ homeDir?: string; isPackaged?: boolean }>): string {
  if (options.homeDir !== undefined) return options.homeDir;
  const override = resourcesArePackaged(options) ? undefined : process.env.OMNI_AGENT_HOME;
  if (override === undefined) return homedir();
  if (!isAbsolute(override) || /[\u0000-\u001f]/u.test(override))
    throw new Error("OMNI_AGENT_HOME must be an absolute directory path.");
  return resolve(override);
}

export function mcpCliPath(options: ResourceOptions & Readonly<{ cliPath?: string; userDataPath?: string }>): string {
  if (options.cliPath) return options.cliPath;
  if (options.userDataPath) {
    const materialized = userMcpRuntimePath(options.userDataPath);
    if (existsSync(materialized)) return materialized;
  }
  const bundled = resolveResource(MCP_RUNTIME_RELATIVE_PATH, options);
  if (existsSync(bundled)) return bundled;
  return resolveResource(MCP_BUILD_RELATIVE_PATH, options);
}

/** Resolves the guard script's stable command path, the same way `mcpCliPath` resolves the MCP cli. */
export function guardScriptPath(
  options: ResourceOptions & Readonly<{ guardPath?: string; userDataPath?: string }>,
): string {
  if (options.guardPath) return options.guardPath;
  if (options.userDataPath) {
    const materialized = userGuardScriptPath(options.userDataPath);
    if (existsSync(materialized)) return materialized;
  }
  return resolveResource(GUARD_SCRIPT_RELATIVE_PATH, options);
}

function frontmatterName(content: string): string | undefined {
  if (!parseFrontmatter(content, true).valid) return undefined;
  const lines = content.split(/\r?\n/u);
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  const field = lines.slice(1, end < 0 ? lines.length : end + 1).find((line) => /^\s*name\s*:/u.test(line));
  const value = field?.replace(/^\s*name\s*:\s*/u, "").trim();
  if (!value) return undefined;
  return (
    value
      .match(/^(?:"([^"]*)"|'([^']*)'|(.*))$/u)
      ?.slice(1)
      .find((item) => item !== undefined) ?? value
  );
}

async function regularFiles(root: string, relativePath = ""): Promise<ReadonlyMap<string, string>> {
  const directory = join(root, relativePath);
  const result = new Map<string, string>();
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const child = relativePath ? join(relativePath, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Agent skill folders must not contain symlinks.");
    if (entry.isDirectory()) {
      for (const [path, content] of await regularFiles(root, child)) result.set(path, content);
    } else if (entry.isFile()) result.set(child.replaceAll("\\", "/"), await readFile(join(root, child), "utf8"));
    else throw new Error("Agent skill folder contains an unsupported entry.");
  }
  return result;
}

async function inspectSkill(
  root: string,
  skill: OmniSkillBundleItem,
): Promise<AgentHarnessInspection["skillDetails"][number]> {
  const folder = join(root, skill.name);
  let files: ReadonlyMap<string, string>;
  try {
    const details = await lstat(folder);
    if (!details.isDirectory() || details.isSymbolicLink())
      return { name: skill.name, state: "foreign", files: [], contents: new Map() };
    files = await regularFiles(folder);
  } catch (error: unknown) {
    if (isMissing(error)) return { name: skill.name, state: "missing", files: [], contents: new Map() };
    return { name: skill.name, state: "foreign", files: [], contents: new Map() };
  }
  if (files.size === 0) return { name: skill.name, state: "missing", files: [], contents: files };
  const skillFile = files.get("SKILL.md");
  const name = skillFile === undefined ? undefined : frontmatterName(skillFile);
  if (name !== skill.name)
    return { name: skill.name, state: "foreign", foreignName: name, files: [...files.keys()], contents: files };
  const expected = new Map(skill.files.map((file) => [file.relativePath, file.content]));
  const identical =
    expected.size === files.size && [...expected].every(([path, content]) => files.get(path) === content);
  return { name: skill.name, state: identical ? "installed" : "outdated", files: [...files.keys()], contents: files };
}

async function homeReadable(home: string): Promise<boolean> {
  try {
    const details = await lstat(home);
    if (!details.isDirectory() || details.isSymbolicLink()) return false;
    await readdir(home);
    return true;
  } catch {
    return false;
  }
}

export async function inspectAgentHarnesses(options: AgentHarnessOptions): Promise<readonly AgentHarnessInspection[]> {
  const home = agentHomeDir(options);
  const bundle = options.bundle ?? (await readBundle(bundleRoot(options)));
  const cli = mcpCliPath(options);
  const guardPath = guardScriptPath(options);
  const result: AgentHarnessInspection[] = [];
  for (const harness of options.harnesses ?? (["claude-code", "codex"] as const)) {
    const paths = harnessPaths(harness);
    const detected = await homeReadable(join(home, paths.home));
    const settings = await readOptionalText(join(home, paths.settings));
    const registration = detected
      ? mcpEntryState(harness, settings, cli, options.userDataPath)
      : mcpEntryState(harness, undefined, cli, options.userDataPath);
    const guardSettings = detected ? await readOptionalText(join(home, paths.guardSettings)) : undefined;
    const guard = detected && guardEntryState(guardSettings, harness, guardPath).current;
    const skillRoot = join(home, paths.skills);
    const skillDetails = detected
      ? await Promise.all(bundle.map((skill) => inspectSkill(skillRoot, skill)))
      : bundle.map((skill) => ({ name: skill.name, state: "missing" as const, files: [], contents: new Map() }));
    result.push({
      harness,
      detected,
      ...registration,
      guard,
      settingsPath: paths.settingsDisplay,
      skillsPath: paths.skillsDisplay,
      skills: skillDetails.map(({ name, state }) => ({ name, state })),
      skillDetails,
    });
  }
  return result;
}

export async function observeAgentHarnesses(options: AgentHarnessOptions): Promise<readonly AgentHarnessObservation[]> {
  const inspections = await inspectAgentHarnesses(options);
  return inspections.map(({ skillDetails: _skillDetails, ...observation }) => observation);
}

export function harnessPaths(harness: AgentHarness): Readonly<{
  home: string;
  settings: string;
  settingsDisplay: string;
  skills: string;
  skillsDisplay: string;
  guardSettings: string;
  guardSettingsDisplay: string;
}> {
  const paths = MCP_RELATIVE_PATHS[harness];
  return {
    home: paths.home,
    settings: paths.settings,
    settingsDisplay: paths.display,
    skills: paths.skills,
    skillsDisplay: paths.skillsDisplay,
    guardSettings: paths.guardSettings,
    guardSettingsDisplay: paths.guardSettingsDisplay,
  };
}

export function harnessLabel(harness: AgentHarness): string {
  return harness === "claude-code" ? "Claude Code" : "Codex";
}
