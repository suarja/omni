import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOperationStore } from "../../src/main/operation-store";
import { createRestoreOperations } from "../../src/main/operations-restore";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
import { createMainSkillManagementService } from "../../src/main/skill-management/service";
import { createWriteSkillOperations } from "../../src/main/operations-write-skill";
import type { GitCli } from "../../src/main/git-cli";

const roots: string[] = [];
const git: GitCli = {
  remoteUrl: async () => undefined,
  push: async () => {
    throw new Error("Unexpected push in this test.");
  },
  isGitAvailable: vi.fn(async () => true),
  enclosingRepository: vi.fn(),
  initAndCommit: vi.fn(),
  isRepositoryRoot: vi.fn(async () => true),
  commitAll: vi.fn(async () => ({ status: "committed" as const, commit: "a".repeat(40) })),
  hasChanges: vi.fn(async () => true),
  headCommit: vi.fn(async () => "b".repeat(40)),
};

async function setup(): Promise<{ userDataPath: string; marketplace: string; storePath: string }> {
  const userDataPath = await mkdtemp(join(tmpdir(), "omni-write-skill-data-"));
  const marketplace = await mkdtemp(join(tmpdir(), "omni-write-skill-marketplace-"));
  roots.push(userDataPath, marketplace);
  await cp(join(import.meta.dirname, "../fixtures/make-compatible/claude-only"), marketplace, { recursive: true });
  await mkdir(join(marketplace, "packages/skills-only/.codex-plugin"), { recursive: true });
  await writeFile(
    join(marketplace, "packages/skills-only/.codex-plugin/plugin.json"),
    JSON.stringify({ name: "skills-only", version: "1.0.0", description: "Portable skills" }, null, 2) + "\n",
    "utf8",
  );
  await mkdir(join(userDataPath, "omni"), { recursive: true });
  await writeFile(
    join(userDataPath, "omni", "project-source-registry.json"),
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      projects: [],
      sources: [
        {
          id: "personal-source",
          displayName: "Claude Only",
          locator: { kind: "local-directory", canonicalPath: marketplace },
          ownership: "personal",
          createdAt: "2026-09-14T00:00:00.000Z",
        },
      ],
    }),
    "utf8",
  );
  return { userDataPath, marketplace, storePath: join(userDataPath, "omni", "operations.json") };
}

const files = [
  {
    path: "SKILL.md",
    content: `---\nname: lesson-capture\ndescription: Use when recording a durable lesson from an agent session.\n---\n\n# Lesson capture\n\nRead \`references/format.md\`.\n`,
  },
  { path: "references/format.md", content: "# Format\n" },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

describe("write-skill operation", () => {
  it("journals source creation and restores it through the same management service", async () => {
    const fixture = await setup();
    const store = createOperationStore(fixture.storePath);
    const writeSkill = createWriteSkillOperations({ userDataPath: fixture.userDataPath, operationStore: store, git });
    const restore = createRestoreOperations({ userDataPath: fixture.userDataPath, operationStore: store, git });
    const service = createMainSkillManagementService({
      writeSkill,
      restore,
      operationStore: store,
      journal: createSkillOperationJournal(join(fixture.userDataPath, "omni", "skill-operations")),
    });
    await service.initialize();
    const preview = await service.preview(
      {
        kind: "write",
        request: {
          kind: "write-skill",
          sourceId: "personal-source",
          packageId: "packages/skills-only",
          mode: "create",
          folderName: "lesson-capture",
          files,
        },
      },
      { kind: "desktop" },
    );
    if (preview.status !== "ready") throw new Error("Expected a ready source preview.");
    const result = await service.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: "2026-10-07T10:00:00.000Z",
    });
    expect(result).toMatchObject({ status: "applied", source: { status: "created", sourceId: "personal-source" } });
    expect(
      await readFile(
        join(fixture.marketplace, "packages/skills-only/skills/lesson-capture/references/format.md"),
        "utf8",
      ),
    ).toBe(files[1]!.content);

    const restorePreview = await service.preview(
      { kind: "restore", operationId: result.operationId },
      { kind: "desktop" },
    );
    if (restorePreview.status !== "ready") throw new Error("Expected a ready source restore preview.");
    const restoredFiles = restorePreview.steps.flatMap((step) => step.files);
    expect.soft(new Set(restoredFiles.map((file) => file.relativePath)).size).toBe(restoredFiles.length);
    const skillDiff = restoredFiles.find((file) => file.relativePath.endsWith("/SKILL.md"))?.diff;
    expect.soft(skillDiff).toContain("-# Lesson capture");
    expect.soft(skillDiff).not.toContain("+# Lesson capture");
    expect(restoredFiles.find((file) => file.relativePath.endsWith("/format.md"))?.diff).toContain("-# Format");
    expect(restoredFiles.find((file) => file.relativePath === "omni.marketplace.json")?.diff).toContain(
      '-  "format": "omni.marketplace/1"',
    );
    expect(restoredFiles.find((file) => file.relativePath.endsWith("/.codex-plugin/plugin.json"))?.diff).toContain(
      '-  "skills": "./skills/"',
    );
    await expect(
      service.apply(restorePreview.intentId, {
        kind: "desktop",
        effectFingerprint: restorePreview.effectFingerprint,
        approvedAt: "2026-10-07T10:01:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "restored", source: { status: "restored" } });
    await expect(stat(join(fixture.marketplace, "packages/skills-only/skills/lesson-capture"))).rejects.toThrow();
  });

  it("creates a skill, births Omni manifests, adds Codex skills, commits pathspecs, and restores cleanly", async () => {
    const fixture = await setup();
    const store = createOperationStore(fixture.storePath);
    const operations = createWriteSkillOperations({ userDataPath: fixture.userDataPath, operationStore: store, git });
    const preview = await operations.preview({
      kind: "write-skill",
      sourceId: "personal-source",
      packageId: "packages/skills-only",
      mode: "create",
      folderName: "lesson-capture",
      files,
      agent: { harness: "claude-code", sessionName: "session-one", requestedAt: "2026-09-14T00:00:00.000Z" },
      reason: "Capture the lesson.",
    });
    expect(preview).toMatchObject({ status: "ready", plan: { kind: "write-skill" } });
    if (preview.status !== "ready") throw new Error("Expected a ready preview.");
    expect(preview.plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "packages/skills-only/skills/lesson-capture/SKILL.md",
          diff: expect.stringContaining("+# Lesson capture"),
        }),
        expect.objectContaining({
          relativePath: "packages/skills-only/skills/lesson-capture/references/format.md",
          diff: expect.stringContaining("+# Format"),
        }),
        expect.objectContaining({ relativePath: "packages/skills-only/omni.plugin.json", manifest: true }),
        expect.objectContaining({
          relativePath: "omni.marketplace.json",
          manifest: true,
          diff: expect.stringContaining("omni.marketplace/1"),
        }),
        expect.objectContaining({
          relativePath: "packages/skills-only/.codex-plugin/plugin.json",
          diff: expect.any(String),
        }),
      ]),
    );
    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied).toMatchObject({ status: "applied", receipt: { kind: "write-skill" } });
    expect(
      await readFile(join(fixture.marketplace, "packages/skills-only/skills/lesson-capture/SKILL.md"), "utf8"),
    ).toBe(files[0]!.content);
    expect(
      JSON.parse(await readFile(join(fixture.marketplace, "packages/skills-only/.codex-plugin/plugin.json"), "utf8")),
    ).toMatchObject({
      skills: "./skills/",
    });
    expect(git.commitAll).toHaveBeenCalledWith(
      expect.stringContaining("omni-write-skill-marketplace-"),
      "Add skill lesson-capture to skills-only via Claude Code",
      expect.arrayContaining(["packages/skills-only/skills/lesson-capture/SKILL.md"]),
    );
    if (!applied || applied.status !== "applied") throw new Error("Expected an applied receipt.");
    const restore = createRestoreOperations({ userDataPath: fixture.userDataPath, operationStore: store, git });
    const restorePreview = await restore.preview({ kind: "restore-import", operationId: applied.receipt.operationId });
    expect(restorePreview).toMatchObject({ status: "ready" });
    if (restorePreview.status !== "ready") throw new Error("Expected a restore preview.");
    const restored = await restore.apply({ planId: restorePreview.plan.planId });
    if (restored?.status === "failed") throw new Error(restored.receipt.diagnostic);
    expect(restored).toMatchObject({ status: "applied" });
    await expect(stat(join(fixture.marketplace, "packages/skills-only/skills/lesson-capture"))).rejects.toThrow();
    await expect(stat(join(fixture.marketplace, "packages/skills-only/omni.plugin.json"))).rejects.toThrow();
    await expect(stat(join(fixture.marketplace, "omni.marketplace.json"))).rejects.toThrow();
    expect(
      JSON.parse(await readFile(join(fixture.marketplace, "packages/skills-only/.codex-plugin/plugin.json"), "utf8")),
    ).not.toHaveProperty("skills");
  });

  it("previews an update and restores omitted files even after their directories were removed", async () => {
    const fixture = await setup();
    const store = createOperationStore(fixture.storePath);
    const operations = createWriteSkillOperations({ userDataPath: fixture.userDataPath, operationStore: store, git });
    const first = await operations.preview({
      kind: "write-skill",
      sourceId: "personal-source",
      packageId: "packages/skills-only",
      mode: "create",
      folderName: "lesson-capture",
      files,
    });
    if (first.status !== "ready") throw new Error("Expected a ready create preview.");
    await operations.apply({ planId: first.plan.planId });
    const updatedFiles = [
      {
        ...files[0]!,
        content: files[0]!.content
          .replace("Read `references/format.md`.", "The format is now updated.")
          .replace("Lesson capture", "Updated lesson capture"),
      },
    ];
    const update = await operations.preview({
      kind: "write-skill",
      sourceId: "personal-source",
      packageId: "packages/skills-only",
      mode: "update",
      folderName: "lesson-capture",
      files: updatedFiles,
      replaceFolder: true,
    });
    expect(update).toMatchObject({ status: "ready" });
    if (update.status !== "ready") throw new Error("Expected a ready update preview.");
    expect(update.plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "write-file",
          relativePath: "packages/skills-only/skills/lesson-capture/SKILL.md",
          diff: expect.stringContaining("@@"),
        }),
        expect.objectContaining({
          kind: "delete-file",
          relativePath: "packages/skills-only/skills/lesson-capture/references/format.md",
        }),
      ]),
    );
    const applied = await operations.apply({ planId: update.plan.planId });
    expect(applied).toMatchObject({ status: "applied" });
    await expect(
      stat(join(fixture.marketplace, "packages/skills-only/skills/lesson-capture/references/format.md")),
    ).rejects.toThrow();
    if (!applied || applied.status !== "applied") throw new Error("Expected an applied update receipt.");
    const restore = createRestoreOperations({ userDataPath: fixture.userDataPath, operationStore: store, git });
    const restorePreview = await restore.preview({ kind: "restore-import", operationId: applied.receipt.operationId });
    if (restorePreview.status !== "ready") throw new Error("Expected a ready update restore preview.");
    const skillDiff = restorePreview.plan.actions.find((action) => action.relativePath.endsWith("/SKILL.md"))?.diff;
    expect(skillDiff).toContain("-# Updated lesson capture");
    expect(skillDiff).toContain("+# Lesson capture");
    expect(restorePreview.plan.actions.find((action) => action.relativePath.endsWith("/format.md"))?.diff).toContain(
      "+# Format",
    );
    const restored = await restore.apply({ planId: restorePreview.plan.planId });
    if (restored?.status === "failed") throw new Error(restored.receipt.diagnostic);
    expect(restored).toMatchObject({ status: "applied" });
    expect(
      await readFile(join(fixture.marketplace, "packages/skills-only/skills/lesson-capture/SKILL.md"), "utf8"),
    ).toBe(files[0]!.content);
    expect(
      await readFile(
        join(fixture.marketplace, "packages/skills-only/skills/lesson-capture/references/format.md"),
        "utf8",
      ),
    ).toBe(files[1]!.content);
  });

  it("writes binary source files and preserves unchanged binary files during text deltas", async () => {
    const fixture = await setup();
    const store = createOperationStore(fixture.storePath);
    const operations = createWriteSkillOperations({ userDataPath: fixture.userDataPath, operationStore: store, git });
    const binary = Buffer.from([0, 255, 17, 128]);
    const created = await operations.preview({
      kind: "write-skill",
      sourceId: "personal-source",
      packageId: "packages/skills-only",
      mode: "create",
      folderName: "lesson-capture",
      files: [...files, { path: "assets/icon.bin", content: binary.toString("base64"), encoding: "base64" }],
    });
    if (created.status !== "ready") throw new Error("Expected a ready binary source preview.");
    const createdResult = await operations.apply({ planId: created.plan.planId });
    expect(createdResult).toMatchObject({ status: "applied" });
    const binaryPath = join(fixture.marketplace, "packages/skills-only/skills/lesson-capture/assets/icon.bin");
    expect(await readFile(binaryPath)).toEqual(binary);

    const updated = await operations.preview({
      kind: "write-skill",
      sourceId: "personal-source",
      packageId: "packages/skills-only",
      mode: "update",
      folderName: "lesson-capture",
      files: [{ ...files[0]!, content: files[0]!.content.replace("# Lesson capture", "# Revised lesson capture") }],
    });
    if (updated.status !== "ready") throw new Error("Expected a ready text delta preview.");
    expect(updated.plan.actions.some((action) => action.relativePath.endsWith("assets/icon.bin"))).toBe(false);
    const updatedResult = await operations.apply({ planId: updated.plan.planId });
    expect(updatedResult).toMatchObject({ status: "applied" });
    expect(await readFile(binaryPath)).toEqual(binary);
  });

  it("blocks invalid content with findings in the plan, duplicate names, and unsafe paths", async () => {
    const fixture = await setup();
    const operations = createWriteSkillOperations({
      userDataPath: fixture.userDataPath,
      operationStore: createOperationStore(fixture.storePath),
      git,
    });
    const invalid = await operations.preview({
      kind: "write-skill",
      sourceId: "personal-source",
      packageId: "packages/skills-only",
      mode: "create",
      folderName: "bad-skill",
      files: [{ path: "SKILL.md", content: "TODO" }],
    });
    expect(invalid).toMatchObject({
      status: "blocked",
      plan: { findings: expect.arrayContaining([expect.objectContaining({ severity: "error" })]) },
    });
    const duplicate = await operations.preview({
      kind: "write-skill",
      sourceId: "personal-source",
      packageId: "packages/skills-only",
      mode: "create",
      folderName: "review",
      files: [{ path: "SKILL.md", content: "---\nname: review\ndescription: Use when reviewing.\n---\n" }],
    });
    expect(duplicate).toMatchObject({
      status: "blocked",
      plan: { findings: expect.arrayContaining([expect.objectContaining({ code: "duplicate-skill-name" })]) },
    });
    await expect(
      operations.preview({
        kind: "write-skill",
        sourceId: "personal-source",
        packageId: "packages/skills-only",
        mode: "create",
        folderName: "bad-skill",
        files: [{ path: "../escape.md", content: "bad" }],
      }),
    ).rejects.toThrow();
  });

  it("blocks writes to a registered external source before creating any target files", async () => {
    const fixture = await setup();
    const registryPath = join(fixture.userDataPath, "omni", "project-source-registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      sources: Array<{ ownership: string }>;
    };
    registry.sources[0]!.ownership = "external";
    await writeFile(registryPath, JSON.stringify(registry), "utf8");

    const operations = createWriteSkillOperations({
      userDataPath: fixture.userDataPath,
      operationStore: createOperationStore(fixture.storePath),
      git,
    });
    const preview = await operations.preview({
      kind: "write-skill",
      sourceId: "personal-source",
      packageId: "packages/skills-only",
      mode: "create",
      folderName: "lesson-capture",
      files,
    });

    expect(preview).toMatchObject({ status: "blocked", reason: "source-missing" });
    await expect(stat(join(fixture.marketplace, "packages/skills-only/skills/lesson-capture"))).rejects.toThrow();
  });
});
