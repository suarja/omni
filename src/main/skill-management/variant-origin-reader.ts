import { activeWorkshop } from "../../domain/source-roles";
import { createHash } from "node:crypto";

import { parsePackageManifest, type PackageManifest } from "../../domain/marketplace-format";
import type { SkillVariantOrigin } from "../../domain/skill-reconciliation/variant-origin";
import type { SourceSkillRef } from "../../domain/skill-reconciliation/types";
import type { SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { ReadSkillVariantOriginResponse } from "../../shared/skill-variant-effects";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import { hasCompleteObservationForLocation } from "../skill-reconciliation/location-observation";
import { currentGrantRoot } from "../granted-hashing";
import { freshGrant, observationGrant, observedSourcePath, skillRootIdentity } from "./adoption-reader";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";

type ObservedEntry = Extract<Awaited<ReturnType<RegistryIpcServices["observeEntryWithGrant"]>>, { status: "observed" }>;
type SourceRegistry = Extract<Awaited<ReturnType<RegistryIpcServices["listRegistry"]>>, { status: "ready" }>;

export type SkillVariantOriginReaderDependencies = Readonly<{
  registry: RegistryIpcServices;
  filesystem?: SkillObservationFilesystem;
  now?: () => number;
}>;

export type SkillVariantManifestSnapshot = Readonly<{
  grant: RegistryGrant;
  observation: ObservedEntry;
  packageRoot: string;
  manifestPath: string;
  manifestBytes: Uint8Array;
  manifestHash: string;
  manifest: PackageManifest;
  rootIdentity: string;
}>;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function physicalRoot(relativeRoot: string): string {
  return relativeRoot === "root" ? "" : relativeRoot;
}

function joinRelative(root: string, child: string): string {
  return root ? `${root}/${child}` : child;
}

function isActiveWorkshop(registry: SourceRegistry, sourceId: string): boolean {
  return (
    activeWorkshop(registry.registry)?.ref.id === sourceId &&
    activeWorkshop(registry.registry)?.availability === "available"
  );
}

export async function readSkillVariantManifestSnapshot(
  source: SourceSkillRef,
  dependencies: SkillVariantOriginReaderDependencies,
): Promise<SkillVariantManifestSnapshot | undefined> {
  const now = dependencies.now ?? Date.now;
  const filesystem = dependencies.filesystem ?? strictSkillObservationFilesystem;
  const registryBefore = await dependencies.registry.listRegistry();
  if (registryBefore.status !== "ready" || !isActiveWorkshop(registryBefore, source.sourceId)) return undefined;
  const grant = await freshGrant(dependencies.registry, { kind: "source", id: source.sourceId }, now);
  if (!grant || !(await currentGrantRoot(grant))) return undefined;
  const observed = await dependencies.registry.observeEntryWithGrant(
    { kind: "source", id: source.sourceId },
    grant.handle,
  );
  if (observed.status !== "observed") return undefined;
  const packages = (observed.observation.inventory.packages ?? []).filter(({ id }) => id === source.packageId);
  if (packages.length !== 1 || packages[0]?.format !== "omni") return undefined;
  const packageRoot = packages[0]!.relativeRoot;
  if (!hasCompleteObservationForLocation(observed, physicalRoot(packageRoot))) return undefined;
  const manifestPath = joinRelative(physicalRoot(packageRoot), "omni.plugin.json");
  if (packages[0]!.manifestPaths.filter((path) => path === manifestPath).length !== 1) return undefined;
  let manifestBytes: Uint8Array;
  try {
    const access = observationGrant(grant);
    const node = await filesystem.lstat(access, manifestPath);
    if (node.kind !== "file" || node.byteLength > 1024 * 1024) return undefined;
    const read = await filesystem.readFile(access, manifestPath, node.identity, 1024 * 1024);
    const after = await filesystem.lstat(access, manifestPath);
    if (
      read.identity !== node.identity ||
      after.identity !== node.identity ||
      after.kind !== "file" ||
      read.bytes.byteLength !== node.byteLength
    )
      return undefined;
    manifestBytes = Uint8Array.from(read.bytes);
  } catch {
    return undefined;
  }
  let manifest: PackageManifest;
  try {
    manifest = parsePackageManifest(JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as unknown);
  } catch {
    return undefined;
  }
  const registryAfter = await dependencies.registry.listRegistry();
  const observationAfter = await dependencies.registry.observeEntryWithGrant(
    { kind: "source", id: source.sourceId },
    grant.handle,
  );
  if (
    registryAfter.status !== "ready" ||
    !isActiveWorkshop(registryAfter, source.sourceId) ||
    !hasCompleteObservationForLocation(observationAfter, physicalRoot(packageRoot)) ||
    grant.expiresAt <= now() ||
    !(await currentGrantRoot(grant)) ||
    JSON.stringify(observationAfter.observation.inventory.packages?.filter(({ id }) => id === source.packageId)) !==
      JSON.stringify(packages)
  )
    return undefined;
  return {
    grant,
    observation: observed,
    packageRoot,
    manifestPath,
    manifestBytes,
    manifestHash: digest(manifestBytes),
    manifest,
    rootIdentity: skillRootIdentity(grant, (value) => createHash("sha256").update(value, "utf8").digest("hex")),
  };
}

export async function readSkillVariantOrigin(
  source: SourceSkillRef,
  dependencies: SkillVariantOriginReaderDependencies,
): Promise<ReadSkillVariantOriginResponse> {
  const snapshot = await readSkillVariantManifestSnapshot(source, dependencies);
  if (!snapshot)
    return { status: "unavailable", reason: "The selected personal source or exact plugin manifest is unavailable." };
  const entries = snapshot.manifest.artifacts.filter(
    (artifact) => artifact.kind === "skill" && artifact.path === source.artifactPath,
  );
  if (!entries.length) return { status: "absent", source };
  if (entries.length !== 1 || !observedSourcePath(snapshot.observation.observation.inventory, source)) {
    return {
      status: "unavailable",
      reason: "The exact skill artifact is missing or ambiguous in its observed plugin.",
    };
  }
  const origin: SkillVariantOrigin | undefined = entries[0]?.variantOrigin;
  return origin ? { status: "ready", source, origin } : { status: "absent", source };
}
