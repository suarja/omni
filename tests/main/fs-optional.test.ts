import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isMissing, readOptionalText } from "../../src/main/fs-optional";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("optional filesystem helpers", () => {
  it("recognizes missing path errors without treating directories as missing", () => {
    expect(isMissing({ code: "ENOENT" })).toBe(true);
    expect(isMissing({ code: "ENOTDIR" })).toBe(true);
    expect(isMissing({ code: "EISDIR" })).toBe(false);
    expect(isMissing(new Error("missing"))).toBe(false);
  });

  it("reads text, returns undefined for missing paths, and throws other errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-fs-optional-"));
    roots.push(root);
    await writeFile(join(root, "note.txt"), "hello\n");
    await mkdir(join(root, "directory"));

    await expect(readOptionalText(join(root, "note.txt"))).resolves.toBe("hello\n");
    await expect(readOptionalText(join(root, "missing.txt"))).resolves.toBeUndefined();
    await expect(readOptionalText(join(root, "directory"))).rejects.toMatchObject({ code: "EISDIR" });
  });
});
