import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { runVersionCommand } from "../../scripts/release/version.mjs";

it("updates committed version files together and preserves locally modified changelog bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-version-test-"));
  const git = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  try {
    await mkdir(join(root, "packages/omni-mcp/src"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"example","version":"1.2.3"}\n');
    await writeFile(join(root, "packages/omni-mcp/src/version.ts"), 'export const RUNTIME_VERSION = "1.2.3";\n');
    await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## 1.2.3\n\n- Existing changes.\n");
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Ada Example",
      "-c",
      "user.email=ada@example.com",
      "commit",
      "-qm",
      "Synthetic version fixture",
    );
    await runVersionCommand(["1.3.0-rc.1"], root);
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version).toBe("1.3.0-rc.1");
    expect(await readFile(join(root, "packages/omni-mcp/src/version.ts"), "utf8")).toContain("1.3.0-rc.1");
    const before = await readFile(join(root, "CHANGELOG.md"), "utf8");
    await expect(runVersionCommand(["1.3.0"], root)).rejects.toThrow("local changes");
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
