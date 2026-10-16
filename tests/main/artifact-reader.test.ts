import { mkdtemp, mkdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readGrantedArtifact } from "../../src/main/artifact-reader";
import type { RegistryGrant, RegistryGrantStore } from "../../src/main/registry-ipc";

const roots: string[] = [];
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-reader-"));
  roots.push(root);
  return root;
}
async function createGrant(
  root: string,
  expiresAt = Date.now() + 60_000,
): Promise<{ grant: RegistryGrant; store: RegistryGrantStore }> {
  const canonicalRoot = await realpath(root);
  const details = await stat(canonicalRoot);
  const grant: RegistryGrant = {
    handle: "reader-grant",
    subject: { kind: "source", id: "source-one" },
    root: canonicalRoot,
    device: String(details.dev),
    inode: String(details.ino),
    expiresAt,
  };
  const store: RegistryGrantStore = {
    issue: () => grant.handle,
    get: (handle) => (handle === grant.handle && grant.expiresAt > Date.now() ? grant : undefined),
  };
  return { grant, store };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("grant-protected artifact reader", () => {
  it("reads UTF-8 files only for the matching current grant", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "README.md"), "# Real source\n", "utf8");
    const { store } = await createGrant(root);
    await expect(
      readGrantedArtifact(
        { kind: "source", id: "source-one", grantHandle: "reader-grant", relativePath: "README.md" },
        store,
      ),
    ).resolves.toEqual({ status: "read", content: "# Real source\n", byteLength: 14, truncated: false });
    await expect(
      readGrantedArtifact(
        { kind: "project", id: "project-two", grantHandle: "reader-grant", relativePath: "README.md" },
        store,
      ),
    ).resolves.toEqual({ status: "denied" });
  });

  it("denies expired grants, traversal and symlink escapes", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, join(root, "escape"), "dir");
    const { store: expired } = await createGrant(root, Date.now() - 1);
    const { store } = await createGrant(root);
    const request = (relativePath: string) => ({
      kind: "source" as const,
      id: "source-one",
      grantHandle: "reader-grant",
      relativePath,
    });
    await expect(readGrantedArtifact(request("missing.txt"), expired)).resolves.toEqual({ status: "denied" });
    await expect(readGrantedArtifact(request("../secret.txt"), store)).resolves.toEqual({ status: "denied" });
    await expect(readGrantedArtifact(request("escape/secret.txt"), store)).resolves.toEqual({ status: "denied" });
  });

  it("reports unavailable files and preserves binary and size outcomes", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "invalid.bin"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(root, "large.txt"), Buffer.alloc(256 * 1024 + 1, 97));
    const { store } = await createGrant(root);
    const request = (relativePath: string) => ({
      kind: "source" as const,
      id: "source-one",
      grantHandle: "reader-grant",
      relativePath,
    });
    await expect(readGrantedArtifact(request("folder"), store)).resolves.toMatchObject({ status: "unavailable" });
    await expect(readGrantedArtifact(request("missing.txt"), store)).resolves.toEqual({
      status: "unavailable",
      diagnostic: "The artifact is unavailable.",
    });
    await expect(readGrantedArtifact(request("binary.bin"), store)).resolves.toEqual({
      status: "binary",
      byteLength: 3,
    });
    await expect(readGrantedArtifact(request("invalid.bin"), store)).resolves.toEqual({
      status: "binary",
      byteLength: 2,
    });
    await expect(readGrantedArtifact(request("large.txt"), store)).resolves.toEqual({
      status: "too-large",
      byteLength: 256 * 1024 + 1,
      limit: 256 * 1024,
    });
  });

  it("denies a grant after its registered root is replaced", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "note.md"), "original", "utf8");
    const { store } = await createGrant(root);
    const moved = `${root}-moved`;
    roots.push(moved);
    await rename(root, moved);
    await mkdir(root);
    await writeFile(join(root, "note.md"), "replacement", "utf8");
    await expect(
      readGrantedArtifact(
        { kind: "source", id: "source-one", grantHandle: "reader-grant", relativePath: "note.md" },
        store,
      ),
    ).resolves.toEqual({ status: "denied" });
  });
});
