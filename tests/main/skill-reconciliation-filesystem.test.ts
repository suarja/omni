import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { strictSkillObservationFilesystem } from "../../src/main/skill-reconciliation/filesystem";
import { observeCompleteSkillTree } from "../../src/main/skill-reconciliation/observe";
import type { SkillObservationGrant } from "../../src/ports/skill-reconciliation";

test("an internal symlink in a skill's parent path cannot establish equivalence", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-s04-alias-")));
  try {
    await mkdir(join(root, "actual/skills/review"), { recursive: true });
    await writeFile(join(root, "actual/skills/review/SKILL.md"), "# Review\n");
    await symlink("actual", join(root, ".agents"));
    const details = await stat(root, { bigint: true });
    const grant: SkillObservationGrant = {
      root,
      subject: { kind: "project", id: "test-project" },
      device: String(details.dev),
      inode: String(details.ino),
      expiresAt: Date.now() + 60_000,
    };
    const result = await observeCompleteSkillTree(
      grant,
      ".agents/skills/review",
      { remainingBytes: 32 * 1024 * 1024 },
      strictSkillObservationFilesystem,
      (manifest) => createHash("sha256").update(manifest).digest("hex"),
    );
    expect(result).toEqual({ status: "unavailable", reason: "unsafe-tree" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
