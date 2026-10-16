import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { requirePassingTests } from "./test-results.mjs";

const exec = promisify(execFile);
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it.each([
  ["passing", 'it("works", () => expect(1).toBe(1));', true, { tests: 1, passed: 1, unhandledErrors: 0 }],
  ["empty", "", false, { tests: 0, unhandledErrors: 0 }],
  [
    "unhandled",
    'it("rejects later", async () => { Promise.reject(new Error("late rejection")); await new Promise(setImmediate); });',
    false,
    { tests: 1, unhandledErrors: 1 },
  ],
  ["failing", 'it("fails", () => expect(1).toBe(2));', false, { tests: 1, failed: 1, unhandledErrors: 0 }],
])(
  "reports and gates real Vitest %s results",
  async (_name, body, passes, counts) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "public-vitest-")));
    roots.push(root);
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    await writeFile(join(root, "example.test.mjs"), `import { it, expect } from "vitest";\n${body}\n`);
    const report = join(root, "report.json");
    const outcome = await exec(
      process.execPath,
      [
        resolve("node_modules/vitest/vitest.mjs"),
        "run",
        "--root",
        root,
        "--config",
        resolve("vitest.config.ts"),
        "--maxWorkers=1",
        "--reporter=default",
        "--reporter",
        resolve("scripts/public-tree/test-reporter.mjs"),
      ],
      { env: { ...process.env, OMNI_PUBLIC_TEST_REPORT: report } },
    ).then(
      () => 0,
      (error) => {
        if (typeof error.code !== "number") throw error;
        return error.code;
      },
    );
    const summary = JSON.parse(await readFile(report, "utf8"));
    expect(summary).toMatchObject({ files: 1, ...counts });
    if (passes) {
      expect(outcome).toBe(0);
      expect(() => requirePassingTests(summary)).not.toThrow();
    } else {
      expect(outcome).not.toBe(0);
      expect(() => requirePassingTests(summary)).toThrow();
    }
  },
  20_000,
);
it("requires exactly one destination before creating a verification export", async () => {
  for (const args of [[], ["one", "two"]]) {
    await expect(exec(process.execPath, [resolve("scripts/public-tree/verify.mjs"), ...args])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Usage:"),
    });
  }
});
