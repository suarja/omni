import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OperationReceipt } from "../../src/shared/operations-ipc";
import { createOperationStore } from "../../src/main/operation-store";
import { hashContent } from "../../src/main/marketplace-manifests";
import { createReceiptDiffOperations } from "../../src/main/operations-receipt-diff";

const roots: string[] = [];

async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `omni-${prefix}-`));
  roots.push(path);
  return path;
}

function receipt(rootName: string, addedHash = "c".repeat(64)): OperationReceipt {
  return {
    operationId: "import-one",
    kind: "import-artifact",
    status: "applied",
    appliedAt: "2026-09-14T09:41:00.000Z",
    displayTarget: "packages/demo",
    actions: [
      { kind: "write-file", relativePath: "packages/demo/SKILL.md", status: "applied", beforeHash: "a".repeat(64) },
      { kind: "write-file", relativePath: "packages/demo/NEW.md", status: "applied" },
    ],
    git: { mode: "commit", commit: "d".repeat(40) },
    registered: { sourceId: "personal" },
    files: [
      { relativePath: "packages/demo/SKILL.md", contentHash: "b".repeat(64) },
      { relativePath: "packages/demo/NEW.md", contentHash: addedHash },
    ],
    source: { kind: "source", id: rootName, relativePath: "skills/demo" },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("receipt diff operations", () => {
  it("diffs a modified file against the real import backup", async () => {
    const userDataPath = await root("receipt-diff-data");
    const marketplace = await root("receipt-diff-marketplace");
    await mkdir(join(userDataPath, "omni", "backups", "import-one", "packages", "demo"), { recursive: true });
    await mkdir(join(marketplace, "packages", "demo"), { recursive: true });
    await writeFile(join(userDataPath, "omni", "backups", "import-one", "packages", "demo", "SKILL.md"), "before\n");
    await writeFile(join(marketplace, "packages", "demo", "SKILL.md"), "after\n");
    await writeFile(
      join(userDataPath, "omni", "project-source-registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        projects: [],
        sources: [
          {
            id: "personal",
            displayName: "Personal",
            ownership: "personal",
            createdAt: "2026-09-14T00:00:00.000Z",
            locator: { kind: "local-directory", canonicalPath: marketplace },
          },
        ],
      }),
    );
    const operationStore = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const saved = await operationStore.append(receipt("source-one"));
    expect(saved.status).toBe("ready");
    const operations = createReceiptDiffOperations({ userDataPath, operationStore });

    await expect(
      operations.get({ operationId: "import-one", relativePath: "packages/demo/SKILL.md" }),
    ).resolves.toMatchObject({
      status: "ready",
      before: { byteLength: 7 },
      after: { byteLength: 6, changedSince: true },
      diff: { text: expect.stringContaining("-before") },
    });
  });

  it("shows an added file and rejects paths absent from the receipt", async () => {
    const userDataPath = await root("receipt-diff-added-data");
    const marketplace = await root("receipt-diff-added-marketplace");
    await mkdir(join(userDataPath, "omni", "backups", "import-one", "packages", "demo"), { recursive: true });
    await mkdir(join(marketplace, "packages", "demo"), { recursive: true });
    await writeFile(join(marketplace, "packages", "demo", "NEW.md"), "new\n");
    await writeFile(
      join(userDataPath, "omni", "project-source-registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        projects: [],
        sources: [
          {
            id: "personal",
            displayName: "Personal",
            ownership: "personal",
            createdAt: "2026-09-14T00:00:00.000Z",
            locator: { kind: "local-directory", canonicalPath: marketplace },
          },
        ],
      }),
    );
    const operationStore = createOperationStore(join(userDataPath, "omni", "operations.json"));
    await operationStore.append(receipt("source-one", hashContent("new\n")));
    const operations = createReceiptDiffOperations({ userDataPath, operationStore });

    await expect(
      operations.get({ operationId: "import-one", relativePath: "packages/demo/NEW.md" }),
    ).resolves.toMatchObject({
      status: "ready",
      before: { byteLength: 0 },
      after: { byteLength: 4, changedSince: false },
      diff: { text: expect.stringContaining("+new") },
    });
    await expect(operations.get({ operationId: "import-one", relativePath: "not-in-receipt.md" })).rejects.toThrow(
      "Receipt path is not part of the operation",
    );
    expect(await readFile(join(marketplace, "packages", "demo", "NEW.md"), "utf8")).toBe("new\n");
  });

  it("shows removed project files from the operation backup", async () => {
    const userDataPath = await root("receipt-remove-data");
    const projectRoot = await root("receipt-remove-project");
    const relativePath = ".claude/skills/demo/notes.md";
    const before = "managed support file\n";
    await mkdir(join(userDataPath, "omni", "backups", "remove-one", "project-one", ".claude/skills/demo"), {
      recursive: true,
    });
    await writeFile(join(userDataPath, "omni", "backups", "remove-one", "project-one", relativePath), before);
    await writeFile(
      join(userDataPath, "omni", "project-source-registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        projects: [
          {
            id: "project-one",
            displayName: "Project One",
            createdAt: "2026-09-14T00:00:00.000Z",
            locator: { kind: "local-directory", canonicalPath: projectRoot },
          },
        ],
        sources: [],
      }),
    );
    const operationStore = createOperationStore(join(userDataPath, "omni", "operations.json"));
    await operationStore.append({
      operationId: "remove-one",
      kind: "remove-binding",
      status: "applied",
      appliedAt: "2026-09-14T09:41:00.000Z",
      displayTarget: "Project One",
      actions: [{ kind: "delete-file", relativePath, status: "applied" }],
      git: { mode: "disabled" },
      registered: null,
      project: { id: "project-one" },
      files: [{ relativePath, contentHash: hashContent(before) }],
    });
    const operations = createReceiptDiffOperations({ userDataPath, operationStore });

    await expect(operations.get({ operationId: "remove-one", relativePath })).resolves.toMatchObject({
      status: "ready",
      before: { byteLength: before.length },
      diff: { text: expect.stringContaining("-managed support file") },
    });
  });
});
