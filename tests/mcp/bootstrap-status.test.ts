import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectBootstrapStatus } from "../../packages/omni-mcp/src/bootstrap-status";
import { RUNTIME_VERSION } from "../../packages/omni-mcp/src/version";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<
  Readonly<{ root: string; homeDir: string; userDataPath: string; runtimePath: string }>
> {
  const root = await mkdtemp(join(tmpdir(), "omni-bootstrap-status-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const userDataPath = join(root, "omni-data");
  const runtimePath = join(root, "runtime", "omni-mcp.mjs");
  await mkdir(join(homeDir, ".codex"), { recursive: true });
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(runtimePath, "runtime\n");
  return { root, homeDir, userDataPath, runtimePath };
}

describe("Omni bootstrap status", () => {
  it("reports the shipped runtime version without a caller-supplied version", async () => {
    const { homeDir, userDataPath, runtimePath } = await setup();
    const status = await inspectBootstrapStatus({ homeDir, userDataPath, runtimePath, desktopInstallPaths: [] });

    expect(status.runtime.version).toBe(RUNTIME_VERSION);
  });

  it("reports an active plugin and the exact Desktop installation action", async () => {
    const { homeDir, userDataPath, runtimePath } = await setup();

    await expect(
      inspectBootstrapStatus({
        homeDir,
        userDataPath,
        runtimePath,
        source: "codex-plugin",
        harness: "codex",
        desktopInstallPaths: [],
      }),
    ).resolves.toMatchObject({
      status: "desktop-not-detected",
      plugin: { active: true, source: "codex-plugin" },
      runtime: { status: "available", path: runtimePath },
      desktop: { status: "not-detected" },
      nextAction: { kind: "install-desktop" },
      harnesses: { codex: { skill: "provided-by-plugin" } },
    });
  });

  it("distinguishes an installed but closed Desktop from an absent one", async () => {
    const { homeDir, userDataPath, runtimePath, root } = await setup();
    const appPath = join(root, "Omni Desktop.app");
    await mkdir(appPath, { recursive: true });

    const status = await inspectBootstrapStatus({
      homeDir,
      userDataPath,
      runtimePath,
      source: "codex-plugin",
      harness: "codex",
      desktopInstallPaths: [appPath],
    });

    expect(status).toMatchObject({
      status: "desktop-not-running",
      desktop: { status: "installed", appPath },
      nextAction: { kind: "open-desktop" },
    });
  });

  it("reports a ready path when the gateway probe confirms Desktop", async () => {
    const { homeDir, userDataPath, runtimePath } = await setup();
    await mkdir(join(userDataPath, "omni"), { recursive: true });

    const status = await inspectBootstrapStatus({
      homeDir,
      userDataPath,
      runtimePath,
      source: "codex-plugin",
      harness: "codex",
      desktopInstallPaths: [],
      gatewayProbe: async () => true,
    });

    expect(status).toMatchObject({
      status: "ready",
      desktop: { status: "running" },
      nextAction: { kind: "ready" },
    });
  });

  it("recognizes the direct Codex path independently from the plugin", async () => {
    const { homeDir, userDataPath, runtimePath } = await setup();
    await mkdir(join(homeDir, ".codex", "skills", "omni-bootstrap"), { recursive: true });
    await writeFile(join(homeDir, ".codex", "skills", "omni-bootstrap", "SKILL.md"), "skill\n");
    await writeFile(join(homeDir, ".codex", "config.toml"), '[mcp_servers.omni]\ncommand = "node"\n');

    const status = await inspectBootstrapStatus({
      homeDir,
      userDataPath,
      runtimePath,
      source: "unknown",
      harness: "codex",
      desktopInstallPaths: [],
      gatewayProbe: async () => true,
    });

    expect(status).toMatchObject({
      status: "ready",
      plugin: { active: false, source: "unknown" },
      harnesses: { codex: { registered: true, skill: "installed" } },
      nextAction: { kind: "ready" },
    });
  });
});
