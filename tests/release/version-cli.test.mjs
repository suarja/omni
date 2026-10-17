import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { runVersionCommand } from "../../scripts/release/version.mjs";

const pluginPaths = ["plugins/omni/.codex-plugin/plugin.json", "plugins/omni/.claude-plugin/plugin.json"];

async function writePluginManifests(root) {
  for (const path of pluginPaths) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), JSON.stringify({ name: "omni", version: "1.2.3", license: "MIT" }) + "\n");
  }
}

async function writeVersionFixture(root) {
  await mkdir(join(root, "packages/omni-mcp/src"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"example","version":"1.2.3"}\n');
  await writeFile(join(root, "packages/omni-mcp/src/version.ts"), 'export const RUNTIME_VERSION = "1.2.3";\n');
  await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## 1.2.3\n\n- Existing changes.\n");
  await writePluginManifests(root);
}

function commitFixture(root) {
  const git = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  git("init", "-q");
  git("add", "package.json", "packages/omni-mcp/src/version.ts", "CHANGELOG.md", ...pluginPaths);
  git("-c", "user.name=Ada Example", "-c", "user.email=ada@example.com", "commit", "-qm", "Synthetic version fixture");
}

it("updates committed version files together and preserves locally modified changelog bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-version-test-"));
  try {
    await writeVersionFixture(root);
    commitFixture(root);
    await runVersionCommand(["1.3.0-rc.1"], root);
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version).toBe("1.3.0-rc.1");
    expect(await readFile(join(root, "packages/omni-mcp/src/version.ts"), "utf8")).toContain("1.3.0-rc.1");
    for (const path of pluginPaths) {
      expect(JSON.parse(await readFile(join(root, path), "utf8"))).toEqual({
        name: "omni",
        version: "1.3.0-rc.1",
        license: "MIT",
      });
    }
    const before = await readFile(join(root, "CHANGELOG.md"), "utf8");
    await expect(runVersionCommand(["1.3.0"], root)).rejects.toThrow("local changes");
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(pluginPaths)("refuses a version check when %s disagrees with Desktop", async (path) => {
  const root = await mkdtemp(join(tmpdir(), "omni-version-check-"));
  try {
    await writeVersionFixture(root);
    await expect(runVersionCommand(["--check", "v1.2.3"], root)).resolves.toBeUndefined();
    await writeFile(join(root, path), '{"name":"omni","version":"1.2.2"}\n');
    await expect(runVersionCommand(["--check"], root)).rejects.toThrow(/plugin.*disagree/i);
    expect(JSON.parse(await readFile(join(root, path), "utf8")).version).toBe("1.2.2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(pluginPaths)("preserves all version files when %s has local edits", async (path) => {
  const root = await mkdtemp(join(tmpdir(), "omni-version-dirty-"));
  try {
    await writeVersionFixture(root);
    commitFixture(root);
    await writeFile(join(root, path), '{"name":"omni","version":"1.2.3","description":"Local edit"}\n');
    const paths = ["package.json", "packages/omni-mcp/src/version.ts", "CHANGELOG.md", ...pluginPaths];
    const before = await Promise.all(paths.map((path) => readFile(join(root, path), "utf8")));
    await expect(runVersionCommand(["1.3.0"], root)).rejects.toThrow("local changes");
    expect(await Promise.all(paths.map((path) => readFile(join(root, path), "utf8")))).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
