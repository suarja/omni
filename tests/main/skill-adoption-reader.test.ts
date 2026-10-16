import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Binding } from "../../src/domain/assignment-plan";
import type { InventorySnapshot, ObservedArtifact } from "../../src/domain/inventory";
import type { SkillLocationKey, SkillRelationshipsState } from "../../src/domain/skill-reconciliation/types";
import type { RegistryGrant, RegistryIpcServices } from "../../src/main/registry-ipc";
import type { BindingsStore } from "../../src/main/bindings-store";
import { readSkillAdoptionSnapshot, packageSkillArtifactPath } from "../../src/main/skill-management/adoption-reader";
import type { SkillRelationshipStore, SkillObservationFilesystem } from "../../src/ports/skill-reconciliation";
import { SkillObservationError } from "../../src/ports/skill-reconciliation";
import type { SkillAdoptionRequest } from "../../src/shared/skill-reconciliation-request";
import type { ObservationResponse, RegistryViewResponse } from "../../src/shared/registry-ipc";

const sourceId = "source-personal";
const projectId = "project-local";
const packageId = "package-id-tools";
const sourcePath = "skills/demo";
const skillId = "123e4567-e89b-42d3-a456-426614174000";
const location: SkillLocationKey = { projectId, harnessId: "codex", folderPath: ".agents/skills/demo" };
const request: SkillAdoptionRequest = {
  choice: "adopt-exact",
  skillId,
  source: { sourceId, packageId, artifactPath: sourcePath },
  locations: [location],
};
const roots: string[] = [];
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

type Node = { kind: "directory" | "file" | "symlink"; bytes?: Uint8Array; identity: string };

function artifact(overrides: Partial<ObservedArtifact> = {}): ObservedArtifact {
  return {
    id: "skill-source",
    physicalIdentity: "physical-skill-source",
    projectionPaths: ["packages/tools/skills/demo/SKILL.md"],
    kind: "skill",
    relativePath: "packages/tools/skills/demo/SKILL.md",
    displayPath: "packages/tools/skills/demo/SKILL.md",
    providerIds: [],
    scope: "source",
    confidence: "exact",
    symlinkState: "none",
    packageId,
    ...overrides,
  };
}

function inventory(
  artifacts: readonly ObservedArtifact[],
  packages: InventorySnapshot["packages"] = [],
): InventorySnapshot {
  return {
    rootHandle: "inventory-root",
    displayRoot: "registered root",
    observedAt: "2026-10-08T12:00:00.000Z",
    harnesses: ["codex"],
    artifacts,
    packages,
    diagnostics: [],
    gitScopes: [],
  };
}

async function setup(
  options: Readonly<{
    sourceArtifacts?: readonly ObservedArtifact[];
    localArtifacts?: readonly ObservedArtifact[];
    external?: boolean;
    archived?: boolean;
    symlink?: boolean;
  }> = {},
) {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "omni-adoption-source-"));
  const projectDirectory = await mkdtemp(join(tmpdir(), "omni-adoption-project-"));
  roots.push(sourceDirectory, projectDirectory);
  const sourceRoot = await realpath(sourceDirectory);
  const projectRoot = await realpath(projectDirectory);
  const sourceStat = await stat(sourceRoot);
  const projectStat = await stat(projectRoot);
  const sourceGrant: RegistryGrant = {
    handle: "source-grant",
    subject: { kind: "source", id: sourceId },
    root: sourceRoot,
    device: String(sourceStat.dev),
    inode: String(sourceStat.ino),
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const projectGrant: RegistryGrant = {
    handle: "project-grant",
    subject: { kind: "project", id: projectId },
    root: projectRoot,
    device: String(projectStat.dev),
    inode: String(projectStat.ino),
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const sourceArtifacts = options.sourceArtifacts ?? [artifact()];
  const packages: InventorySnapshot["packages"] = [
    {
      id: packageId,
      relativeRoot: "packages/tools",
      displayName: "Tools",
      format: "omni",
      manifestPaths: ["packages/tools/omni.json"],
      artifactIds: sourceArtifacts.map(({ id }) => id),
    },
  ];
  const sourceInventory = inventory(sourceArtifacts, packages);
  const localArtifact = artifact({
    id: "skill-local",
    physicalIdentity: "physical-skill-local",
    projectionPaths: [".agents/skills/demo/SKILL.md"],
    relativePath: ".agents/skills/demo/SKILL.md",
    displayPath: ".agents/skills/demo/SKILL.md",
    providerIds: ["codex"],
    packageId: undefined,
    scope: "project",
  });
  const projectInventory = inventory(options.localArtifacts ?? [localArtifact], []);
  const registryView: RegistryViewResponse = {
    status: "ready",
    registry: {
      revision: 4,
      sources: [
        {
          ref: { kind: "source", id: sourceId },
          displayName: "Personal",
          displayRoot: "source",
          availability: "available",
          ownership: options.external ? "external" : "personal",
          capabilities: { observe: true, write: false },
          ...(options.archived ? { archivedAt: "2026-10-01T00:00:00.000Z" } : {}),
        },
      ],
      projects: [
        {
          ref: { kind: "project", id: projectId },
          displayName: "Project",
          displayRoot: "project",
          availability: "available",
          ...(options.archived ? { archivedAt: "2026-10-01T00:00:00.000Z" } : {}),
        },
      ],
    },
  };
  const observations = new Map<string, ObservationResponse>([
    [
      sourceId,
      {
        status: "observed",
        observation: {
          subject: { kind: "source", id: sourceId },
          observedAt: "2026-10-08T12:00:00.000Z",
          inventory: sourceInventory,
        },
      },
    ],
    [
      projectId,
      {
        status: "observed",
        observation: {
          subject: { kind: "project", id: projectId },
          observedAt: "2026-10-08T12:00:00.000Z",
          inventory: projectInventory,
        },
      },
    ],
  ]);
  const registry = {
    issue: () => "unused",
    get: (handle: string) =>
      handle === sourceGrant.handle ? sourceGrant : handle === projectGrant.handle ? projectGrant : undefined,
    getGrantForEntry: async (ref: { kind: "source" | "project"; id: string }) =>
      ref.kind === "source" ? sourceGrant.handle : projectGrant.handle,
    listRegistry: async () => registryView,
    observeEntryWithGrant: async (_ref: unknown, handle: string) =>
      observations.get(handle === sourceGrant.handle ? sourceId : projectId)!,
  } as unknown as RegistryIpcServices;
  const relationshipsState: SkillRelationshipsState = {
    schemaVersion: 1,
    revision: 2,
    skills: [{ skillId, label: "demo", evidence: "individual", locations: [location] }],
    uses: [],
  };
  const relationships = {
    read: async () => ({ status: "ready", state: relationshipsState }),
    compareAndSave: async () => ({ status: "saved", state: relationshipsState }),
    updateUsesExact: async () => ({ status: "saved", state: relationshipsState }),
  } as unknown as SkillRelationshipStore;
  const bindingState: readonly Binding[] = [];
  const bindings = { read: async () => ({ status: "ready", bindings: bindingState }) } as unknown as BindingsStore;
  const nodes = new Map<string, Node>();
  const putTree = (grant: RegistryGrant, folder: string, prefix: string) => {
    nodes.set(`${grant.handle}:${folder}`, {
      kind: options.symlink && grant.handle === projectGrant.handle ? "symlink" : "directory",
      identity: `${prefix}:root`,
    });
    const entries = [
      ["SKILL.md", Buffer.from("Skill\n")],
      ["support/asset.bin", Buffer.from([0, 1, 2])],
      [".git/config", Buffer.from("ignored")],
    ] as const;
    for (const [relativePath, bytes] of entries) {
      const parts = relativePath.split("/");
      let parent = folder;
      for (const segment of parts.slice(0, -1)) {
        parent = `${parent}/${segment}`;
        if (!nodes.has(`${grant.handle}:${parent}`))
          nodes.set(`${grant.handle}:${parent}`, { kind: "directory", identity: `${prefix}:${parent}` });
      }
      const path = `${folder}/${relativePath}`;
      nodes.set(`${grant.handle}:${path}`, { kind: "file", bytes, identity: `${prefix}:${path}` });
    }
  };
  putTree(sourceGrant, "packages/tools/skills/demo", "source");
  putTree(projectGrant, location.folderPath, "project");
  const filesystem: SkillObservationFilesystem = {
    async lstat(grant, path) {
      const node = nodes.get(`${grant.subject.id === sourceId ? sourceGrant.handle : projectGrant.handle}:${path}`);
      if (!node) throw new SkillObservationError("missing");
      return { kind: node.kind, byteLength: node.bytes?.byteLength ?? 0, identity: node.identity };
    },
    async listDirectory(grant, path) {
      const prefix = `${grant.subject.id === sourceId ? sourceGrant.handle : projectGrant.handle}:${path}/`;
      return [
        ...new Set(
          [...nodes.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length).split("/")[0]!),
        ),
      ];
    },
    async readFile(grant, path, expectedIdentity) {
      const node = nodes.get(`${grant.subject.id === sourceId ? sourceGrant.handle : projectGrant.handle}:${path}`);
      if (!node?.bytes || node.identity !== expectedIdentity) throw new SkillObservationError("changed-during-read");
      return { bytes: node.bytes, identity: node.identity };
    },
  };
  return { registry, relationships, bindings, filesystem };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("readSkillAdoptionSnapshot", () => {
  it("maps package identifiers separately from root-relative paths and captures exact trees", async () => {
    expect(packageSkillArtifactPath("packages/tools", "packages/tools/skills/demo/SKILL.md")).toBe(sourcePath);
    expect(packageSkillArtifactPath("root", "skills/demo/SKILL.md")).toBe(sourcePath);
    expect(packageSkillArtifactPath("packages/tools", "other/skills/demo/SKILL.md")).toBeUndefined();

    const dependencies = await setup();
    const result = await readSkillAdoptionSnapshot(request, { ...dependencies, now: () => Date.now(), digest });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.sourceGrant.subject).toEqual({ kind: "source", id: sourceId });
    expect(result.sourceTree.folderPath).toBe("packages/tools/skills/demo");
    expect(result.sourceTree.revision.files.map(({ path }) => path).sort()).toEqual(["SKILL.md", "support/asset.bin"]);
    expect(result.localTrees[0]?.tree.revision.hash).toBe(result.sourceTree.revision.hash);
  });

  it("reports an unavailable source observation separately from missing skill children", async () => {
    const dependencies = await setup();
    const registry: RegistryIpcServices = {
      ...dependencies.registry,
      observeEntryWithGrant: async (ref, handle) =>
        ref.kind === "source"
          ? { status: "corrupt", diagnostic: "Fixture source unavailable.", recoveryAvailable: false }
          : dependencies.registry.observeEntryWithGrant(ref, handle),
    };
    expect(await readSkillAdoptionSnapshot(request, { ...dependencies, registry, digest })).toMatchObject({
      status: "blocked",
      code: "source-observation-incomplete",
    });
  });

  it("rejects ambiguous observed children without trying a fallback path", async () => {
    const dependencies = await setup({
      sourceArtifacts: [
        artifact(),
        artifact({
          id: "second-child",
          physicalIdentity: "second",
          projectionPaths: ["packages/tools/skills/demo/SKILL.md"],
        }),
      ],
    });
    const result = await readSkillAdoptionSnapshot(request, { ...dependencies, digest });
    expect(result).toMatchObject({ status: "blocked", code: "source-skill-unavailable" });
  });

  it("rejects a conventional target attributed to another harness", async () => {
    const local = artifact({
      id: "skill-local",
      physicalIdentity: "physical-skill-local",
      projectionPaths: [".agents/skills/demo/SKILL.md"],
      relativePath: ".agents/skills/demo/SKILL.md",
      displayPath: ".agents/skills/demo/SKILL.md",
      providerIds: ["claude-code"],
      packageId: undefined,
      scope: "project",
    });
    const dependencies = await setup({ localArtifacts: [local] });
    const result = await readSkillAdoptionSnapshot(request, { ...dependencies, digest });
    expect(result).toMatchObject({ status: "blocked", code: "target-child-ambiguous" });
  });

  it("blocks non-personal, archived, aliased, and unsafe selected sources or targets", async () => {
    for (const options of [{ external: true }, { archived: true }, { symlink: true }]) {
      const dependencies = await setup(options);
      const result = await readSkillAdoptionSnapshot(request, { ...dependencies, digest });
      expect(result.status).toBe("blocked");
    }
  });
});
