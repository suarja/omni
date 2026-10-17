import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultUserDataPath } from "./gateway-client.js";
import { RUNTIME_VERSION } from "./version.js";

export type BootstrapHarness = "claude-code" | "codex";
export type BootstrapSource = "codex-plugin" | "claude-plugin" | "direct" | "unknown";

export type BootstrapStatus = Readonly<{
  status: "ready" | "desktop-not-running" | "desktop-not-detected" | "needs-registration" | "needs-skills";
  plugin: Readonly<{ active: boolean; source: BootstrapSource }>;
  mcp: Readonly<{ status: "available"; transport: "stdio" }>;
  runtime: Readonly<{ status: "available" | "missing"; path: string; version: string }>;
  desktop: Readonly<{
    status: "running" | "installed" | "not-detected";
    userDataPath: string;
    socketPath: string;
    tokenPath: string;
    appPath?: string;
  }>;
  harnesses: Readonly<Record<BootstrapHarness, BootstrapHarnessStatus>>;
  nextAction: Readonly<{ kind: BootstrapAction; message: string }>;
}>;

export type BootstrapHarnessStatus = Readonly<{
  detected: boolean;
  registered: boolean;
  skill: "provided-by-plugin" | "installed" | "missing";
  settingsPath: string;
  skillsPath: string;
}>;

export type BootstrapAction = "ready" | "install-desktop" | "open-desktop" | "register-mcp" | "install-skills";

export type BootstrapStatusOptions = Readonly<{
  homeDir?: string;
  userDataPath?: string;
  runtimePath?: string;
  source?: BootstrapSource;
  harness?: BootstrapHarness;
  desktopInstallPaths?: readonly string[];
  gatewayProbe?: () => Promise<boolean>;
}>;

const HARNESS_PATHS: Readonly<Record<BootstrapHarness, Readonly<{ home: string; settings: string; skills: string }>>> =
  {
    "claude-code": { home: ".claude", settings: ".claude.json", skills: ".claude/skills" },
    codex: { home: ".codex", settings: ".codex/config.toml", skills: ".codex/skills" },
  };

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function defaultDesktopInstallPaths(home: string): readonly string[] {
  const configured = process.env.OMNI_DESKTOP_APP_PATH;
  const standard =
    process.platform === "darwin"
      ? [join("/Applications", "Omni.app"), join(home, "Applications", "Omni.app")]
      : process.platform === "win32"
        ? [join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "Omni", "Omni.exe")]
        : [join("/opt", "Omni", "omni"), join(home, ".local", "share", "omni", "omni")];
  return configured ? [configured, ...standard] : standard;
}

function sourceFromEnvironment(): BootstrapSource {
  const value = process.env.OMNI_MCP_SOURCE;
  return value === "codex-plugin" || value === "claude-plugin" || value === "direct" ? value : "unknown";
}

function harnessFromEnvironment(): BootstrapHarness | undefined {
  const value = process.env.OMNI_MCP_HARNESS;
  return value === "codex" || value === "claude-code" ? value : undefined;
}

async function registration(harness: BootstrapHarness, home: string): Promise<boolean> {
  const settings = await readOptional(join(home, HARNESS_PATHS[harness].settings));
  if (settings === undefined) return false;
  if (harness === "codex") return /^\[mcp_servers\.omni\][^\n]*(?:\n|$)/mu.test(settings);
  try {
    const root = JSON.parse(settings) as { mcpServers?: Record<string, unknown> };
    return Boolean(root.mcpServers && Object.prototype.hasOwnProperty.call(root.mcpServers, "omni"));
  } catch {
    return false;
  }
}

async function harnessStatus(
  harness: BootstrapHarness,
  home: string,
  source: BootstrapSource,
  activeHarness: BootstrapHarness | undefined,
): Promise<BootstrapHarnessStatus> {
  const paths = HARNESS_PATHS[harness];
  const detected = await exists(join(home, paths.home));
  const registered = await registration(harness, home);
  const installed = await exists(join(home, paths.skills, "omni-bootstrap", "SKILL.md"));
  const skill = installed
    ? "installed"
    : (source === "codex-plugin" || source === "claude-plugin") && activeHarness === harness
      ? "provided-by-plugin"
      : "missing";
  return {
    detected,
    registered,
    skill,
    settingsPath: harness === "codex" ? "~/.codex/config.toml" : "~/.claude.json",
    skillsPath: harness === "codex" ? "~/.codex/skills" : "~/.claude/skills",
  };
}

function actionFor(
  desktop: BootstrapStatus["desktop"],
  selected: BootstrapHarnessStatus,
  source: BootstrapSource,
): Readonly<{ kind: BootstrapAction; message: string }> {
  if (desktop.status === "not-detected")
    return {
      kind: "install-desktop",
      message:
        "Omni was not detected in its standard locations. Install it, or open the existing app if it is installed elsewhere.",
    };
  if (desktop.status === "installed")
    return { kind: "open-desktop", message: "Open Omni; this session reconnects by itself." };
  if (source === "unknown" && !selected.registered)
    return {
      kind: "register-mcp",
      message: "Register Omni MCP for this harness from Omni → Settings → Agents.",
    };
  if (selected.skill === "missing")
    return {
      kind: "install-skills",
      message: "Install Omni skills for this harness from Omni → Settings → Agents.",
    };
  return { kind: "ready", message: "Omni is ready. Use omni_status before managing reusable skills." };
}

export async function inspectBootstrapStatus(options: BootstrapStatusOptions = {}): Promise<BootstrapStatus> {
  const home = options.homeDir ?? homedir();
  const userDataPath = options.userDataPath ?? process.env.OMNI_USER_DATA ?? defaultUserDataPath();
  const runtimePath = options.runtimePath ?? process.env.OMNI_MCP_RUNTIME_PATH ?? process.argv[1] ?? "unknown";
  const source = options.source ?? sourceFromEnvironment();
  const activeHarness = options.harness ?? harnessFromEnvironment();
  const runtimeAvailable =
    runtimePath !== "unknown" && (runtimePath === process.argv[1] || (await exists(runtimePath)));
  const omniPath = join(userDataPath, "omni");
  const socketPath = join(omniPath, "agent.sock");
  const tokenPath = join(omniPath, "agent-token");
  const markerPath = join(omniPath, "desktop.json");
  const appPaths = options.desktopInstallPaths ?? defaultDesktopInstallPaths(home);
  const appPath = (await Promise.all(appPaths.map(async (path) => ((await exists(path)) ? path : undefined)))).find(
    Boolean,
  );
  const probedRunning = options.gatewayProbe ? await options.gatewayProbe().catch(() => false) : false;
  const filesSuggestRunning = (await exists(socketPath)) && (await exists(tokenPath));
  const desktopStatus =
    probedRunning || filesSuggestRunning
      ? "running"
      : appPath || (await exists(markerPath))
        ? "installed"
        : "not-detected";
  const harnesses = {
    "claude-code": await harnessStatus("claude-code", home, source, activeHarness),
    codex: await harnessStatus("codex", home, source, activeHarness),
  } as const;
  const selectedHarness = activeHarness ?? (harnesses.codex.registered ? "codex" : "claude-code");
  const selected = harnesses[selectedHarness];
  const desktop = {
    status: desktopStatus,
    userDataPath,
    socketPath,
    tokenPath,
    ...(appPath ? { appPath } : {}),
  } as BootstrapStatus["desktop"];
  const nextAction = actionFor(desktop, selected, source);
  return {
    status:
      nextAction.kind === "ready"
        ? "ready"
        : nextAction.kind === "open-desktop"
          ? "desktop-not-running"
          : nextAction.kind === "install-desktop"
            ? "desktop-not-detected"
            : nextAction.kind === "install-skills"
              ? "needs-skills"
              : "needs-registration",
    plugin: { active: source !== "unknown", source },
    mcp: { status: "available", transport: "stdio" },
    runtime: { status: runtimeAvailable ? "available" : "missing", path: runtimePath, version: RUNTIME_VERSION },
    desktop,
    harnesses,
    nextAction,
  };
}
