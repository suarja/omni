import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Client, InMemoryTransport } from "../../packages/omni-mcp/testing/sdk";
import { createOmniServer } from "../../packages/omni-mcp/src/server";
import { inspectBootstrapStatus } from "../../packages/omni-mcp/src/bootstrap-status";
import { RUNTIME_VERSION } from "../../packages/omni-mcp/src/version";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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
    const appPath = join(root, "Omni.app");
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

  it.each([
    ["codex-plugin", "codex", "claude-code"],
    ["claude-plugin", "claude-code", "codex"],
  ] as const)("recognizes %s skills only in the active harness", async (source, harness, otherHarness) => {
    const { homeDir, userDataPath, runtimePath } = await setup();
    vi.stubEnv("OMNI_MCP_SOURCE", source);
    vi.stubEnv("OMNI_MCP_HARNESS", harness);
    const status = await inspectBootstrapStatus({
      homeDir,
      userDataPath,
      runtimePath,
      desktopInstallPaths: [],
      gatewayProbe: async () => true,
    });
    expect(status).toMatchObject({
      status: "ready",
      plugin: { active: true, source },
      harnesses: {
        [harness]: { skill: "provided-by-plugin", registered: false },
        [otherHarness]: { skill: "missing" },
      },
      nextAction: { kind: "ready" },
    });
  });

  it("preserves Claude plugin provenance through the MCP diagnostic tool", async () => {
    const { homeDir, userDataPath, runtimePath } = await setup();
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("OMNI_USER_DATA", userDataPath);
    vi.stubEnv("OMNI_MCP_RUNTIME_PATH", runtimePath);
    vi.stubEnv("OMNI_MCP_SOURCE", "claude-plugin");
    vi.stubEnv("OMNI_MCP_HARNESS", "claude-code");
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = createOmniServer({
      request: async () => ({ ok: true, result: { status: "ready" } }),
      close: async () => {},
    });
    const client = new Client({ name: "bootstrap-test", version: "1" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: "omni_bootstrap_status", arguments: {} });
      expect(result.structuredContent).toMatchObject({
        status: "ready",
        plugin: { active: true, source: "claude-plugin" },
        harnesses: { "claude-code": { skill: "provided-by-plugin" }, codex: { skill: "missing" } },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("treats an unsupported source as unknown instead of supplying plugin skills", async () => {
    const { homeDir, userDataPath, runtimePath } = await setup();
    vi.stubEnv("OMNI_MCP_SOURCE", "untrusted-plugin");
    vi.stubEnv("OMNI_MCP_HARNESS", "claude-code");
    const status = await inspectBootstrapStatus({
      homeDir,
      userDataPath,
      runtimePath,
      desktopInstallPaths: [],
      gatewayProbe: async () => true,
    });
    expect(status).toMatchObject({
      status: "needs-registration",
      plugin: { active: false, source: "unknown" },
      harnesses: { "claude-code": { skill: "missing" } },
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
