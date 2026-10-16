import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCompatibleOperations } from "../../src/main/operations-compatible";
import { createOperationStore } from "../../src/main/operation-store";
import { createRestoreOperations } from "../../src/main/operations-restore";
import type { GitCli } from "../../src/main/git-cli";
import { parsePreviewMarketplaceResponse } from "../../src/shared/operations-ipc";

const roots: string[] = [];

async function setup(): Promise<{ userDataPath: string; marketplace: string }> {
  const userDataPath = await mkdtemp(join(tmpdir(), "omni-compatible-data-"));
  const marketplace = await mkdtemp(join(tmpdir(), "omni-compatible-marketplace-"));
  roots.push(userDataPath, marketplace);
  await cp(join(import.meta.dirname, "../fixtures/make-compatible/claude-only"), marketplace, { recursive: true });
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
  return { userDataPath, marketplace };
}

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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("make-compatible operation", () => {
  it("previews and applies deterministic Codex projections for a Claude-only marketplace", async () => {
    const fixture = await setup();
    const operations = createCompatibleOperations(
      { get: vi.fn(), issue: vi.fn() },
      {
        userDataPath: fixture.userDataPath,
        operationStore: createOperationStore(join(fixture.userDataPath, "omni", "operations.json")),
        git,
      },
    );

    const preview = await operations.preview({
      kind: "make-compatible",
      sourceId: "personal-source",
      harness: "codex",
    });
    expect(preview).toMatchObject({
      status: "ready",
      plan: { kind: "make-compatible", report: { harness: "codex" } },
    });
    if (preview.status !== "ready") throw new Error("Expected a ready preview.");
    expect(preview.plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: ".agents/plugins/marketplace.json" }),
        expect.objectContaining({ relativePath: "packages/skills-only/.codex-plugin/plugin.json" }),
      ]),
    );

    const result = await operations.apply({ planId: preview.plan.planId });
    expect(result).toMatchObject({ status: "applied", receipt: { kind: "make-compatible" } });
    const codexMarketplace = JSON.parse(
      await readFile(join(fixture.marketplace, ".agents/plugins/marketplace.json"), "utf8"),
    ) as { plugins: unknown[] };
    expect(codexMarketplace.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "remote",
          source: expect.objectContaining({ source: "url", url: "https://github.com/owner/remote.git" }),
        }),
      ]),
    );
    expect(git.commitAll).toHaveBeenCalledWith(
      expect.stringContaining("omni-compatible-marketplace-"),
      expect.stringContaining("Make Claude Only compatible with Codex"),
      expect.arrayContaining([".agents/plugins/marketplace.json"]),
    );

    const second = await operations.preview({ kind: "make-compatible", sourceId: "personal-source", harness: "codex" });
    expect(second).toMatchObject({
      status: "ready",
      plan: {
        actions: [],
        report: {
          packages: expect.arrayContaining([
            expect.objectContaining({ packageId: "packages/skills-only", alreadyCompatible: true }),
          ]),
        },
      },
    });

    if (!result || result.status !== "applied") throw new Error("Expected an applied receipt.");
    const restore = createRestoreOperations({
      userDataPath: fixture.userDataPath,
      operationStore: createOperationStore(join(fixture.userDataPath, "omni", "operations.json")),
      git,
    });
    const restorePreview = await restore.preview({ kind: "restore-import", operationId: result.receipt.operationId });
    expect(restorePreview).toMatchObject({ status: "ready" });
    if (restorePreview.status !== "ready") throw new Error("Expected a ready restore preview.");
    await expect(restore.apply({ planId: restorePreview.plan.planId })).resolves.toMatchObject({ status: "applied" });
    await expect(readFile(join(fixture.marketplace, "omni.marketplace.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(fixture.marketplace, ".agents/plugins/marketplace.json"), "utf8")).rejects.toThrow();
    // Nothing left behind: the directories the operation created are gone too.
    await expect(stat(join(fixture.marketplace, ".agents"))).rejects.toThrow();
    await expect(stat(join(fixture.marketplace, "packages/skills-only/.codex-plugin"))).rejects.toThrow();
  });

  it("updates a projected manifest only when kept, preserves unknown fields, and restores it", async () => {
    const fixture = await setup();
    const store = createOperationStore(join(fixture.userDataPath, "omni", "operations.json"));
    const operations = createCompatibleOperations(
      { get: vi.fn(), issue: vi.fn() },
      {
        userDataPath: fixture.userDataPath,
        operationStore: store,
        git,
      },
    );
    const first = await operations.preview({ kind: "make-compatible", sourceId: "personal-source", harness: "codex" });
    if (first.status !== "ready") throw new Error("Expected a ready preview.");
    const applied = await operations.apply({ planId: first.plan.planId });
    if (!applied || applied.status !== "applied") throw new Error("Expected an applied operation.");
    const pluginPath = join(fixture.marketplace, "packages/skills-only/.codex-plugin/plugin.json");
    await writeFile(
      pluginPath,
      JSON.stringify(
        {
          interface: { displayName: "Keep me" },
          name: "skills-only",
          version: "2.0.0",
          description: "Portable skills",
          skills: "./skills/",
          keywords: ["pstack"],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const unchecked = await operations.preview({
      kind: "make-compatible",
      sourceId: "personal-source",
      harness: "codex",
    });
    expect(unchecked).toMatchObject({
      status: "ready",
      plan: {
        actions: [
          expect.objectContaining({
            relativePath: "packages/skills-only/.codex-plugin/plugin.json",
            diff: expect.stringContaining("---"),
          }),
        ],
      },
    });
    if (unchecked.status !== "ready") throw new Error("Expected an unchecked update preview.");
    await expect(operations.apply({ planId: unchecked.plan.planId })).resolves.toMatchObject({ status: "applied" });
    expect(JSON.parse(await readFile(pluginPath, "utf8"))).toMatchObject({ version: "2.0.0" });

    const update = await operations.preview({
      kind: "make-compatible",
      sourceId: "personal-source",
      harness: "codex",
      keepUpdates: ["packages/skills-only/.codex-plugin/plugin.json"],
    });
    expect(update).toMatchObject({
      status: "ready",
      plan: {
        actions: [
          expect.objectContaining({
            relativePath: "packages/skills-only/.codex-plugin/plugin.json",
            diff: expect.stringContaining("---"),
          }),
        ],
      },
    });
    expect(() => parsePreviewMarketplaceResponse(update)).not.toThrow();
    if (update.status !== "ready") throw new Error("Expected a ready update preview.");
    const updated = await operations.apply({ planId: update.plan.planId });
    expect(updated).toMatchObject({ status: "applied" });
    expect(JSON.parse(await readFile(pluginPath, "utf8"))).toMatchObject({
      interface: { displayName: "Keep me" },
      keywords: ["pstack"],
      version: "1.0.0",
    });

    const restore = createRestoreOperations({ userDataPath: fixture.userDataPath, operationStore: store, git });
    if (!updated || updated.status !== "applied") throw new Error("Expected a receipt for restore.");
    const restorePreview = await restore.preview({ kind: "restore-import", operationId: updated.receipt.operationId });
    expect(restorePreview).toMatchObject({ status: "ready" });
    if (restorePreview.status !== "ready") throw new Error("Expected a ready restore preview.");
    await expect(restore.apply({ planId: restorePreview.plan.planId })).resolves.toMatchObject({ status: "applied" });
    expect(JSON.parse(await readFile(pluginPath, "utf8"))).toMatchObject({ version: "2.0.0", keywords: ["pstack"] });
  });

  it("keeps hand-maintained marketplace entries and inline arrays untouched by a merge", async () => {
    const fixture = await setup();
    const store = createOperationStore(join(fixture.userDataPath, "omni", "operations.json"));
    const operations = createCompatibleOperations(
      { get: vi.fn(), issue: vi.fn() },
      {
        userDataPath: fixture.userDataPath,
        operationStore: store,
        git,
      },
    );
    const first = await operations.preview({ kind: "make-compatible", sourceId: "personal-source", harness: "codex" });
    if (first.status !== "ready") throw new Error("Expected a ready preview.");
    await operations.apply({ planId: first.plan.planId });
    // The user edits the Codex files by hand: a category of their own and a one-line keyword list.
    const marketplacePath = join(fixture.marketplace, ".agents/plugins/marketplace.json");
    const marketplace = JSON.parse(await readFile(marketplacePath, "utf8")) as { plugins: Record<string, unknown>[] };
    marketplace.plugins = marketplace.plugins.map((entry) => ({ ...entry, category: "Productivity" }));
    await writeFile(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n", "utf8");
    const pluginPath = join(fixture.marketplace, "packages/skills-only/.codex-plugin/plugin.json");
    const plugin = JSON.parse(await readFile(pluginPath, "utf8")) as Record<string, unknown>;
    const pluginText =
      JSON.stringify({ ...plugin, description: "edited by hand" }, null, 2).replace(
        /"skills": "\.\/skills\/"/u,
        '"keywords": ["writing", "editing"],\n  "skills": "./skills/"',
      ) + "\n";
    await writeFile(pluginPath, pluginText, "utf8");

    const second = await operations.preview({
      kind: "make-compatible",
      sourceId: "personal-source",
      harness: "codex",
      keepUpdates: [pluginPath.slice(fixture.marketplace.length + 1)],
    });
    if (second.status !== "ready") throw new Error("Expected a ready preview.");
    // The marketplace entries differ only in fields Omni does not own: no update row for that file.
    expect(second.plan.actions.map((action) => action.relativePath)).not.toContain(".agents/plugins/marketplace.json");
    const pluginAction = second.plan.actions.find((action) =>
      action.relativePath.endsWith(".codex-plugin/plugin.json"),
    );
    expect(pluginAction?.diff).toContain("edited by hand");
    expect(pluginAction?.diff).not.toContain('"writing",\n');
    await operations.apply({ planId: second.plan.planId });
    expect(await readFile(pluginPath, "utf8")).toContain('"keywords": ["writing", "editing"]');
    expect(
      JSON.parse(await readFile(marketplacePath, "utf8")).plugins.every(
        (entry: Record<string, unknown>) => entry.category === "Productivity",
      ),
    ).toBe(true);
  });
});
