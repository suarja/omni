import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportPublicTree } from "./export.mjs";
import { requirePassingTests } from "./test-results.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

function run(cwd, command, args, env) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw new Error(`Public verification could not run ${command} in ${cwd}: ${result.error.message}`);
  return result;
}

function requireSuccess(result, operation, target) {
  if (result.status !== 0)
    throw new Error(
      `Public verification ${operation} failed in ${target}, exit ${result.status}, signal ${result.signal ?? "none"}. Fix the failure and retry in a new empty directory.`,
    );
}

/** Export and verify an immutable snapshot without starting Electron. @returns {Promise<void>} */
export async function verifyPublicTree(repo, target) {
  const result = await exportPublicTree(repo, target);
  for (const finding of result.findings)
    console.error(`${finding.file}:${finding.line}: ${finding.rule}: ${finding.message}`);
  if (result.findings.length)
    throw new Error(`Public verification blocked by ${result.findings.length} export findings.`);
  target = await realpath(target);
  console.log(`Exported ${result.fileCount} files to ${target}.`);
  const env = { ...process.env, CI: "true", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  // Do not borrow modules or repository identity from the invoking checkout.
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_") && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].includes(key)) delete env[key];
  delete env.NODE_PATH;
  const git = (...args) =>
    requireSuccess(
      run(target, "git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], env),
      "Git initialization",
      target,
    );
  git("init", "-q");
  git("add", "--all");
  git(
    "-c",
    "user.name=Ada Example",
    "-c",
    "user.email=ada@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Initialize public tree",
  );
  for (const args of [["install", "--frozen-lockfile"], ["typecheck"], ["lint"]])
    requireSuccess(run(target, "pnpm", args, env), args[0], target);
  const scratch = await mkdtemp(join(tmpdir(), "omni-public-results-"));
  try {
    const reportPath = join(scratch, "tests.json");
    const tests = run(
      target,
      "pnpm",
      [
        "test",
        "--maxWorkers=4",
        "--dangerouslyIgnoreUnhandledErrors=false",
        "--reporter=default",
        "--reporter=./scripts/public-tree/test-reporter.mjs",
      ],
      { ...env, OMNI_PUBLIC_TEST_REPORT: reportPath },
    );
    const summary = JSON.parse(await readFile(reportPath, "utf8"));
    console.log(`Public tests: ${JSON.stringify(summary)}`);
    requirePassingTests(summary);
    requireSuccess(tests, "tests", target);
    console.log(
      `PASS: public verification, ${result.fileCount} exported files, ${summary.files} test files, ${summary.tests} tests, ${summary.passed} passed, ${summary.skipped} skipped, ${summary.unhandledErrors} unhandled errors.`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const [target, ...extra] = process.argv.slice(2);
    if (!target || extra.length) throw new Error("Usage: pnpm verify:public <empty-target-dir>.");
    await verifyPublicTree(root, resolve(target));
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
