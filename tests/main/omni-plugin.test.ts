import { RUNTIME_VERSION } from "../../packages/omni-mcp/src/version";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const pluginRoot = join(root, "plugins", "omni");
const canonicalSkillsRoot = join(root, "packages", "omni-skills", "skills");

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("Omni plugin", () => {
  it("is registered by the repo-local marketplace with a local MCP server", async () => {
    const marketplace = await readJson(join(root, ".agents", "plugins", "marketplace.json"));
    const plugins = marketplace.plugins as Array<Record<string, unknown>>;
    const entry = plugins.find((plugin) => plugin.name === "omni");
    const manifest = await readJson(join(pluginRoot, ".codex-plugin", "plugin.json"));
    const mcp = await readJson(join(pluginRoot, ".mcp.codex.json"));

    expect(entry?.source).toEqual({ source: "local", path: "./plugins/omni" });
    expect(manifest.name).toBe("omni");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./.mcp.codex.json");
    expect(mcp.mcpServers).toHaveProperty("omni");
    const runtime = await readFile(join(pluginRoot, "runtime", "omni-mcp.mjs"), "utf8");
    expect(runtime).toContain("omni_bootstrap_status");
  });

  it.each([
    ["codex", ".codex-plugin", ".mcp.codex.json", "scripts/omni-mcp.mjs", "codex-plugin"],
    ["claude-code", ".claude-plugin", ".mcp.json", "${CLAUDE_PLUGIN_ROOT}/scripts/omni-mcp.mjs", "claude-plugin"],
  ])(
    "launches the bundled runtime with the %s plugin context",
    async (harness, directory, config, launcher, source) => {
      const manifest = await readJson(join(pluginRoot, directory, "plugin.json"));
      if (harness === "codex") expect(manifest.mcpServers).toBe(`./${config}`);
      else expect(manifest).not.toHaveProperty("mcpServers");
      const mcp = await readJson(join(pluginRoot, config));
      expect(mcp).toEqual({
        mcpServers: {
          omni: {
            command: "node",
            args: [launcher],
            ...(harness === "codex" ? { cwd: "." } : {}),
            env: { OMNI_MCP_SOURCE: source, OMNI_MCP_HARNESS: harness },
          },
        },
      });
    },
  );

  it("keeps the plugin skills identical to the canonical Omni bundle", async () => {
    const [canonicalEntries, pluginEntries] = await Promise.all([
      readdir(canonicalSkillsRoot, { withFileTypes: true }),
      readdir(join(pluginRoot, "skills"), { withFileTypes: true }),
    ]);
    const canonicalNames = canonicalEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const pluginNames = pluginEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const consent = (await readFile(join(root, "packages/omni-skills/consent.md"), "utf8")).trim();
    expect(pluginNames).toEqual(canonicalNames);
    for (const name of canonicalNames) {
      const [canonical, plugin] = await Promise.all([
        readFile(join(canonicalSkillsRoot, name, "SKILL.md"), "utf8"),
        readFile(join(pluginRoot, "skills", name, "SKILL.md"), "utf8"),
      ]);
      expect(plugin).toBe(canonical);
      expect(canonical).toContain(consent);
    }
  });

  it.each([".mcp.codex.json", ".mcp.json"])(
    "starts the copied plugin through %s outside the repository",
    async (config) => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), "omni-plugin-copy-"));
      try {
        const copiedPlugin = join(temporaryRoot, "omni");
        await cp(pluginRoot, copiedPlugin, { recursive: true });
        const mcp = await readJson(join(copiedPlugin, config));
        const server = (
          mcp.mcpServers as Record<
            string,
            {
              command: string;
              args: string[];
              cwd?: string;
              env: Record<string, string>;
            }
          >
        ).omni!;
        const args = server.args.map((argument) => argument.replace("${CLAUDE_PLUGIN_ROOT}", copiedPlugin));
        const cwd = server.cwd ? resolve(copiedPlugin, server.cwd) : temporaryRoot;
        const result = await new Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>>(
          (resolve) => {
            const child = spawn(server.command, [...args, "--version"], {
              cwd,
              env: { ...process.env, ...server.env },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
            child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
            child.on("close", (code) => resolve({ code, stdout, stderr }));
          },
        );
        expect(result).toEqual({ code: 0, stdout: `${RUNTIME_VERSION}\n`, stderr: "" });
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );
});
