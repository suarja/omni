import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { assertVersionAgreement, changelogSection, planVersionBump } from "./policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
/** @returns {Promise<void>} */
export async function runVersionCommand(args, cwd = root) {
  const [operation, ...extra] = args;
  const paths = ["package.json", "packages/omni-mcp/src/version.ts", "CHANGELOG.md"].map((path) => join(cwd, path));
  const [pkg, mcp, changelog] = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const version = JSON.parse(pkg).version;
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
  // Validate all inputs before the first write. Git retains a recoverable before-image.
  for (const [index, bytes] of [next.packageJson, next.mcpVersion, next.changelog].entries())
    await writeFile(paths[index], bytes);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runVersionCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
