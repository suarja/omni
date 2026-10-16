import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { captureCompleteSkillTree, revalidateSkillTreeCapture } from "../../src/main/skill-reconciliation/capture";
import { strictSkillObservationFilesystem } from "../../src/main/skill-reconciliation/filesystem";
import type { SkillObservationGrant } from "../../src/ports/skill-reconciliation";

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

test("captures bounded exact bytes and rejects a changed manifest before comparison", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omni-s04-capture-"));
  const projectRoot = join(temporaryRoot, "project");
  const folderPath = ".agents/skills/review";
  const skillRoot = join(projectRoot, folderPath);
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await mkdir(join(skillRoot, ".git"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "# Review\n");
  await writeFile(join(skillRoot, "references", "guide.md"), "Keep local changes.\n");
  await writeFile(join(skillRoot, ".git", "config"), "not part of the tree\n");
  const canonicalRoot = await realpath(projectRoot);
  const identity = await stat(canonicalRoot);
  const grant: SkillObservationGrant = {
    root: canonicalRoot,
    subject: { kind: "project", id: "project-one" },
    device: String(identity.dev),
    inode: String(identity.ino),
    expiresAt: Number.MAX_SAFE_INTEGER,
  };

  try {
    const capture = await captureCompleteSkillTree(
      grant,
      folderPath,
      { remainingBytes: 32 * 1024 * 1024 },
      strictSkillObservationFilesystem,
      digest,
    );
    expect(capture.status).toBe("complete");
    if (capture.status !== "complete") return;
    expect(capture.files.get("SKILL.md")).toEqual(Uint8Array.from(Buffer.from("# Review\n")));
    expect(capture.files.get("references/guide.md")).toEqual(Uint8Array.from(Buffer.from("Keep local changes.\n")));
    expect(capture.files.has(".git/config")).toBe(false);
    expect(await revalidateSkillTreeCapture(capture, grant, strictSkillObservationFilesystem)).toEqual({
      status: "complete",
      revision: capture.revision,
    });

    await writeFile(join(skillRoot, "references", "guide.md"), "Changed after capture.\n");
    expect(await revalidateSkillTreeCapture(capture, grant, strictSkillObservationFilesystem)).toEqual({
      status: "unavailable",
      reason: "changed-during-read",
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("keeps an incomplete tree unavailable instead of returning partial captured files", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omni-s04-capture-limit-"));
  const projectRoot = join(temporaryRoot, "project");
  const skillRoot = join(projectRoot, ".agents/skills/review");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, "large.bin"), new Uint8Array(1024 * 1024 + 1));
  const canonicalRoot = await realpath(projectRoot);
  const identity = await stat(canonicalRoot);
  const grant: SkillObservationGrant = {
    root: canonicalRoot,
    subject: { kind: "project", id: "project-one" },
    device: String(identity.dev),
    inode: String(identity.ino),
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  try {
    expect(
      await captureCompleteSkillTree(
        grant,
        ".agents/skills/review",
        { remainingBytes: 32 * 1024 * 1024 },
        strictSkillObservationFilesystem,
        digest,
      ),
    ).toMatchObject({ status: "unavailable", reason: "limit" });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
