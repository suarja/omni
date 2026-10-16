import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { hashSkillFolder } from "../../src/adapters/inventory/skill-folder-hash";
import { createLocalInventoryPort } from "../../src/adapters/inventory/local-filesystem";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-skill-hash-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("complete skill folder fingerprint", () => {
  it("hashes sorted relative paths and raw bytes across support files", async () => {
    const root = await createRoot();
    const folder = join(root, "review");
    const icon = Uint8Array.from([0, 4, 255, 9]);
    await mkdir(join(folder, "assets"), { recursive: true });
    await writeFile(join(folder, "SKILL.md"), "# Review\n");
    await writeFile(join(folder, "assets", "icon.png"), icon);

    const expected = createHash("sha256")
      .update("assets/icon.png", "utf8")
      .update(icon)
      .update("SKILL.md", "utf8")
      .update("# Review\n")
      .digest("hex");
    await expect(
      hashSkillFolder(createLocalInventoryPort(root), "review", { remainingBytes: 32 * 1024 * 1024 }),
    ).resolves.toEqual({ status: "hashed", hash: expected });
  });

  it("changes when a support file changes and ignores nested tool metadata", async () => {
    const root = await createRoot();
    const folder = join(root, "review");
    await mkdir(join(folder, ".git"), { recursive: true });
    await mkdir(join(folder, "node_modules", "package"), { recursive: true });
    await writeFile(join(folder, "SKILL.md"), "# Review\n");
    await writeFile(join(folder, "guide.md"), "one");
    await writeFile(join(folder, ".git", "ignored"), "one");
    await writeFile(join(folder, "node_modules", "package", "ignored"), "one");

    const filesystem = createLocalInventoryPort(root);
    const first = await hashSkillFolder(filesystem, "review", { remainingBytes: 32 * 1024 * 1024 });
    await writeFile(join(folder, "guide.md"), "two");
    await writeFile(join(folder, ".git", "ignored"), "two");
    await writeFile(join(folder, "node_modules", "package", "ignored"), "two");
    const second = await hashSkillFolder(filesystem, "review", { remainingBytes: 32 * 1024 * 1024 });

    expect(first.status).toBe("hashed");
    expect(second.status).toBe("hashed");
    expect(first).not.toEqual(second);
  });

  it("does not follow a symlink anywhere in the fingerprint tree", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const folder = join(root, "review");
    await mkdir(folder);
    await writeFile(join(folder, "SKILL.md"), "# Review\n");
    await writeFile(join(outside, "secret.md"), "outside");
    await symlink(join(outside, "secret.md"), join(folder, "reference.md"));

    await expect(
      hashSkillFolder(createLocalInventoryPort(root), "review", { remainingBytes: 32 * 1024 * 1024 }),
    ).resolves.toEqual({ status: "unverified", reason: "unsafe-tree" });
  });

  it("returns unverified when the folder or scan byte budget is exhausted", async () => {
    const root = await createRoot();
    const folder = join(root, "review");
    await mkdir(folder);
    await writeFile(join(folder, "SKILL.md"), "# Review\n");

    await expect(hashSkillFolder(createLocalInventoryPort(root), "review", { remainingBytes: 1 })).resolves.toEqual({
      status: "unverified",
      reason: "budget",
    });
  });
});
