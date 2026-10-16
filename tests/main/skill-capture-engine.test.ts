import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { captureSkillTree } from "../../src/main/skill-reconciliation/capture-engine";
import { captureCompleteSkillTree } from "../../src/main/skill-reconciliation/capture";
import { strictSkillObservationFilesystem } from "../../src/main/skill-reconciliation/filesystem";
import type { SkillObservationGrant } from "../../src/ports/skill-reconciliation";

test("source capture retains binary and support bytes while excluding only .git", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-skill-source-capture-")));
  try {
    const folder = join(root, "packages/tools/skills/demo");
    await mkdir(join(folder, "references"), { recursive: true });
    await mkdir(join(folder, ".git"), { recursive: true });
    await writeFile(join(folder, "SKILL.md"), "# Demo\n");
    await writeFile(join(folder, "references/notes.md"), "Support bytes\n");
    await writeFile(join(folder, "payload.bin"), Buffer.from([0, 255, 13, 10]));
    await writeFile(join(folder, ".git/config"), "ignored\n");
    const details = await stat(root, { bigint: true });
    const grant: SkillObservationGrant = {
      root,
      subject: { kind: "source", id: "personal-source" },
      device: String(details.dev),
      inode: String(details.ino),
      expiresAt: Date.now() + 60_000,
    };
    const capture = await captureSkillTree(
      grant,
      "packages/tools/skills/demo",
      { remainingBytes: 32 * 1024 * 1024 },
      strictSkillObservationFilesystem,
      (manifest) => createHash("sha256").update(manifest).digest("hex"),
    );
    expect(capture.status).toBe("complete");
    if (capture.status !== "complete") return;
    expect([...capture.files.keys()]).toEqual(
      expect.arrayContaining(["SKILL.md", "payload.bin", "references/notes.md"]),
    );
    expect(capture.files.get("payload.bin")).toEqual(new Uint8Array([0, 255, 13, 10]));
    expect(capture.revision.files).toHaveLength(3);
    await expect(
      captureCompleteSkillTree(
        grant,
        "packages/tools/skills/demo",
        { remainingBytes: 32 * 1024 * 1024 },
        strictSkillObservationFilesystem,
        (manifest) => createHash("sha256").update(manifest).digest("hex"),
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "unsafe-tree" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
