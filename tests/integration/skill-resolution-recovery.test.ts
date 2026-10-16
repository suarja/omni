import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { managedFixture, previewIntent, applyPreview, resolutionIntent } from "./skill-resolution-fixture";
import { projectSkill, sourcePackage, sourceSkill, treeDigest } from "./skill-adoption-fixture";

async function replacedFixture() {
  const fixture = await managedFixture();
  await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Reviewed local note.\n");
  const result = await applyPreview(await previewIntent(resolutionIntent(fixture, "use-canonical")));
  expect(result.status).toBe("applied");
  return { fixture, result };
}

describe("managed resolution restore guards", () => {
  it("withholds a completed replacement restore when a user returns a file to its old bytes", async () => {
    const { fixture, result } = await replacedFixture();
    await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Reviewed local note.\n");
    const before = await treeDigest(fixture.projectRoot);
    const restore = await previewIntent({ kind: "restore", operationId: result.operationId });
    expect(restore.status).toBe("blocked");
    expect(await treeDigest(fixture.projectRoot)).toBe(before);
  });

  it("invalidates restore consent when a file changes back to old bytes after review", async () => {
    const { fixture, result } = await replacedFixture();
    const restore = await previewIntent({ kind: "restore", operationId: result.operationId });
    expect(restore.status).toBe("ready");
    await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Reviewed local note.\n");
    const before = await treeDigest(fixture.projectRoot);
    expect((await applyPreview(restore)).status).not.toBe("restored");
    expect(await treeDigest(fixture.projectRoot)).toBe(before);
  });

  it("restores saved project bytes after the source disappears", async () => {
    const { fixture, result } = await replacedFixture();
    const sourceBefore = await readFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "notes.md"));
    await rename(fixture.sourceRoot, fixture.sourceRoot + "-offline");
    try {
      const restore = await previewIntent({ kind: "restore", operationId: result.operationId });
      expect(restore.status).toBe("ready");
      expect((await applyPreview(restore)).status).toBe("restored");
      expect(await readFile(join(fixture.projectRoot, projectSkill, "notes.md"), "utf8")).toBe(
        "Reviewed local note.\n",
      );
      expect(await readFile(join(fixture.sourceRoot + "-offline", sourcePackage, sourceSkill, "notes.md"))).toEqual(
        sourceBefore,
      );
    } finally {
      await rename(fixture.sourceRoot + "-offline", fixture.sourceRoot);
    }
  });
});
