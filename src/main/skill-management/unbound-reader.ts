import { readSourceSkillObservation, type SourceObservationBlock } from "./source-observation";
import { createHash } from "node:crypto";

import { createSkillRevision } from "../../domain/skill-reconciliation/revisions";
import type {
  LogicalSkillRecord,
  SkillLocationKey,
  SkillRevision,
  SourceSkillRef,
} from "../../domain/skill-reconciliation/types";
import type { SkillUnboundResolutionRequest } from "../../shared/skill-unbound-resolution-request";
import type { SkillDirectoryEnvelope } from "../../shared/skill-directory-envelope";
import type { SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import type { BindingsStore } from "../bindings-store";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import { hasCompleteObservationForLocation } from "../skill-reconciliation/location-observation";
import { currentGrantRoot } from "../granted-hashing";
import { revalidateSkillTree, type SkillTreeCapture } from "../skill-reconciliation/capture-engine";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";
import {
  observedLocalTarget,
  observedSourcePath,
  readSkillAdoptionSnapshot,
  skillRootIdentity,
  type SkillAdoptionSnapshot,
} from "./adoption-reader";

type CompleteTree = Extract<SkillTreeCapture, { status: "complete" }>;
type SnapshotBase = Extract<SkillAdoptionSnapshot, { status: "ready" }>;
export type { SkillDirectoryEnvelope } from "../../shared/skill-directory-envelope";

export type SkillUnboundResolutionSnapshot =
  | Readonly<{ status: "blocked"; code: string; message: string }>
  | Readonly<{
      status: "ready";
      request: SkillUnboundResolutionRequest;
      sourceGrant: RegistryGrant;
      projectGrant: RegistryGrant;
      sourceTree: CompleteTree;
      localTree: CompleteTree;
      relationships: SnapshotBase["relationships"];
      bindings: SnapshotBase["bindings"];
      record: LogicalSkillRecord;
      rootIdentities: Readonly<{ source: string; project: string }>;
      sourceEnvelope: SkillDirectoryEnvelope;
      localEnvelope: SkillDirectoryEnvelope;
    }>;

export type UnboundReaderDependencies = Readonly<{
  registry: RegistryIpcServices;
  relationships: SkillRelationshipStore;
  bindings: BindingsStore;
  filesystem?: SkillObservationFilesystem;
  now?: () => number;
  digest?: (value: string) => string;
}>;

function blocked(code: string, message: string): SkillUnboundResolutionSnapshot {
  return { status: "blocked", code, message };
}

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isGitPath(path: string): boolean {
  return path.split("/").some((part) => part === ".git");
}

function comparisonTree(tree: CompleteTree, digest: (value: string) => string): CompleteTree {
  const files = new Map([...tree.files.entries()].filter(([path]) => !isGitPath(path)));
  const entries = tree.revision.files.filter((file) => !isGitPath(file.path));
  const revisions = [...files.entries()].map(([path, bytes]) => ({ path, bytes }));
  return {
    ...tree,
    files,
    revision: createSkillRevision(
      revisions.map(({ path, bytes }) => ({
        path,
        hash: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
      })),
      digest,
    ),
  };
}

export async function readSkillDirectoryEnvelope(
  grant: RegistryGrant,
  folderPath: string,
  filesystem: SkillObservationFilesystem,
): Promise<SkillDirectoryEnvelope | undefined> {
  const result: Array<{ path: string; kind: "file" | "directory"; identity: string }> = [];
  const visit = async (relativePath: string, logicalPath: string): Promise<void> => {
    const node = await filesystem.lstat(
      {
        root: grant.root,
        subject: grant.subject,
        device: grant.device,
        inode: grant.inode,
        expiresAt: grant.expiresAt,
      },
      relativePath,
    );
    if (node.kind !== "directory" && node.kind !== "file")
      throw new Error("The selected folder contains an unsafe entry.");
    // File effects own stable device/inode identity; size and timestamps are revalidated separately.
    result.push({ path: logicalPath, kind: node.kind, identity: node.identity.split(":").slice(0, 2).join(":") });
    if (node.kind !== "directory" || logicalPath === ".git") return;
    const names = [
      ...(await filesystem.listDirectory(
        {
          root: grant.root,
          subject: grant.subject,
          device: grant.device,
          inode: grant.inode,
          expiresAt: grant.expiresAt,
        },
        relativePath,
      )),
    ].sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\"))
        throw new Error("The selected folder contains an unsafe path.");
      await visit(`${relativePath}/${name}`, logicalPath === "." ? name : `${logicalPath}/${name}`);
    }
  };
  try {
    await visit(folderPath, ".");
    if (result.length > 2048) return undefined;
    return result.sort((left, right) => left.path.localeCompare(right.path));
  } catch {
    return undefined;
  }
}

async function recheckObservations(
  request: SkillUnboundResolutionRequest,
  sourceGrant: RegistryGrant,
  projectGrant: RegistryGrant,
  dependencies: UnboundReaderDependencies,
  now: () => number,
): Promise<boolean | SourceObservationBlock> {
  const [source, project] = await Promise.all([
    dependencies.registry.observeEntryWithGrant({ kind: "source", id: request.source.sourceId }, sourceGrant.handle),
    dependencies.registry.observeEntryWithGrant(
      { kind: "project", id: request.locations[0]!.projectId },
      projectGrant.handle,
    ),
  ]);
  const sourceRead = readSourceSkillObservation(source, request.source, observedSourcePath);
  if (sourceRead.status === "blocked") return sourceRead;
  return (
    hasCompleteObservationForLocation(project, request.locations[0]!.folderPath) &&
    observedLocalTarget(project.observation.inventory, request.locations[0]!) &&
    sourceGrant.expiresAt > now() &&
    projectGrant.expiresAt > now() &&
    (await currentGrantRoot(sourceGrant)) &&
    (await currentGrantRoot(projectGrant))
  );
}

export async function readSkillUnboundResolutionSnapshot(
  request: SkillUnboundResolutionRequest,
  dependencies: UnboundReaderDependencies,
): Promise<SkillUnboundResolutionSnapshot> {
  const now = dependencies.now ?? Date.now;
  const filesystem = dependencies.filesystem ?? strictSkillObservationFilesystem;
  const digest = dependencies.digest ?? ((value: string) => createHash("sha256").update(value, "utf8").digest("hex"));
  const adoption = await readSkillAdoptionSnapshot(
    {
      choice: "adopt-exact",
      skillId: request.skillId,
      source: request.source,
      locations: request.locations,
    },
    {
      registry: dependencies.registry,
      relationships: dependencies.relationships,
      bindings: dependencies.bindings,
      filesystem,
      now,
      digest,
    },
  );
  if (adoption.status !== "ready") return blocked(adoption.code, adoption.message);
  const localCopy = adoption.localTrees[0];
  const record = adoption.relationships.skills.find((candidate) => candidate.skillId === request.skillId);
  const location = request.locations[0]!;
  if (!localCopy || !record || !record.locations.some((candidate) => locationKey(candidate) === locationKey(location)))
    return blocked("location-not-in-skill", "The selected location no longer belongs to its logical skill record.");
  const [sourceEnvelopeBefore, localEnvelopeBefore] = await Promise.all([
    readSkillDirectoryEnvelope(adoption.sourceGrant, adoption.sourceTree.folderPath, filesystem),
    readSkillDirectoryEnvelope(adoption.projectGrant, localCopy.tree.folderPath, filesystem),
  ]);
  if (!sourceEnvelopeBefore || !localEnvelopeBefore)
    return blocked(
      "tree-envelope-unavailable",
      "A complete regular-file and directory envelope could not be captured safely.",
    );
  const [sourceEnvelopeAfter, localEnvelopeAfter] = await Promise.all([
    readSkillDirectoryEnvelope(adoption.sourceGrant, adoption.sourceTree.folderPath, filesystem),
    readSkillDirectoryEnvelope(adoption.projectGrant, localCopy.tree.folderPath, filesystem),
  ]);
  if (!same(sourceEnvelopeBefore, sourceEnvelopeAfter) || !same(localEnvelopeBefore, localEnvelopeAfter))
    return blocked(
      "tree-envelope-changed",
      "The source or selected copy changed while its tree envelope was observed.",
    );
  const [sourceTreeState, localTreeState, fresh] = await Promise.all([
    revalidateSkillTree(
      adoption.sourceTree,
      {
        root: adoption.sourceGrant.root,
        subject: adoption.sourceGrant.subject,
        device: adoption.sourceGrant.device,
        inode: adoption.sourceGrant.inode,
        expiresAt: adoption.sourceGrant.expiresAt,
      },
      filesystem,
    ),
    revalidateSkillTree(localCopy.tree, localCopy.grant, filesystem),
    recheckObservations(request, adoption.sourceGrant, adoption.projectGrant, dependencies, now),
  ]);
  if (typeof fresh !== "boolean") return blocked(fresh.code, fresh.message);
  if (sourceTreeState.status !== "complete" || localTreeState.status !== "complete" || !fresh)
    return blocked("observation-stale", "The exact source or project copy changed during the complete read.");
  const sourceTree = comparisonTree(adoption.sourceTree, digest);
  const localTree = comparisonTree(localCopy.tree, digest);
  return {
    status: "ready",
    request,
    sourceGrant: adoption.sourceGrant,
    projectGrant: adoption.projectGrant,
    sourceTree,
    localTree,
    relationships: adoption.relationships,
    bindings: adoption.bindings,
    record,
    rootIdentities: {
      source: skillRootIdentity(adoption.sourceGrant, digest),
      project: skillRootIdentity(adoption.projectGrant, digest),
    },
    sourceEnvelope: sourceEnvelopeBefore,
    localEnvelope: localEnvelopeBefore,
  };
}

export function revisionTreeMatches(
  tree: CompleteTree,
  expected: SkillRevision,
  digest: (value: string) => string,
): boolean {
  return same(comparisonTree(tree, digest).revision, expected);
}
