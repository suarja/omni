import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkTree } from "./check.mjs";
import { exportPublicTree } from "./export.mjs";
import { readPolicy } from "./policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [command, target, ...extra] = process.argv.slice(2);
let scratch;
try {
  if (extra.length || !["check", "export"].includes(command) || (command === "export" && !target))
    throw new Error("Usage: pnpm check:public [dir] or pnpm export:public <empty-target-dir>.");
  let result;
  if (command === "check" && target) {
    const policy = await readPolicy(root);
    result = { findings: await checkTree(resolve(target), policy.manifest, policy.terms) };
  } else {
    if (!target) scratch = await mkdtemp(join(tmpdir(), "omni-public-check-"));
    result = await exportPublicTree(root, target ? resolve(target) : scratch);
  }
  for (const finding of result.findings)
    console.error(`${finding.file}:${finding.line}: ${finding.rule}: ${finding.message}`);
  if (result.findings.length) {
    console.error(
      `FAIL: ${result.findings.length} public-tree finding(s), ${result.fileCount ?? "unknown"} candidate files. No export delivered.`,
    );
    process.exitCode = 1;
  } else
    console.log(
      `PASS: public tree checked${result.fileCount === undefined ? "" : `, ${result.fileCount} files exported`}.`,
    );
} catch (error) {
  console.error(`Public tree ${command ?? "command"} failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
