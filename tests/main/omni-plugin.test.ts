import { RUNTIME_VERSION } from "../../packages/omni-mcp/src/version";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const pluginRoot = join(root, "plugins", "omni");
const canonicalSkillsRoot = join(root, "packages", "omni-skills", "skills");

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("Omni Codex plugin", () => {
  it("is registered by the repo-local marketplace with a local MCP server", async () => {
    const marketplace = await readJson(join(root, ".agents", "plugins", "marketplace.json"));
    const plugins = marketplace.plugins as Array<Record<string, unknown>>;
    const entry = plugins.find((plugin) => plugin.name === "omni");
    const manifest = await readJson(join(pluginRoot, ".codex-plugin", "plugin.json"));
    const mcp = await readJson(join(pluginRoot, ".mcp.json"));

    expect(entry?.source).toEqual({ source: "local", path: "./plugins/omni" });
    expect(manifest.name).toBe("omni");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(mcp.mcpServers).toHaveProperty("omni");
    const runtime = await readFile(join(pluginRoot, "runtime", "omni-mcp.mjs"), "utf8");
    expect(runtime).toContain("omni_bootstrap_status");
  });

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

  it("starts from a copied plugin without repository-relative dependencies", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omni-plugin-copy-"));
    try {
      const copiedPlugin = join(temporaryRoot, "omni");
      await cp(pluginRoot, copiedPlugin, { recursive: true });
      const result = await new Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>>((resolve) => {
        const child = spawn(process.execPath, [join(copiedPlugin, "scripts", "omni-mcp.mjs"), "--version"], {
          cwd: temporaryRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      expect(result).toEqual({ code: 0, stdout: `${RUNTIME_VERSION}\n`, stderr: "" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
