import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSkillOperationJournal } from "../../src/main/skill-management/journal";

const roots: string[] = [];

async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-skill-journal-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("skill operation journal", () => {
  it("persists prepared recovery references before an effect can start", async () => {
    const root = await setup();
    const journal = createSkillOperationJournal(join(root, "omni", "skill-operations"));
    const record = {
      version: 1 as const,
      intentId: "intent-a",
      actor: { kind: "desktop" as const },
      intent: { kind: "remove" as const, bindingIds: ["binding-a"] },
      status: "prepared" as const,
      effectFingerprint: "a".repeat(64),
      backupReferences: [{ rootId: "project:project-a", path: "backups/intent-a/project-a" }],
      steps: [],
      createdAt: "2026-10-07T10:00:00.000Z",
      updatedAt: "2026-10-07T10:00:00.000Z",
    };

    await journal.write(record);
    const restored = await journal.read(record.intentId);
    const file = await stat(join(root, "omni", "skill-operations", "intent-a.json"));

    expect(restored).toEqual({ status: "ready", record });
    expect(file.mode & 0o777).toBe(0o600);
  });

  it("marks interrupted applying records recovery-required without replaying them", async () => {
    const root = await setup();
    const directory = join(root, "omni", "skill-operations");
    const journal = createSkillOperationJournal(directory);
    const interrupted = {
      version: 1 as const,
      intentId: "intent-b",
      actor: { kind: "mcp" as const, requestId: "request-b" },
      intent: {
        kind: "write" as const,
        request: {
          kind: "write-skill" as const,
          sourceId: "source-a",
          packageId: "packages/tools",
          mode: "create" as const,
          folderName: "draft",
          files: [{ path: "SKILL.md", content: "# Draft\n" }],
        },
      },
      status: "applying" as const,
      effectFingerprint: "b".repeat(64),
      backupReferences: [{ rootId: "source:source-a", path: "backups/intent-b/source-a" }],
      steps: [{ stepId: "source", status: "applying" as const }],
      createdAt: "2026-10-07T10:00:00.000Z",
      updatedAt: "2026-10-07T10:00:01.000Z",
    };
    await journal.write(interrupted);
    const reopened = createSkillOperationJournal(directory);

    await expect(reopened.recoverInterrupted()).resolves.toEqual([
      expect.objectContaining({ intentId: "intent-b", status: "recovery-required" }),
    ]);
    await expect(reopened.read("intent-b")).resolves.toMatchObject({
      status: "ready",
      record: { status: "recovery-required" },
    });
  });

  it("keeps corrupt records unavailable instead of replacing them", async () => {
    const root = await setup();
    const directory = join(root, "omni", "skill-operations");
    const journal = createSkillOperationJournal(directory);
    await journal.write({
      version: 1,
      intentId: "intent-c",
      actor: { kind: "desktop" },
      intent: { kind: "remove", bindingIds: ["binding-c"] },
      status: "prepared",
      effectFingerprint: "c".repeat(64),
      backupReferences: [],
      steps: [],
      createdAt: "2026-10-07T10:00:00.000Z",
      updatedAt: "2026-10-07T10:00:00.000Z",
    });
    const path = join(directory, "intent-c.json");
    await chmod(path, 0o600);
    await writeFile(path, "{broken", "utf8");

    await expect(journal.read("intent-c")).resolves.toMatchObject({ status: "corrupt" });
    await expect(readFile(path, "utf8")).resolves.toBe("{broken");
  });
});
