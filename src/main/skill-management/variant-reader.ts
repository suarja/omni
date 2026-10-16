import { activeStorefronts, StorefrontTargetError } from "../../domain/source-roles";
import { createHash } from "node:crypto";

import type { Binding } from "../../domain/assignment-plan";
import { parsePackageManifest, type PackageManifest } from "../../domain/marketplace-format";
import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillLocationKey,
  SourceSkillRef,
} from "../../domain/skill-reconciliation/types";
import type { SkillVariantCaptureRequest } from "../../shared/skill-variant-capture-request";
import { SkillObservationError, type SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import type { BindingsStore } from "../bindings-store";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import { hasCompleteObservationForLocation } from "../skill-reconciliation/location-observation";
import { currentGrantRoot } from "../granted-hashing";
import {
  captureSkillTree,
  revalidateSkillTree,
  type SkillScanBudget,
  type SkillTreeCapture,
} from "../skill-reconciliation/capture-engine";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";
import {
  freshGrant,
  hasActiveSourceAndProject,
  observationGrant,
  observedLocalTarget,
  skillRootIdentity,
  SKILL_SCAN_BUDGET_BYTES,
} from "./adoption-reader";

type CompleteTree = Extract<SkillTreeCapture, { status: "complete" }>;
type RegistryList = Awaited<ReturnType<RegistryIpcServices["listRegistry"]>>;
type ObservedEntry = Extract<Awaited<ReturnType<RegistryIpcServices["observeEntryWithGrant"]>>, { status: "observed" }>;

export type SkillVariantReaderDependencies = Readonly<{
  registry: RegistryIpcServices;
  relationships: SkillRelationshipStore;
  bindings: BindingsStore;
  filesystem?: SkillObservationFilesystem;
  now?: () => number;
}>;

export type SkillVariantSnapshot =
  | Readonly<{
      status: "ready";
      request: SkillVariantCaptureRequest;
      sourceGrant: RegistryGrant;
      projectGrant: RegistryGrant;
      sourceObservation: ObservedEntry;
      projectObservation: ObservedEntry;
      localTree: CompleteTree;
      record: LogicalSkillRecord;
      use?: ManagedSkillUse;
      binding?: Binding;
      storeRevision: number;
      source: SourceSkillRef;
      packageRoot: string;
      manifestPath: string;
      manifestBefore: Uint8Array;
      manifestHash: string;
      manifest: PackageManifest;
      existingArtifactKeys: readonly string[];
      existingFolderNames: readonly string[];
      skillsDirectoryPresent: boolean;
      rootIdentities: Readonly<{ source: string; project: string }>;
    }>
  | Readonly<{ status: "blocked"; code: string; message: string }>;

function blocked(code: string, message: string): SkillVariantSnapshot {
  return { status: "blocked", code, message };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function physicalRoot(relativeRoot: string): string {
  return relativeRoot === "root" ? "" : relativeRoot;
}

function relativeFile(root: string, child: string): string {
  return root ? `${root}/${child}` : child;
}

function sameBindings(left: readonly Binding[], right: readonly Binding[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readRegularFile(
  filesystem: SkillObservationFilesystem,
  grant: RegistryGrant,
  path: string,
): Promise<Uint8Array | undefined> {
  const readGrant = observationGrant(grant);
  const node = await filesystem.lstat(readGrant, path);
  if (node.kind !== "file" || node.byteLength > 1024 * 1024) return undefined;
  const read = await filesystem.readFile(readGrant, path, node.identity, 1024 * 1024);
  const after = await filesystem.lstat(readGrant, path);
  return read.identity === node.identity &&
    after.identity === node.identity &&
    after.kind === "file" &&
    read.bytes.byteLength === node.byteLength
    ? Uint8Array.from(read.bytes)
    : undefined;
}

async function readDestination(
  request: SkillVariantCaptureRequest,
  sourceGrant: RegistryGrant,
  observation: ObservedEntry,
  filesystem: SkillObservationFilesystem,
): Promise<
  | Readonly<{
      packageRoot: string;
      manifestPath: string;
      manifestBefore: Uint8Array;
      manifestHash: string;
      manifest: PackageManifest;
      existingArtifactKeys: readonly string[];
      existingFolderNames: readonly string[];
      skillsDirectoryPresent: boolean;
    }>
  | undefined
> {
  const packages = (observation.observation.inventory.packages ?? []).filter(
    ({ id }) => id === request.destination.packageId,
  );
  if (packages.length !== 1) return undefined;
  const pkg = packages[0]!;
  if (pkg.format !== "omni") return undefined;
  const packageRoot = pkg.relativeRoot;
  const physical = physicalRoot(packageRoot);
  if (!hasCompleteObservationForLocation(observation, physical)) return undefined;
  const manifestPath = relativeFile(physical, "omni.plugin.json");
  if (pkg.manifestPaths.filter((path) => path === manifestPath).length !== 1) return undefined;
  const manifestBefore = await readRegularFile(filesystem, sourceGrant, manifestPath);
  if (!manifestBefore) return undefined;
  let manifest: PackageManifest;
  try {
    manifest = parsePackageManifest(JSON.parse(Buffer.from(manifestBefore).toString("utf8")) as unknown);
  } catch {
    return undefined;
  }
  const skillRoot = relativeFile(physical, "skills");
  let existingFolderNames: string[] = [];
  let skillsDirectoryPresent = true;
  try {
    const directory = await filesystem.lstat(observationGrant(sourceGrant), skillRoot);
    if (directory.kind !== "directory") return undefined;
    existingFolderNames = [...(await filesystem.listDirectory(observationGrant(sourceGrant), skillRoot))].sort((a, b) =>
      a.localeCompare(b),
    );
    for (const name of existingFolderNames) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return undefined;
      const child = await filesystem.lstat(observationGrant(sourceGrant), `${skillRoot}/${name}`);
      if (child.kind === "symlink" || child.kind === "other") return undefined;
    }
  } catch (error: unknown) {
    if (error instanceof SkillObservationError && error.reason === "missing") skillsDirectoryPresent = false;
    else return undefined;
  }
  return {
    packageRoot,
    manifestPath,
    manifestBefore,
    manifestHash: digest(manifestBefore),
    manifest,
    existingArtifactKeys: manifest.artifacts.filter(({ kind }) => kind === "skill").map(({ path }) => path),
    existingFolderNames,
    skillsDirectoryPresent,
  };
}

function currentDestinationMatches(
  snapshot: Extract<SkillVariantSnapshot, { status: "ready" }>,
  observation: ObservedEntry,
): boolean {
  const pkg = (observation.observation.inventory.packages ?? []).filter(
    ({ id }) => id === snapshot.request.destination.packageId,
  );
  return (
    pkg.length === 1 &&
    pkg[0]?.relativeRoot === snapshot.packageRoot &&
    pkg[0]?.format === "omni" &&
    pkg[0]?.manifestPaths.filter((path) => path === snapshot.manifestPath).length === 1
  );
}

export async function readSkillVariantSnapshot(
  request: SkillVariantCaptureRequest,
  dependencies: SkillVariantReaderDependencies,
): Promise<SkillVariantSnapshot> {
  const now = dependencies.now ?? Date.now;
  const filesystem = dependencies.filesystem ?? strictSkillObservationFilesystem;
  const [location] = request.locations;
  const registryBefore = await dependencies.registry.listRegistry();
  if (
    registryBefore.status === "ready" &&
    activeStorefronts(registryBefore.registry).some((source) => source.ref.id === request.destination.sourceId)
  ) {
    const error = new StorefrontTargetError();
    return blocked(error.code, error.message);
  }
  if (!hasActiveSourceAndProject(registryBefore, request.destination.sourceId, location.projectId)) {
    return blocked("entry-unavailable", "Reopen the active personal source and project before capturing this copy.");
  }
  const [sourceGrant, projectGrant] = await Promise.all([
    freshGrant(dependencies.registry, { kind: "source", id: request.destination.sourceId }, now),
    freshGrant(dependencies.registry, { kind: "project", id: location.projectId }, now),
  ]);
  if (
    !sourceGrant ||
    !projectGrant ||
    !(await currentGrantRoot(sourceGrant)) ||
    !(await currentGrantRoot(projectGrant))
  ) {
    return blocked("grant-unavailable", "Fresh access to the selected personal source and project is required.");
  }
  const [sourceObservation, projectObservation, relationshipRead, bindingRead] = await Promise.all([
    dependencies.registry.observeEntryWithGrant(
      { kind: "source", id: request.destination.sourceId },
      sourceGrant.handle,
    ),
    dependencies.registry.observeEntryWithGrant({ kind: "project", id: location.projectId }, projectGrant.handle),
    dependencies.relationships.read(),
    dependencies.bindings.read(),
  ]);
  if (
    sourceObservation.status !== "observed" ||
    !hasCompleteObservationForLocation(projectObservation, location.folderPath)
  )
    return blocked("observation-incomplete", "Complete source and project observations are required.");
  if (relationshipRead.status !== "ready" || bindingRead.status !== "ready")
    return blocked("store-unavailable", "Skill relationship and Binding records must be readable.");
  if (!observedLocalTarget(projectObservation.observation.inventory, location))
    return blocked(
      "copy-unavailable",
      "The selected conventional project skill folder is missing, aliased or ambiguous.",
    );
  const record = relationshipRead.state.skills.find(({ skillId }) => skillId === request.skillId);
  if (!record || !record.locations.some((item) => locationKey(item) === locationKey(location)))
    return blocked("location-not-in-skill", "The selected copy no longer belongs to this logical skill.");
  const uses = relationshipRead.state.uses.filter((use) => locationKey(use.location) === locationKey(location));
  if (uses.length > 1)
    return blocked("management-contradiction", "The selected copy has contradictory managed-use records.");
  const use = uses[0];
  const linkedBindings = use ? bindingRead.bindings.filter((binding) => binding.bindingId === use.bindingId) : [];
  if (linkedBindings.length > 1)
    return blocked("management-contradiction", "The selected managed use has duplicate Binding records.");
  const binding = linkedBindings[0];
  if (
    use &&
    (use.skillId !== request.skillId ||
      !binding ||
      binding.kind !== "skill" ||
      binding.projectId !== location.projectId ||
      binding.harnessId !== location.harnessId ||
      binding.sourceId !== use.source.sourceId ||
      binding.packageId !== use.source.packageId ||
      (binding.artifactPath.endsWith("/SKILL.md")
        ? binding.artifactPath.slice(0, -"/SKILL.md".length)
        : binding.artifactPath) !== use.source.artifactPath)
  )
    return blocked("management-contradiction", "The selected managed copy does not match its exact use and Binding.");
  const destination = await readDestination(request, sourceGrant, sourceObservation, filesystem);
  if (!destination)
    return blocked(
      "destination-unavailable",
      "Select one observed existing Omni plugin with a valid omni.plugin.json.",
    );
  const budget: SkillScanBudget = { remainingBytes: SKILL_SCAN_BUDGET_BYTES };
  const localTree = await captureSkillTree(
    observationGrant(projectGrant),
    location.folderPath,
    budget,
    filesystem,
    (value) => createHash("sha256").update(value, "utf8").digest("hex"),
  );
  if (localTree.status !== "complete")
    return blocked(
      "copy-incomplete",
      "The selected skill tree is unsafe, incomplete or exceeds the observation limits.",
    );
  const source: SourceSkillRef = {
    sourceId: request.destination.sourceId,
    packageId: request.destination.packageId,
    artifactPath: `skills/${request.destination.skillKey}`,
  };
  const snapshot: Extract<SkillVariantSnapshot, { status: "ready" }> = {
    status: "ready",
    request,
    sourceGrant,
    projectGrant,
    sourceObservation,
    projectObservation,
    localTree,
    record,
    ...(use ? { use } : {}),
    ...(binding ? { binding } : {}),
    storeRevision: relationshipRead.state.revision,
    source,
    packageRoot: destination.packageRoot,
    manifestPath: destination.manifestPath,
    manifestBefore: destination.manifestBefore,
    manifestHash: destination.manifestHash,
    manifest: destination.manifest,
    existingArtifactKeys: destination.existingArtifactKeys,
    existingFolderNames: destination.existingFolderNames,
    skillsDirectoryPresent: destination.skillsDirectoryPresent,
    rootIdentities: {
      source: skillRootIdentity(sourceGrant, (value) => createHash("sha256").update(value, "utf8").digest("hex")),
      project: skillRootIdentity(projectGrant, (value) => createHash("sha256").update(value, "utf8").digest("hex")),
    },
  };
  const [relationshipAfter, bindingAfter, sourceAfter, projectAfter, registryAfter] = await Promise.all([
    dependencies.relationships.read(),
    dependencies.bindings.read(),
    dependencies.registry.observeEntryWithGrant(
      { kind: "source", id: request.destination.sourceId },
      sourceGrant.handle,
    ),
    dependencies.registry.observeEntryWithGrant({ kind: "project", id: location.projectId }, projectGrant.handle),
    dependencies.registry.listRegistry(),
  ]);
  if (
    relationshipAfter.status !== "ready" ||
    relationshipAfter.state.revision !== snapshot.storeRevision ||
    bindingAfter.status !== "ready" ||
    !sameBindings(bindingRead.bindings, bindingAfter.bindings)
  )
    return blocked("store-changed", "Skill relationships or Bindings changed during capture preview.");
  if (
    !hasCompleteObservationForLocation(sourceAfter, physicalRoot(snapshot.packageRoot)) ||
    !hasCompleteObservationForLocation(projectAfter, location.folderPath) ||
    !currentDestinationMatches(snapshot, sourceAfter) ||
    !observedLocalTarget(projectAfter.observation.inventory, location) ||
    !hasActiveSourceAndProject(registryAfter, request.destination.sourceId, location.projectId) ||
    sourceGrant.expiresAt <= now() ||
    projectGrant.expiresAt <= now() ||
    !(await currentGrantRoot(sourceGrant)) ||
    !(await currentGrantRoot(projectGrant))
  )
    return blocked(
      "grant-or-observation-changed",
      "A selected grant, root or resource observation changed during preview.",
    );
  if ((await revalidateSkillTree(localTree, observationGrant(projectGrant), filesystem)).status !== "complete")
    return blocked("copy-changed", "The selected project tree changed during its complete read.");
  const destinationAfter = await readDestination(request, sourceGrant, sourceAfter, filesystem);
  if (
    !destinationAfter ||
    destinationAfter.manifestHash !== destination.manifestHash ||
    JSON.stringify(destinationAfter.existingArtifactKeys) !== JSON.stringify(destination.existingArtifactKeys) ||
    JSON.stringify(destinationAfter.existingFolderNames) !== JSON.stringify(destination.existingFolderNames) ||
    destinationAfter.skillsDirectoryPresent !== destination.skillsDirectoryPresent
  ) {
    return blocked(
      "destination-changed",
      "The selected plugin manifest or skill folder inventory changed during preview.",
    );
  }
  return snapshot;
}
