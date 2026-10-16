import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { artifactName } from "../domain/identity";
import { resolveTarget, type HarnessId, type TargetKind } from "../domain/harness-targets";
import type { AssignmentUnit, Binding, TargetEvidence } from "../domain/assignment-plan";
import type { EntryRef, RegistryState } from "../domain/project-source-registry";
import type { RegistryGrant, RegistryGrantStore } from "./registry-ipc";
import { currentGrantRoot, hashGrantedPath, observeGrantedTarget, resolveGrantedPath } from "./granted-hashing";

export type ResolvedUnitFile = Readonly<{ relativePath: string; contentHash: string; content: Uint8Array }>;
export type ResolvedUnit = Readonly<{
  unit: AssignmentUnit;
  sourceRelativePath: string;
  files: readonly ResolvedUnitFile[];
}>;

export function sameRef(left: EntryRef, right: EntryRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}
export function grantFor(grants: RegistryGrantStore, subject: EntryRef, handle: string): RegistryGrant | undefined {
  const grant = grants.get(handle);
  return grant && sameRef(grant.subject, subject) ? grant : undefined;
}
export function activeRegistration(state: RegistryState, kind: "project" | "source", id: string) {
  return (kind === "project" ? state.projects : state.sources).find(
    (record) => record.id === id && record.archivedAt === undefined,
  );
}
export function inferKind(path: string): TargetKind {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").includes("skills")) return "skill";
  if (normalized.split("/").includes("commands")) return "command";
  if (normalized.split("/").includes("agents")) return "agent";
  if (normalized.split("/").includes("hooks") || normalized.endsWith("hooks.json")) return "hook";
  if (normalized.includes("mcp") || normalized.endsWith("mcp.json")) return "mcp-config";
  return "instruction";
}
export function unitId(kind: TargetKind, artifactPath: string): string {
  return artifactName({ kind, provenance: { relativePath: artifactPath } });
}
export function virtualBindingId(
  projectId: string,
  harnessId: HarnessId,
  packageId: string,
  artifactPath: string,
): string {
  return `preview-${createHash("sha256").update(`${projectId}\n${harnessId}\n${packageId}\n${artifactPath}`, "utf8").digest("hex").slice(0, 32)}`;
}

async function selectSourcePath(
  grant: RegistryGrant,
  packageId: string,
  artifactPath: string,
): Promise<{ path: string; relativePath: string } | undefined> {
  for (const candidate of [`${packageId}/${artifactPath}`, artifactPath]) {
    const resolved = await resolveGrantedPath(grant, candidate);
    if (resolved !== "denied" && resolved !== "unavailable") return { path: resolved, relativePath: candidate };
  }
  return undefined;
}

async function fileBytes(grant: RegistryGrant, relativePath: string): Promise<Uint8Array> {
  const path = await resolveGrantedPath(grant, relativePath);
  if (path === "denied" || path === "unavailable") throw new Error("Marketplace unit is unavailable.");
  return readFile(path);
}

export async function resolveUnitFromGrant(
  grant: RegistryGrant,
  packageId: string,
  artifactPath: string,
): Promise<ResolvedUnit | undefined> {
  const selected = await selectSourcePath(grant, packageId, artifactPath);
  if (!selected) return undefined;
  const kind = inferKind(artifactPath);
  const selectedUnit =
    kind === "skill" && basename(selected.relativePath) === "SKILL.md"
      ? { path: dirname(selected.path), relativePath: dirname(selected.relativePath) }
      : selected;
  const hashed = await hashGrantedPath(grant, selectedUnit.relativePath);
  if (hashed.status !== "hashed") return undefined;
  const isFolder = kind === "skill" || hashed.files !== undefined;
  const files = isFolder
    ? await Promise.all(
        (hashed.files ?? []).map(async (file) => ({
          ...file,
          content: await fileBytes(grant, `${selectedUnit.relativePath}/${file.relativePath}`),
        })),
      )
    : [
        {
          relativePath: "",
          contentHash: hashed.contentHash,
          content: await fileBytes(grant, selectedUnit.relativePath),
        },
      ];
  const unit: AssignmentUnit = {
    kind,
    id: unitId(kind, artifactPath),
    contentHash: hashed.contentHash,
    ...(isFolder ? { files: hashed.files ?? [] } : {}),
  };
  return { unit, sourceRelativePath: selectedUnit.relativePath, files };
}

export async function resolveUnitFromRoot(
  root: string,
  packageId: string,
  artifactPath: string,
): Promise<ResolvedUnit | undefined> {
  const canonical = await realpath(root);
  const details = await stat(canonical);
  const grant: RegistryGrant = {
    handle: "internal-source",
    subject: { kind: "source", id: "internal" },
    root: canonical,
    device: String(details.dev),
    inode: String(details.ino),
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  return resolveUnitFromGrant(grant, packageId, artifactPath);
}

// Provider-managed state is decided by path confinement: a target whose real path leaves the
// project root (a symlink into a provider cache) is denied by the grant and reported as managed.
export async function observeTarget(
  grant: RegistryGrant,
  unit: AssignmentUnit,
  harnessId: HarnessId,
): Promise<TargetEvidence> {
  const resolved = resolveTarget({ kind: unit.kind, id: unit.id, harnessId });
  if (resolved.status === "blocked")
    return { harnessId, relativePath: "blocked", exists: false, providerManaged: false };
  const observed = await observeGrantedTarget(grant, resolved.relativePath, resolved.unit);
  if (observed.status === "denied")
    return { harnessId, relativePath: resolved.relativePath, exists: true, providerManaged: true };
  if (observed.status !== "observed")
    return { harnessId, relativePath: resolved.relativePath, exists: false, providerManaged: false };
  return {
    harnessId,
    relativePath: resolved.relativePath,
    exists: observed.exists,
    ...(observed.contentHash ? { contentHash: observed.contentHash } : {}),
    ...(observed.symlinkTarget ? { symlinkTarget: observed.symlinkTarget } : {}),
    providerManaged: false,
  };
}

export function candidateBindings(
  projectId: string,
  harnessIds: readonly HarnessId[],
  sourceId: string,
  packageId: string,
  artifactPath: string,
  unit: AssignmentUnit,
  existing: readonly Binding[],
): Binding[] {
  return harnessIds.map(
    (harnessId) =>
      existing.find(
        (binding) =>
          binding.sourceId === sourceId &&
          binding.packageId === packageId &&
          binding.artifactPath === artifactPath &&
          binding.kind === unit.kind &&
          binding.projectId === projectId &&
          binding.harnessId === harnessId,
      ) ?? {
        bindingId: virtualBindingId(projectId, harnessId, packageId, artifactPath),
        sourceId,
        packageId,
        artifactPath,
        kind: unit.kind,
        projectId,
        harnessId,
        boundHash: unit.contentHash,
        createdAt: "1970-01-01T00:00:00.000Z",
      },
  );
}

export function sourceBasename(unit: ResolvedUnit): string {
  return basename(unit.sourceRelativePath);
}
