import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalInventoryPort } from "../../src/adapters/inventory/local-filesystem";
import { InventoryFilesystemError } from "../../src/ports/inventory";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-inventory-port-"));
  temporaryRoots.push(root);
  return root;
}

async function createFifo(path: string): Promise<void> {
  await execFileAsync("mkfifo", [path]);
}

function expectNoAbsolutePaths(value: unknown, ...absolutePaths: readonly string[]): void {
  const message = value instanceof Error ? value.message : "";
  const serialized = `${JSON.stringify(value)} ${message}`;
  for (const absolutePath of absolutePaths) {
    expect(serialized).not.toContain(absolutePath);
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local inventory filesystem port", () => {
  it("reads bounded binary bytes without text conversion", async () => {
    const root = await createRoot();
    const expected = Uint8Array.from([0, 255, 1, 128]);
    await writeFile(join(root, "asset.bin"), expected);
    const port = createLocalInventoryPort(root);

    await expect(port.readBytes("asset.bin").then((bytes) => Buffer.from(bytes))).resolves.toEqual(
      Buffer.from(expected),
    );
    await expect(port.readBytes("missing.bin")).rejects.toMatchObject({
      operation: "readBytes",
      code: "not-found",
    });
  });

  it("lists entries in sorted order and reports lstat file types without following links", async () => {
    const root = await createRoot();
    await mkdir(join(root, "directory"));
    await writeFile(join(root, "z-file.txt"), "z");
    await writeFile(join(root, "a-file.txt"), "a");
    await symlink(join(root, "z-file.txt"), join(root, "linked-file"));
    const port = createLocalInventoryPort(root);

    await expect(port.listDirectory("")).resolves.toEqual([
      { name: "a-file.txt", type: "file" },
      { name: "directory", type: "directory" },
      { name: "linked-file", type: "symlink" },
      { name: "z-file.txt", type: "file" },
    ]);
    await expect(port.lstat("linked-file")).resolves.toMatchObject({
      type: "symlink",
    });
    await expect(port.readlink("linked-file")).resolves.toEqual({
      path: "linked-file",
      target: "z-file.txt",
      targetKind: "inside-root",
    });
    await expect(port.realpathEvidence("linked-file")).resolves.toEqual({
      path: "linked-file",
      status: "inside-root",
      realpath: "z-file.txt",
    });
    await expect(port.lstat("directory")).resolves.toMatchObject({
      type: "directory",
    });
  });

  it("reports link targets and realpath evidence without treating external or broken links as content", async () => {
    const root = await createRoot();
    const outsideRoot = await createRoot();
    const externalTarget = join(outsideRoot, "external-cache");
    await mkdir(externalTarget);
    await writeFile(join(externalTarget, "external-secret.txt"), "external content");
    await symlink(externalTarget, join(root, "external-link"));
    await symlink(join(root, "missing.txt"), join(root, "broken-link"));
    const port = createLocalInventoryPort(root);

    await expect(port.readlink("external-link")).resolves.toEqual({
      path: "external-link",
      target: "<outside-root>",
      targetKind: "outside-root",
    });
    await expect(port.readlink("broken-link")).resolves.toEqual({
      path: "broken-link",
      target: "missing.txt",
      targetKind: "inside-root",
    });
    const externalEvidence = await port.readlink("external-link");
    expect(JSON.stringify(externalEvidence)).not.toContain(outsideRoot);
    await expect(port.realpathEvidence("external-link")).resolves.toEqual({
      path: "external-link",
      status: "outside-root",
    });
    await expect(port.realpathEvidence("broken-link")).resolves.toEqual({
      path: "broken-link",
      status: "broken",
    });
    await expect(port.readText("external-link")).rejects.toMatchObject({
      operation: "readText",
      path: "external-link",
      code: "unsupported",
    });
    await expect(port.hash("external-link")).rejects.toMatchObject({
      operation: "hash",
      path: "external-link",
      code: "unsupported",
    });
    await expect(port.readBytes("external-link")).rejects.toMatchObject({
      operation: "readBytes",
      path: "external-link",
      code: "unsupported",
    });
    await expect(port.listDirectory("external-link")).rejects.toMatchObject({
      operation: "listDirectory",
      code: "unsupported",
    });
  });

  it("distinguishes an absent path from a broken symlink in realpath evidence", async () => {
    const root = await createRoot();
    await symlink(join(root, "missing-target.txt"), join(root, "broken-link"));
    const port = createLocalInventoryPort(root);

    await expect(port.realpathEvidence("missing.txt")).rejects.toMatchObject({
      operation: "realpathEvidence",
      path: "missing.txt",
      code: "not-found",
    });
    await expect(port.realpathEvidence("broken-link")).resolves.toEqual({
      path: "broken-link",
      status: "broken",
    });
  });

  it("rejects lexical traversal, absolute paths, and paths through outside-root links with operation-safe errors", async () => {
    const root = await createRoot();
    const outsideRoot = await createRoot();
    await writeFile(join(outsideRoot, "secret.txt"), "secret");
    await symlink(outsideRoot, join(root, "outside-link"));
    const port = createLocalInventoryPort(root);

    await expect(port.lstat("../outside.txt")).rejects.toMatchObject({
      operation: "lstat",
      path: "../outside.txt",
      code: "invalid-path",
    });
    const absolutePathError = await port.lstat(join(root, "secret.txt")).catch((error: unknown) => error);
    expect(absolutePathError).toMatchObject({
      operation: "lstat",
      path: "secret.txt",
      code: "invalid-path",
    });
    expect(absolutePathError).toBeInstanceOf(Error);
    expect((absolutePathError as Error).message).not.toContain(root);
    await expect(port.lstat("outside-link/secret.txt")).rejects.toMatchObject({
      operation: "lstat",
      path: "outside-link/secret.txt",
      code: "invalid-path",
    });
    await expect(port.readText("outside-link/secret.txt")).rejects.toMatchObject({
      operation: "readText",
      path: "outside-link/secret.txt",
      code: "invalid-path",
    });
    await expect(port.hash("outside-link/secret.txt")).rejects.toMatchObject({
      operation: "hash",
      path: "outside-link/secret.txt",
      code: "invalid-path",
    });
  });

  it("maps readlink EINVAL for a regular file to unsupported", async () => {
    const root = await createRoot();
    await writeFile(join(root, "regular.txt"), "regular content");
    const port = createLocalInventoryPort(root);

    await expect(port.readlink("regular.txt")).rejects.toMatchObject({
      operation: "readlink",
      path: "regular.txt",
      code: "unsupported",
    });
  });

  it("sanitizes approved-root factory failures", async () => {
    const root = await createRoot();
    const missingRoot = join(root, "missing-root");
    let factoryError: unknown;

    try {
      createLocalInventoryPort(missingRoot);
    } catch (error: unknown) {
      factoryError = error;
    }

    expect(factoryError).toMatchObject({
      operation: "create",
      path: "<approved-root>",
      code: "not-found",
    });
    expect(factoryError).toBeInstanceOf(Error);
    expect((factoryError as Error).message).not.toContain(root);
  });

  it("keeps evidence and every error field/message free of absolute paths", async () => {
    const root = await createRoot();
    const outsideRoot = await createRoot();
    await writeFile(join(outsideRoot, "secret.txt"), "secret");
    await symlink(join(outsideRoot, "secret.txt"), join(root, "external-link"));
    const port = createLocalInventoryPort(root);
    const evidence = await port.readlink("external-link");
    const realpathEvidence = await port.realpathEvidence("external-link");
    const pathError = await port.lstat(join(root, "secret.txt")).catch((error: unknown) => error);
    const directError = new InventoryFilesystemError(
      "readText",
      join(root, "secret.txt"),
      "io",
      `unexpected source ${outsideRoot}/secret.txt`,
    );

    for (const value of [evidence, realpathEvidence, pathError, directError]) {
      expectNoAbsolutePaths(value, root, outsideRoot);
    }
  });

  it("orders mixed-case and symbol names by locale-independent code-unit order", async () => {
    const root = await createRoot();
    const names = ["z-lower", "Z-upper", "_underscore", "-dash", ".dot", "0-zero", "a-lower", "A-upper"];
    await Promise.all(names.map((name) => writeFile(join(root, name), name)));
    const port = createLocalInventoryPort(root);

    await expect(port.listDirectory("")).resolves.toEqual([
      { name: "-dash", type: "file" },
      { name: ".dot", type: "file" },
      { name: "0-zero", type: "file" },
      { name: "A-upper", type: "file" },
      { name: "Z-upper", type: "file" },
      { name: "_underscore", type: "file" },
      { name: "a-lower", type: "file" },
      { name: "z-lower", type: "file" },
    ]);
  });

  it("rejects UTF-8 text reads before oversized content is returned", async () => {
    const root = await createRoot();
    await writeFile(join(root, "metadata.json"), '{"token":"must-not-return"}');
    const port = createLocalInventoryPort(root, { maxFileBytes: 8 });

    await expect(port.readText("metadata.json")).rejects.toMatchObject({
      operation: "readText",
      path: "metadata.json",
      code: "oversized",
    });
    await expect(port.readText("metadata.json")).rejects.toThrow(
      'inventory filesystem readText failed for "metadata.json"',
    );
    await expect(port.readText("metadata.json")).rejects.not.toThrow("must-not-return");
  });

  it("returns a deterministic bounded SHA-256 hash for a regular file", async () => {
    const root = await createRoot();
    const content = "stable metadata";
    await writeFile(join(root, "metadata.json"), content);
    const port = createLocalInventoryPort(root);
    const expectedHash = createHash("sha256").update(content, "utf8").digest("hex");

    await expect(port.hash("metadata.json")).resolves.toBe(expectedHash);
    await expect(port.hash("metadata.json")).resolves.toBe(expectedHash);
  });

  it("rejects non-UTF-8 metadata instead of replacing invalid bytes", async () => {
    const root = await createRoot();
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
    const port = createLocalInventoryPort(root);

    await expect(port.readText("invalid.txt")).rejects.toMatchObject({
      operation: "readText",
      path: "invalid.txt",
      code: "invalid-utf8",
    });
  });

  it("classifies an unsupported FIFO as other and never reads it as file content", async () => {
    const root = await createRoot();
    await createFifo(join(root, "observed.pipe"));
    const port = createLocalInventoryPort(root);

    await expect(port.lstat("observed.pipe")).resolves.toMatchObject({
      type: "other",
    });
    await expect(port.listDirectory("")).resolves.toContainEqual({
      name: "observed.pipe",
      type: "other",
    });
    await expect(port.readText("observed.pipe")).rejects.toMatchObject({
      operation: "readText",
      path: "observed.pipe",
      code: "unsupported",
    });
    await expect(port.hash("observed.pipe")).rejects.toMatchObject({
      operation: "hash",
      path: "observed.pipe",
      code: "unsupported",
    });
  });

  it("enforces entry-count, path-depth, and hash-size limits", async () => {
    const root = await createRoot();
    await mkdir(join(root, "nested", "deeper"), { recursive: true });
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    await writeFile(join(root, "c.txt"), "c");
    await writeFile(join(root, "large.txt"), "12345");
    const port = createLocalInventoryPort(root, {
      maxEntries: 2,
      maxDepth: 1,
      maxFileBytes: 4,
    });

    await expect(port.listDirectory("")).rejects.toMatchObject({
      operation: "listDirectory",
      code: "too-many-entries",
    });
    await expect(port.listDirectory("nested/deeper")).rejects.toMatchObject({
      operation: "listDirectory",
      code: "too-deep",
    });
    await expect(port.hash("large.txt")).rejects.toMatchObject({
      operation: "hash",
      code: "oversized",
    });
  });

  it("observes without changing sentinel content or directory metadata and has no write or process surface", async () => {
    const root = await createRoot();
    await mkdir(join(root, "directory"));
    await writeFile(join(root, "sentinel.txt"), "do not mutate");
    await symlink(join(root, "sentinel.txt"), join(root, "sentinel-link"));
    const port = createLocalInventoryPort(root);
    const beforeDirectory = await stat(root);
    const beforeHash = await port.hash("sentinel.txt");

    await port.listDirectory("");
    await port.lstat("sentinel-link");
    await port.readlink("sentinel-link");
    await port.realpathEvidence("sentinel-link");
    await expect(port.readText("sentinel.txt")).resolves.toBe("do not mutate");
    await port.hash("sentinel.txt");

    const afterDirectory = await stat(root);
    expect(await port.hash("sentinel.txt")).toBe(beforeHash);
    expect({
      mode: afterDirectory.mode,
      size: afterDirectory.size,
      mtimeMs: afterDirectory.mtimeMs,
      ctimeMs: afterDirectory.ctimeMs,
    }).toEqual({
      mode: beforeDirectory.mode,
      size: beforeDirectory.size,
      mtimeMs: beforeDirectory.mtimeMs,
      ctimeMs: beforeDirectory.ctimeMs,
    });
    expect(Object.keys(port).sort()).toEqual([
      "hash",
      "listDirectory",
      "lstat",
      "readBytes",
      "readText",
      "readlink",
      "realpathEvidence",
    ]);
    expect(port).not.toHaveProperty("write");
    expect(port).not.toHaveProperty("apply");
    expect(port).not.toHaveProperty("exec");
    expect(port).not.toHaveProperty("spawn");
  });
});
