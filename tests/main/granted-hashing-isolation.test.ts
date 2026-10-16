import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RegistryGrant } from "../../src/main/registry-ipc";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.resetModules();
  vi.doUnmock("../../src/main/isolated-directory-reader");
});

describe("granted hashing directory isolation", () => {
  it("returns an unavailable result with the reader failure code instead of a partial hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-hash-isolation-"));
    roots.push(root);
    const canonicalRoot = await realpath(root);
    const details = await stat(canonicalRoot);
    const grant: RegistryGrant = {
      handle: "fixture",
      subject: { kind: "project", id: "fixture" },
      root: canonicalRoot,
      device: String(details.dev),
      inode: String(details.ino),
      expiresAt: Date.now() + 60_000,
    };
    vi.doMock("../../src/main/isolated-directory-reader", () => ({
      getSharedIsolatedDirectoryReader: () => ({
        readDirectory: async () => {
          const error = new Error("bounded child timed out") as NodeJS.ErrnoException;
          error.code = "directory-reader-timeout";
          throw error;
        },
      }),
    }));
    const { hashGrantedPath } = await import("../../src/main/granted-hashing");

    await expect(hashGrantedPath(grant, ".")).resolves.toEqual({
      status: "unavailable",
      reason: "directory-reader-timeout",
    });
  });
});
