import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { projectMarketplaceEntry, projectPluginManifest } from "../../src/domain/harness-projection";
import type { PackageManifest } from "../../src/domain/marketplace-format";

const root = process.cwd();

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, path), "utf8")) as Record<string, unknown>;
}

it("publishes the same Omni plugin through both harness marketplace formats", async () => {
  const pkg = await readJson("package.json");
  const description = "Use Omni as the source of truth for reusable skills, projects, and agent setup.";
  const canonical: PackageManifest = {
    format: "omni.plugin/1",
    id: "omni",
    name: "omni",
    version: pkg.version as string,
    description,
    artifacts: [{ kind: "skill", path: "skills/omni-bootstrap" }],
  };
  for (const [harness, path, directory] of [
    ["codex", ".agents/plugins/marketplace.json", ".codex-plugin"],
    ["claude-code", ".claude-plugin/marketplace.json", ".claude-plugin"],
  ] as const) {
    const marketplace = await readJson(path);
    expect(marketplace.name).toBe("omni");
    if (harness === "codex") expect(marketplace.interface).toEqual({ displayName: "Omni" });
    const entry = { ...projectMarketplaceEntry(canonical, "plugins/omni", harness) };
    // The plugin manifest owns its version; marketplace entries do not pin a second copy.
    delete entry.version;
    expect(marketplace.plugins).toEqual([expect.objectContaining(entry)]);
    const plugin = await readJson(`plugins/omni/${directory}/plugin.json`);
    expect(plugin).toMatchObject(projectPluginManifest(canonical, harness));
  }
});

it("ignores local agent installs while retaining the official marketplace and plugin files", () => {
  const paths = [
    ".claude/settings.local.json",
    ".cursor/skills/example/SKILL.md",
    ".codex/config.toml",
    ".agents/skills/example/SKILL.md",
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
    "plugins/omni/.codex-plugin/plugin.json",
    "plugins/omni/.claude-plugin/plugin.json",
    "plugins/omni/skills/omni-bootstrap/SKILL.md",
  ];
  const ignored = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: root,
    input: paths.join("\n") + "\n",
    encoding: "utf8",
  });
  expect(ignored.trim().split("\n")).toEqual(paths.slice(0, 4));
});
