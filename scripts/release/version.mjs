import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { assertVersionAgreement, changelogSection, planVersionBump } from "./policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
/** @returns {Promise<void>} */
export async function runVersionCommand(args, cwd = root) {
  const [operation, ...extra] = args;
  const relativePaths = [
    "package.json",
    "packages/omni-mcp/src/version.ts",
    "CHANGELOG.md",
    "plugins/omni/.codex-plugin/plugin.json",
    "plugins/omni/.claude-plugin/plugin.json",
  ];
  const paths = relativePaths.map((path) => join(cwd, path));
  const [pkg, mcp, changelog, ...pluginSources] = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const version = JSON.parse(pkg).version;
  const plugins = pluginSources.map((source) => JSON.parse(source));
  for (const [index, manifest] of plugins.entries()) {
    if (manifest?.version !== version)
      throw new Error(
        `Plugin manifest ${relativePaths[index + 3]} and package.json disagree. Align their versions before releasing.`,
      );
  }
  if (operation === "--check") {
    if (extra.length > 1) throw new Error("Usage: release:version --check [v<version>].");
    assertVersionAgreement(version, mcp, extra[0]);
    process.stdout.write(changelogSection(changelog, version));
    return;
  }
  if (!operation || extra.length) throw new Error("Usage: pnpm release:version <x.y.z[-pre.N]>.");
  const status = execFileSync("git", ["status", "--porcelain", "--", ...paths], { cwd, encoding: "utf8" });
  if (status.trim()) throw new Error("Version files have local changes. Commit them before bumping.");
  const next = planVersionBump(pkg, mcp, changelog, operation);
  const pluginUpdates = plugins.map((manifest) => JSON.stringify({ ...manifest, version: operation }, null, 2) + "\n");
  // Validate all inputs before the first write. Git retains a recoverable before-image.
  for (const [index, bytes] of [next.packageJson, next.mcpVersion, next.changelog, ...pluginUpdates].entries())
    await writeFile(paths[index], bytes);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    await runVersionCommand(args);
    // The committed plugin runtime embeds the MCP version; rebuild it with every bump.
    if (args[0] !== "--check")
      execFileSync(process.execPath, [join(root, "scripts/build-omni-plugin-runtime.mjs")], {
        cwd: root,
        stdio: "inherit",
      });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
