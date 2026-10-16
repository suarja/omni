import { stat, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { createOperationStore } from "../../src/main/operation-store";
import { createSettingsStore, settingsFilePath } from "../../src/main/settings-store";
import {
  createAddToProjectOperations,
  createCompositeRestoreOperations,
} from "../../src/main/operations-add-to-project";
import type { GitCli } from "../../src/main/git-cli";
import type { RegistryGrant, RegistryIpcServices } from "../../src/main/registry-ipc";
import type { OperationReceipt, OperationPlan } from "../../src/shared/operations-ipc";
import { parseOperationReceipt } from "../../src/shared/operations-receipt-parsers";

const roots: string[] = [];

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `omni-add-project-${prefix}-`));
  const canonical = await realpath(value);
  roots.push(canonical);
  return canonical;
}

async function fixture(): Promise<{
  userDataPath: string;
  marketplaceRoot: string;
  projectRoot: string;
  preparedRoot: string;
  grants: { get(handle: string): RegistryGrant | undefined; issue(): string };
  registry: RegistryIpcServices;
}> {
  const userDataPath = await root("data");
  const marketplaceRoot = await root("marketplace");
  const projectRoot = await root("project");
  const preparedRoot = await root("prepared");
  await mkdir(join(preparedRoot, "skills", "quality"), { recursive: true });
  await writeFile(join(preparedRoot, "skills", "quality", "SKILL.md"), "# Quality\n", "utf8");
  await mkdir(join(marketplaceRoot, "packages", "ui", "skills", "quality"), { recursive: true });
  await writeFile(join(marketplaceRoot, "packages", "ui", "skills", "quality", "SKILL.md"), "# Quality\n", "utf8");
  await mkdir(join(userDataPath, "omni"), { recursive: true });
  await writeFile(
    join(userDataPath, "omni", "project-source-registry.json"),
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      projects: [
        {
          id: "project-one",
          displayName: "Fixture Project",
          locator: { kind: "local-directory", canonicalPath: projectRoot },
          createdAt: "2026-09-14T00:00:00.000Z",
        },
      ],
      sources: [
        {
          id: "personal-source",
          displayName: "Personal",
          locator: { kind: "local-directory", canonicalPath: marketplaceRoot },
          ownership: "personal",
          createdAt: "2026-09-14T00:00:00.000Z",
        },
      ],
    }),
    "utf8",
  );
  const handles = new Map<string, RegistryGrant>();
  const grant = async (handle: string, subject: RegistryGrant["subject"], rootPath: string): Promise<void> => {
    const details = await stat(rootPath);
    handles.set(handle, {
      handle,
      subject,
      root: rootPath,
      device: String(details.dev),
      inode: String(details.ino),
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
  };
  await grant("project-grant", { kind: "project", id: "project-one" }, projectRoot);
  await grant("personal-grant", { kind: "source", id: "personal-source" }, marketplaceRoot);
  await grant("catalogue-grant", { kind: "source", id: "catalogue-anthropics/skills-quality" }, preparedRoot);
  return {
    userDataPath,
    marketplaceRoot,
    projectRoot,
    preparedRoot,
    grants: { get: (handle) => handles.get(handle), issue: () => "unused" },
    registry: {
      ...({ get: (handle: string) => handles.get(handle), issue: () => "unused" } as unknown as RegistryIpcServices),
      getGrantForEntry: vi.fn(async () => "personal-grant"),
    },
  };
}

const git: GitCli = {
  remoteUrl: async () => undefined,
  push: async () => {
    throw new Error("Unexpected push in this test.");
  },
  isGitAvailable: async () => false,
  enclosingRepository: async () => ({ status: "none" }),
  initAndCommit: async () => ({ status: "failed", diagnostic: "not used" }),
  commitAll: async () => ({ status: "failed", diagnostic: "not used" }),
  hasChanges: async () => false,
  isRepositoryRoot: async () => false,
  headCommit: async () => undefined,
};

function receipt(kind: OperationReceipt["kind"], operationId: string, projectId?: string): OperationReceipt {
  return {
    operationId,
    kind,
    status: "applied",
    appliedAt: "2026-09-14T00:00:00.000Z",
    displayTarget: projectId ? "Fixture Project" : "packages/ui",
    actions: [],
    git: { mode: "unavailable" },
    registered: projectId ? null : { sourceId: "personal-source" },
    ...(projectId ? { project: { id: projectId } } : {}),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("add-to-project composite operation", () => {
  it("previews import then assignment for the Claude-only fixture and applies in order", async () => {
    const fixtureData = await fixture();
    const events: string[] = [];
    const operationStore = createOperationStore(join(fixtureData.userDataPath, "omni", "operations.json"));
    const baseBindings = createBindingsStore(bindingsFilePath(fixtureData.userDataPath));
    const bindingsStore = {
      ...baseBindings,
      save: async (bindings: Parameters<typeof baseBindings.save>[0]) => {
        events.push("saveBindings");
        return baseBindings.save(bindings);
      },
    };
    const importPlan: OperationPlan = {
      planId: "import-plan",
      kind: "import-artifact",
      displayTarget: "packages/ui",
      actions: [],
      git: { mode: "unavailable", warnings: [] },
    };
    const importReceipt = receipt("import-artifact", "import-receipt");
    const importOperations = {
      preview: vi.fn(async () => ({ status: "ready" as const, plan: importPlan })),
      apply: vi.fn(async () => {
        events.push("import");
        await operationStore.append(importReceipt);
        return { status: "applied" as const, receipt: importReceipt };
      }),
    };
    const applyProject = vi.fn(async () => {
      events.push("apply-plan");
      const projectReceipt = receipt("apply-plan", "apply-receipt", "project-one");
      await operationStore.append(projectReceipt);
      return { status: "applied" as const, receipt: projectReceipt };
    });
    const operations = createAddToProjectOperations(fixtureData.grants, {
      userDataPath: fixtureData.userDataPath,
      operationStore,
      git,
      registry: fixtureData.registry,
      bindingsStore,
      settingsStore: createSettingsStore(settingsFilePath(fixtureData.userDataPath)),
      importOperations,
      applyProject,
      prepareCatalogue: async () => ({
        sourceId: "catalogue-anthropics/skills-quality",
        grantHandle: "catalogue-grant",
        root: fixtureData.preparedRoot,
        relativePath: "skills/quality/SKILL.md",
      }),
    });
    const request = {
      kind: "add-to-project" as const,
      entry: { ownerRepo: "anthropics/skills", skill: "quality" },
      projectId: "project-one",
      grantHandle: "project-grant",
      newPackageName: "UI",
      description: "Skills for designing user interfaces.",
      harnessIds: ["claude-code" as const],
    };
    const preview = await operations.preview(request);
    expect(preview).toMatchObject({
      status: "ready",
      plan: {
        kind: "add-to-project",
        displayTarget: "quality → ui → Fixture Project",
        steps: [{ kind: "import" }, { kind: "assign", plan: { status: "ready", actions: [{ state: "add" }] } }],
      },
    });
    const planId = (preview as { status: "ready"; plan: OperationPlan }).plan.planId;
    const applied = await operations.apply({ planId });
    expect(applied).toMatchObject({ status: "applied", receipt: { children: ["import-receipt", "apply-receipt"] } });
    expect(events).toEqual(["import", "saveBindings", "apply-plan"]);
  });

  it("restores composite children in reverse order", async () => {
    const parent = {
      ...receipt("add-to-project", "composite-receipt", "project-one"),
      children: ["import-receipt", "apply-receipt"],
    };
    const childImport = receipt("import-artifact", "import-receipt");
    const childApply = receipt("apply-plan", "apply-receipt", "project-one");
    const stored = [parent, childImport, childApply];
    const events: string[] = [];
    const marked: string[] = [];
    const applyRestore = {
      previewRestore: vi.fn(async (_raw: unknown) => ({
        status: "ready" as const,
        planId: "apply-restore-plan",
        project: { id: "project-one" },
        files: [{ relativePath: ".claude/skills/quality", action: "delete" as const }],
      })),
      runRestore: vi.fn(async (_raw: unknown) => ({
        status: "applied" as const,
        receipt: receipt("restore-apply", "apply-restore-receipt", "project-one"),
      })),
    };
    const operationStore = {
      read: async () => ({ status: "ready" as const, receipts: stored }),
      append: async (next: OperationReceipt) => {
        stored.unshift(next);
        return { status: "ready" as const, receipts: stored };
      },
      markRestored: async (operationId: string) => {
        marked.push(operationId);
        return { status: "ready" as const, receipts: stored };
      },
    };
    const restore = createCompositeRestoreOperations({
      operationStore: operationStore as never,
      previewChild: async (child) =>
        child.kind === "apply-plan"
          ? applyRestore.previewRestore({ operationId: child.operationId }).then((result) => ({
              status: "ready" as const,
              plan: {
                planId: result.planId,
                kind: "restore-apply" as const,
                displayTarget: child.displayTarget,
                actions: result.files.map((file) => ({
                  kind: file.action === "delete" ? ("delete-file" as const) : ("write-file" as const),
                  relativePath: file.relativePath,
                })),
                git: { mode: "unavailable" as const, warnings: [] },
              },
            }))
          : {
              status: "ready" as const,
              plan: {
                planId: `${child.operationId}-plan`,
                kind: "restore-import" as const,
                displayTarget: child.displayTarget,
                actions: [],
                git: { mode: "unavailable" as const, warnings: [] },
              },
            },
      applyChild: async (planId, kind) => {
        events.push(planId);
        return kind === "apply-plan"
          ? applyRestore.runRestore({ planId })
          : { status: "applied" as const, receipt: receipt("restore-import", `${planId}-receipt`) };
      },
    });
    const preview = await restore.preview({ kind: "restore-import", operationId: "composite-receipt" });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    await restore.apply({ planId: preview.plan.planId });
    expect(events).toEqual(["apply-restore-plan", "import-receipt-plan"]);
    expect(applyRestore.previewRestore).toHaveBeenCalledWith({ operationId: "apply-receipt" });
    expect(applyRestore.runRestore).toHaveBeenCalledWith({ planId: "apply-restore-plan" });
    expect(marked).toEqual(["composite-receipt"]);
    expect(stored[0]).toMatchObject({ kind: "restore-add-to-project", restores: "composite-receipt" });
    // The receipt must round-trip through the store's own reader (a plan-shaped `git` with
    // `warnings` once made the owner's whole store unreadable on the next launch).
    expect(() => parseOperationReceipt(stored[0])).not.toThrow();
    expect(stored[0]?.git).toEqual({ mode: "unavailable" });
  });

  it("names the blocked apply child and leaves the composite unrestorable", async () => {
    const parent = {
      ...receipt("add-to-project", "composite-receipt", "project-one"),
      children: ["import-receipt", "apply-receipt"],
    };
    const stored = [
      parent,
      receipt("import-artifact", "import-receipt"),
      receipt("apply-plan", "apply-receipt", "project-one"),
    ];
    const restore = createCompositeRestoreOperations({
      operationStore: {
        read: async () => ({ status: "ready" as const, receipts: stored }),
        append: async (next: OperationReceipt) => ({ status: "ready" as const, receipts: [next, ...stored] }),
        markRestored: async () => ({ status: "ready" as const, receipts: stored }),
      } as never,
      previewChild: async (child) =>
        child.kind === "apply-plan"
          ? { status: "blocked" as const, reason: "restore-drift", diagnostic: "Project changed." }
          : {
              status: "ready" as const,
              plan: {
                planId: "import-restore-plan",
                kind: "restore-import" as const,
                displayTarget: child.displayTarget,
                actions: [],
                git: { mode: "unavailable" as const, warnings: [] },
              },
            },
      applyChild: vi.fn(),
    });
    await expect(restore.preview({ kind: "restore-import", operationId: "composite-receipt" })).resolves.toMatchObject({
      status: "blocked",
      reason: "restore-child-unavailable",
      diagnostic: expect.stringContaining("Fixture Project"),
    });
  });

  it("keeps the import receipt restorable when assignment fails", async () => {
    const fixtureData = await fixture();
    const operationStore = createOperationStore(join(fixtureData.userDataPath, "omni", "operations.json"));
    const importReceipt = receipt("import-artifact", "import-receipt");
    const importOperations = {
      preview: vi.fn(async () => ({
        status: "ready" as const,
        plan: {
          planId: "import-plan",
          kind: "import-artifact" as const,
          displayTarget: "packages/ui",
          actions: [],
          git: { mode: "unavailable" as const, warnings: [] },
        },
      })),
      apply: vi.fn(async () => {
        await operationStore.append(importReceipt);
        return { status: "applied" as const, receipt: importReceipt };
      }),
    };
    const operations = createAddToProjectOperations(fixtureData.grants, {
      userDataPath: fixtureData.userDataPath,
      operationStore,
      git,
      registry: fixtureData.registry,
      bindingsStore: createBindingsStore(bindingsFilePath(fixtureData.userDataPath)),
      settingsStore: createSettingsStore(settingsFilePath(fixtureData.userDataPath)),
      importOperations,
      applyProject: vi.fn(async () => ({
        status: "failed" as const,
        receipt: {
          ...receipt("apply-plan", "apply-failed", "project-one"),
          status: "failed" as const,
          diagnostic: "target changed",
        },
      })),
      prepareCatalogue: async () => ({
        sourceId: "catalogue-anthropics/skills-quality",
        grantHandle: "catalogue-grant",
        root: fixtureData.preparedRoot,
        relativePath: "skills/quality/SKILL.md",
      }),
    });
    const preview = await operations.preview({
      kind: "add-to-project",
      entry: { ownerRepo: "anthropics/skills", skill: "quality" },
      projectId: "project-one",
      grantHandle: "project-grant",
      packageId: "packages/ui",
      harnessIds: ["claude-code"],
    });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied).toMatchObject({
      status: "failed",
      receipt: { failedStep: "assign", children: ["import-receipt", "apply-failed"] },
    });
  });
});
