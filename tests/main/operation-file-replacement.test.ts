import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAtomically } from "../../src/main/operation-files";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function seed(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-file-replacement-"));
  roots.push(root);
  await writeFile(join(root, "SKILL.md"), "before");
  return root;
}

describe("atomic replacement evidence", () => {
  it("reports replacement only after the temporary file has replaced the target", async () => {
    const root = await seed();
    let replaced = false;
    await writeAtomically(
      root,
      "SKILL.md",
      "after",
      async (path, content, options) => {
        expect(replaced).toBe(false);
        expect(await readFile(join(root, "SKILL.md"), "utf8")).toBe("before");
        await writeFile(path, content, options);
      },
      () => {
        replaced = true;
      },
    );
    expect(replaced).toBe(true);
    expect(await readFile(join(root, "SKILL.md"), "utf8")).toBe("after");
  });

  it("keeps a temporary-file creation failure provably before replacement", async () => {
    const root = await seed();
    let replaced = false;
    await expect(
      writeAtomically(
        root,
        "SKILL.md",
        "after",
        async () => {
          throw new Error("EACCES creating temporary file");
        },
        () => {
          replaced = true;
        },
      ),
    ).rejects.toThrow("EACCES");
    expect(replaced).toBe(false);
    expect(await readFile(join(root, "SKILL.md"), "utf8")).toBe("before");
  });
});
