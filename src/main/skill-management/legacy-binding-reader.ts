import { createHash, randomUUID } from "node:crypto";
import type { Binding } from "../../domain/assignment-plan";
import {
  legacyBindingLocation,
  skillLocationIdentity,
  type LegacyBindingCopy,
} from "../../domain/skill-reconciliation/legacy-binding-bridge";
import type { SourceSkillRef, SkillRelationshipsState } from "../../domain/skill-reconciliation/types";
import type { SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import { currentGrantRoot, hashGrantedPath } from "../granted-hashing";
import { captureSkillTree, revalidateSkillTree, type SkillTreeCapture } from "../skill-reconciliation/capture-engine";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";
import { resolveLegacyBindingSource } from "./legacy-binding-source";
import { LegacyBridgeDiagnostics, bridgeErrorMessage } from "./legacy-binding-diagnostics";
import { freshGrant, observationGrant, SKILL_SCAN_BUDGET_BYTES } from "./adoption-reader";

type CompleteTree = Extract<SkillTreeCapture, { status: "complete" }>;
export type LegacyCopyCapture = Readonly<{ copy: LegacyBindingCopy; grant: RegistryGrant; tree?: CompleteTree }>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function receiptProvesTree(
  binding: Binding,
  folderPath: string,
  tree: CompleteTree,
  receipts: readonly OperationReceipt[],
): boolean {
  if (!binding.ownedHash || tree.revision.files.find(({ path }) => path === "SKILL.md")?.hash !== binding.ownedHash)
    return false;
  const receipt = receipts.find(
    (candidate) =>
      candidate.kind === "apply-plan" &&
      candidate.status === "applied" &&
      !candidate.restored &&
      candidate.project?.id === binding.projectId &&
      candidate.bindings?.some(({ after }) => after && JSON.stringify(after) === JSON.stringify(binding)),
  );
  if (!receipt) return false;
  const files = receipt.files?.filter(({ relativePath }) => relativePath.startsWith(`${folderPath}/`)) ?? [];
  return (
    files.length === tree.revision.files.length &&
    new Set(files.map(({ relativePath }) => relativePath)).size === files.length &&
    tree.revision.files.every(({ path, hash }) =>
      files.some(({ relativePath, contentHash }) => relativePath === `${folderPath}/${path}` && contentHash === hash),
    )
  );
}

async function provesCompleteOwnership(
  binding: Binding,
  grant: RegistryGrant,
  tree: CompleteTree,
  receipts: readonly OperationReceipt[],
): Promise<boolean> {
  // The legacy hasher may omit large files or follow links. Its ownership hash is evidence
  // only when its entire file manifest agrees with the independently captured strict tree.
  const legacy = await hashGrantedPath(grant, tree.folderPath);
  const complete =
    legacy.status === "hashed" &&
    binding.ownedHash === legacy.contentHash &&
    legacy.files?.length === tree.revision.files.length &&
    tree.revision.files.every(({ path, hash }) =>
      legacy.files?.some(({ relativePath, contentHash }) => relativePath === path && contentHash === hash),
    );
  return complete || receiptProvesTree(binding, tree.folderPath, tree, receipts);
}

async function captureLegacyCopy(
  binding: Binding,
  source: SourceSkillRef,
  grant: RegistryGrant,
  receipts: readonly OperationReceipt[],
  filesystem: SkillObservationFilesystem,
): Promise<LegacyCopyCapture | undefined> {
  const location = legacyBindingLocation(binding)!;
  try {
    const node = await filesystem.lstat(observationGrant(grant), location.folderPath);
    if (node.kind !== "directory") return undefined;
  } catch {
    return undefined;
  }
  const tree = await captureSkillTree(
    observationGrant(grant),
    location.folderPath,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    filesystem,
    sha256,
  );
  const baseAvailable = tree.status === "complete" && (await provesCompleteOwnership(binding, grant, tree, receipts));
  return {
    grant,
    ...(tree.status === "complete" ? { tree } : {}),
    copy: {
      binding,
      location,
      source,
      baseRevisionId: randomUUID(),
      ...(baseAvailable ? {} : { baseUnavailable: true }),
    },
  };
}

type ReadCopiesDependencies = Readonly<{
  registry: RegistryIpcServices;
  bindings: readonly Binding[];
  relationships: SkillRelationshipsState;
  receipts: readonly OperationReceipt[];
  diagnostics: LegacyBridgeDiagnostics;
  filesystem?: SkillObservationFilesystem;
  now?: () => number;
}>;
type SourceObservations = Map<string, Awaited<ReturnType<RegistryIpcServices["observeEntryWithGrant"]>>>;
type ReadyRegistry = Extract<Awaited<ReturnType<RegistryIpcServices["listRegistry"]>>, { status: "ready" }>;

async function normalizeLegacyGroup(
  bindings: readonly Binding[],
  registry: ReadyRegistry,
  args: ReadCopiesDependencies,
  inventories: SourceObservations,
  now: () => number,
): Promise<Readonly<{ binding: Binding; source: SourceSkillRef }> | undefined> {
  const normalized: Array<Readonly<{ binding: Binding; source: SourceSkillRef }>> = [];
  for (const binding of bindings) {
    const source = registry.registry.sources.find(({ ref }) => ref.id === binding.sourceId);
    if (!source || source.archivedAt !== undefined || source.availability !== "available") {
      args.diagnostics.skip(
        bindings,
        "source-unavailable",
        "The registered source is missing, archived or inaccessible.",
      );
      return undefined;
    }
    if (!inventories.has(source.ref.id)) {
      const sourceGrant = await freshGrant(args.registry, source.ref, now);
      if (!sourceGrant || !(await currentGrantRoot(sourceGrant))) {
        args.diagnostics.skip(bindings, "source-unavailable", "Fresh access to the current source is unavailable.");
        return undefined;
      }
      inventories.set(source.ref.id, await args.registry.observeEntryWithGrant(source.ref, sourceGrant.handle));
    }
    const observed = inventories.get(source.ref.id)!;
    if (observed.status !== "observed") {
      args.diagnostics.skip(bindings, "source-unavailable", "The current source inventory could not be read.");
      return undefined;
    }
    const resolved = resolveLegacyBindingSource(binding, observed.observation.inventory);
    if (resolved.status !== "resolved") {
      args.diagnostics.skip(bindings, resolved.code, resolved.message);
      return undefined;
    }
    normalized.push({ binding, source: resolved.source });
  }
  if (new Set(normalized.map(({ source }) => JSON.stringify(source))).size !== 1) {
    args.diagnostics.skip(
      bindings,
      "source-conflict",
      "Different current source skills claim the same installed location.",
    );
    return undefined;
  }
  args.diagnostics.duplicateBindings += normalized.length - 1;
  normalized.sort(
    (a, b) =>
      Number(Boolean(b.binding.ownedHash)) - Number(Boolean(a.binding.ownedHash)) ||
      b.binding.createdAt.localeCompare(a.binding.createdAt) ||
      a.binding.bindingId.localeCompare(b.binding.bindingId),
  );
  return normalized[0];
}

export async function readLegacyBindingCopies(args: ReadCopiesDependencies): Promise<readonly LegacyCopyCapture[]> {
  let registry: Awaited<ReturnType<RegistryIpcServices["listRegistry"]>>;
  try {
    registry = await args.registry.listRegistry();
  } catch (error: unknown) {
    args.diagnostics.issue("registry-unavailable", bridgeErrorMessage(error));
    for (const binding of args.bindings)
      args.diagnostics.skip(
        [binding],
        "registry-unavailable",
        "The registered project and source could not be inspected.",
      );
    return [];
  }
  if (registry.status !== "ready") {
    args.diagnostics.issue("registry-unavailable", "Registry is unreadable; reopen Omni and inspect its registry.");
    for (const binding of args.bindings)
      args.diagnostics.skip(
        [binding],
        "registry-unavailable",
        "The registered project and source could not be inspected.",
      );
    return [];
  }
  const filesystem = args.filesystem ?? strictSkillObservationFilesystem;
  const now = args.now ?? Date.now;
  const claimed = new Map<string, Binding[]>();
  for (const binding of args.bindings) {
    const location = legacyBindingLocation(binding);
    if (!location) {
      if (binding.kind === "skill")
        args.diagnostics.skip([binding], "target-unavailable", "This harness has no conventional skill target.");
      continue;
    }
    const key = skillLocationIdentity(location);
    claimed.set(key, [...(claimed.get(key) ?? []), binding]);
  }
  const captures: LegacyCopyCapture[] = [];
  const grants = new Map<string, RegistryGrant | undefined>();
  const inventories = new Map<string, Awaited<ReturnType<RegistryIpcServices["observeEntryWithGrant"]>>>();
  for (const [key, bindings] of claimed) {
    try {
      if (args.relationships.uses.some(({ location }) => skillLocationIdentity(location) === key)) {
        args.diagnostics.alreadyManagedLocations++;
        continue;
      }
      const projectId = bindings[0]!.projectId;
      const project = registry.registry.projects.find(({ ref }) => ref.id === projectId);
      if (!project || project.archivedAt !== undefined || project.availability !== "available") {
        args.diagnostics.skip(
          bindings,
          "project-unavailable",
          "The registered project is missing, archived or inaccessible.",
        );
        continue;
      }
      if (!grants.has(projectId))
        grants.set(projectId, await freshGrant(args.registry, { kind: "project", id: projectId }, now));
      const grant = grants.get(projectId);
      if (!grant || !(await currentGrantRoot(grant))) {
        args.diagnostics.skip(bindings, "project-unavailable", "The project root is missing, changed or inaccessible.");
        continue;
      }
      const selected = await normalizeLegacyGroup(bindings, registry, args, inventories, now);
      if (!selected) continue;
      const capture = await captureLegacyCopy(selected.binding, selected.source, grant, args.receipts, filesystem);
      if (capture) captures.push(capture);
      else
        args.diagnostics.skip(
          bindings,
          "copy-unavailable",
          "The installed copy is missing, inaccessible or is not a physical skill folder.",
        );
    } catch (error: unknown) {
      args.diagnostics.skip(bindings, "observation-failed", bridgeErrorMessage(error));
    }
  }
  return captures;
}

export async function verifyLegacyBindingCopies(
  captures: readonly LegacyCopyCapture[],
  filesystem: SkillObservationFilesystem = strictSkillObservationFilesystem,
  now: () => number = Date.now,
  registry?: RegistryIpcServices,
): Promise<void> {
  for (const { copy, grant, tree } of captures) {
    const fresh = registry ? await freshGrant(registry, { kind: "project", id: copy.location.projectId }, now) : grant;
    if (
      !fresh ||
      fresh.root !== grant.root ||
      fresh.device !== grant.device ||
      fresh.inode !== grant.inode ||
      grant.expiresAt <= now() ||
      !(await currentGrantRoot(grant)) ||
      (tree && (await revalidateSkillTree(tree, observationGrant(grant), filesystem)).status !== "complete")
    )
      throw new Error(
        `Legacy copy evidence changed for project ${copy.location.projectId}, ${copy.location.harnessId}, ${copy.location.folderPath}; retry the bridge with fresh evidence.`,
      );
  }
}
