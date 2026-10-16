import { WORKSPACE_SKILL_USES_CHANNEL, parseWorkspaceSkillUsesResponse } from "../../shared/workspace-skill-uses-ipc";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { ipcMain } from "electron";

import { createSkillReconciliationService } from "../../application/skill-reconciliation";
import { createSkillCopyComparisonService } from "../../application/skill-copy-comparison";
import type {
  SkillCopyLocationRead,
  SkillDeclaration,
  SkillLocationKey,
  SkillMember,
  SkillManagedAttention,
} from "../../domain/skill-reconciliation/types";
import { revisionsEqual } from "../../domain/skill-reconciliation/revisions";
import type { SkillManagedBaseReader, SkillRelationshipStore } from "../../ports/skill-reconciliation";
import {
  hasCompleteObservationForLocation,
  observationIssueForLocation,
  unscopedObservationIssue,
} from "./location-observation";
import { currentGrantRoot } from "../granted-hashing";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import {
  SKILL_RECONCILIATION_IPC_CHANNELS,
  parseObserveSkillCopiesRequest,
  parseObserveSkillCopiesResponse,
  type ObserveSkillCopiesRequest,
  type ObserveSkillCopiesResponse,
} from "../../shared/skill-reconciliation-ipc";
import {
  SKILL_COPY_COMPARISON_CHANNEL,
  parseSkillCopyComparisonRequest,
  parseSkillCopyComparisonResponse,
  type SkillCopyComparisonRequest,
  type SkillCopyComparisonResponse,
} from "../../shared/skill-copy-comparison-ipc";
import type { SkillObservationGrant } from "../../ports/skill-reconciliation";
import { strictSkillObservationFilesystem } from "./filesystem";
import { observeCompleteSkillTree, type SkillScanBudget } from "./observe";
import { createSkillRelationshipStore } from "./store";
import { createSkillCopyComparisonReader } from "./comparison";
import { createSkillBaseStore } from "./bases";

const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_OBSERVED_LOCATIONS = 1024;
type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;
type Clock = () => number;
type Options = Readonly<{
  userDataPath: string;
  now?: Clock;
  store?: SkillRelationshipStore;
  baseReader?: SkillManagedBaseReader;
}>;
type PendingMember = Readonly<{ location: SkillLocationKey; ref: SkillMember["ref"]; declaration?: SkillDeclaration }>;
type PendingGroup = Readonly<{ groupId: string; members: readonly PendingMember[] }>;

function sameProject(grant: RegistryGrant, projectId: string, now: Clock): boolean {
  return grant.subject.kind === "project" && grant.subject.id === projectId && grant.expiresAt > now();
}

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function parseFolderPath(relativePath: string): SkillLocationKey["folderPath"] | undefined {
  const match = /^(\.agents|\.claude|\.cursor)\/skills\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/SKILL\.md$/u.exec(
    relativePath,
  );
  return match ? `${match[1]}/skills/${match[2]}` : undefined;
}

function harnessFor(relativePath: string): SkillLocationKey["harnessId"] | undefined {
  if (relativePath.startsWith(".agents/skills/")) return "codex";
  if (relativePath.startsWith(".claude/skills/")) return "claude-code";
  if (relativePath.startsWith(".cursor/skills/")) return "cursor";
  return undefined;
}

function declaredOrigin(
  observation: Extract<
    Awaited<ReturnType<RegistryIpcServices["observeEntryWithGrant"]>>,
    { status: "observed" }
  >["observation"],
  artifactId: string,
  relativePath: string,
  folderPath: string,
): SkillDeclaration | undefined {
  const origin = observation.inventory.skillOrigins?.find(
    (candidate) => candidate.artifactId === artifactId && candidate.relativePath === relativePath,
  );
  if (!origin) return undefined;
  return {
    locator: origin.source.locator,
    skillKey: origin.skillKey ?? folderPath.split("/").at(-1) ?? "",
    ...(origin.sourceSkillPath ? { upstreamPath: origin.sourceSkillPath } : {}),
  };
}

function pendingGroups(
  request: ObserveSkillCopiesRequest,
  observation: Extract<
    Awaited<ReturnType<RegistryIpcServices["observeEntryWithGrant"]>>,
    { status: "observed" }
  >["observation"],
): readonly PendingGroup[] {
  const packagedArtifacts = new Set((observation.inventory.packages ?? []).flatMap((pkg) => pkg.artifactIds));
  return request.groups.map((group) => ({
    groupId: group.groupId,
    members: group.members.flatMap((requested): PendingMember[] => {
      const folder = parseFolderPath(requested.relativePath);
      const harnessId = harnessFor(requested.relativePath);
      if (!folder || !harnessId) return [];
      const artifact = observation.inventory.artifacts.find(
        (candidate) =>
          candidate.id === requested.ref.artifactId &&
          candidate.kind === "skill" &&
          candidate.projectionPaths.includes(requested.relativePath) &&
          !candidate.packageId &&
          !packagedArtifacts.has(candidate.id),
      );
      if (!artifact) return [];
      const location = { projectId: request.projectId, harnessId, folderPath: folder };
      const declaration = declaredOrigin(observation, artifact.id, requested.relativePath, folder);
      return [{ location, ref: requested.ref, ...(declaration ? { declaration } : {}) }];
    }),
  }));
}

function grantedObservation(grant: RegistryGrant): SkillObservationGrant {
  return {
    root: grant.root,
    subject: grant.subject as SkillObservationGrant["subject"],
    device: grant.device,
    inode: grant.inode,
    expiresAt: grant.expiresAt,
  };
}

async function readProjectLocations(
  currentGroups: readonly PendingGroup[],
  remembered: readonly SkillLocationKey[],
  grant: SkillObservationGrant,
  inventory: Extract<
    Awaited<ReturnType<RegistryIpcServices["observeEntryWithGrant"]>>,
    { status: "observed" }
  >["observation"]["inventory"],
): Promise<Readonly<{ reads: readonly SkillCopyLocationRead[]; remainingBytes: number }> | undefined> {
  const byLocation = new Map<string, SkillLocationKey>();
  for (const group of currentGroups) {
    for (const member of group.members) byLocation.set(locationKey(member.location), member.location);
  }
  for (const location of remembered) byLocation.set(locationKey(location), location);
  if (byLocation.size > MAX_OBSERVED_LOCATIONS) return undefined;

  const budget: SkillScanBudget = { remainingBytes: MAX_SCAN_BYTES };
  const locations = [...byLocation.values()].sort((left, right) => locationKey(left).localeCompare(locationKey(right)));
  const reads: SkillCopyLocationRead[] = [];
  for (const location of locations) {
    const read = observationIssueForLocation(inventory, location.folderPath)
      ? { status: "unavailable" as const, reason: "unsafe-tree" as const }
      : await observeCompleteSkillTree(
          grant,
          location.folderPath,
          budget,
          strictSkillObservationFilesystem,
          (manifest) => createHash("sha256").update(manifest, "utf8").digest("hex"),
        );
    reads.push({ location, read });
  }
  return { reads, remainingBytes: budget.remainingBytes };
}

async function readManagedAttention(
  projectId: string,
  uses: readonly import("../../domain/skill-reconciliation/types").ManagedSkillUse[],
  reads: readonly SkillCopyLocationRead[],
  remainingBytes: number,
  bases: SkillManagedBaseReader,
): Promise<readonly SkillManagedAttention[]> {
  const readByLocation = new Map(reads.map((item) => [locationKey(item.location), item.read]));
  const baseReads = new Map<string, Awaited<ReturnType<SkillManagedBaseReader["read"]>>>();
  const result: SkillManagedAttention[] = [];
  let remaining = remainingBytes;
  for (const use of uses.filter((item) => item.location.projectId === projectId)) {
    const local = readByLocation.get(locationKey(use.location));
    if (!local || local.status !== "complete" || remaining <= 0) {
      result.push({ skillId: use.skillId, location: use.location, state: "unavailable" });
      continue;
    }
    let base = baseReads.get(use.baseRevisionId);
    if (!base) {
      base = await bases.read(use.baseRevisionId, remaining);
      baseReads.set(use.baseRevisionId, base);
      if (base.status === "ready") {
        const byteLength = [...base.files.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
        if (byteLength > remaining) {
          remaining = 0;
          base = { status: "corrupt", reason: "Base exceeds the observation byte budget." };
          baseReads.set(use.baseRevisionId, base);
        } else remaining -= byteLength;
      }
    }
    result.push({
      skillId: use.skillId,
      location: use.location,
      state:
        base.status === "ready"
          ? revisionsEqual(local.revision, base.revision)
            ? "matches-base"
            : "local-change"
          : "unavailable",
    });
  }
  return result;
}

function hydrateGroups(
  groups: readonly PendingGroup[],
  reads: readonly SkillCopyLocationRead[],
): readonly Readonly<{ groupId: string; members: readonly SkillMember[] }>[] {
  const readByLocation = new Map(reads.map((locationRead) => [locationKey(locationRead.location), locationRead.read]));
  return groups.map((group) => ({
    groupId: group.groupId,
    members: group.members.map((member) => ({
      ...member,
      read: readByLocation.get(locationKey(member.location)) ?? { status: "unavailable", reason: "io" },
    })),
  }));
}

export async function observeProjectCopies(
  request: ObserveSkillCopiesRequest,
  registry: RegistryIpcServices,
  store: SkillRelationshipStore,
  bases: SkillManagedBaseReader,
  now: Clock,
): Promise<ObserveSkillCopiesResponse> {
  const grant = registry.get(request.grantHandle);
  if (!grant || !sameProject(grant, request.projectId, now)) return { status: "unavailable", reason: "grant" };
  if (!(await currentGrantRoot(grant))) return { status: "unavailable", reason: "root" };
  const observed = await registry.observeEntryWithGrant(
    { kind: "project", id: request.projectId },
    request.grantHandle,
  );
  if (observed.status !== "observed") {
    return {
      status: "unavailable",
      reason: observed.status === "inaccessible" || observed.status === "missing" ? "root" : "observation",
    };
  }
  if (unscopedObservationIssue(observed.observation.inventory)) return { status: "unavailable", reason: "observation" };
  const stored = await store.read();
  if (stored.status === "corrupt") return { status: "unavailable", reason: "store" };
  const remembered = stored.state.skills.flatMap((record) =>
    record.locations.filter((location) => location.projectId === request.projectId),
  );
  const pending = pendingGroups(request, observed.observation);
  const observedReads = await readProjectLocations(
    pending,
    remembered,
    grantedObservation(grant),
    observed.observation.inventory,
  );
  if (!observedReads) return { status: "unavailable", reason: "observation" };
  const reads = observedReads.reads;
  if (!(await currentGrantRoot(grant)) || grant.expiresAt <= now()) return { status: "unavailable", reason: "root" };
  const service = createSkillReconciliationService({ store, allocateId: randomUUID });
  const response = await service.observeProject(
    request.projectId,
    hydrateGroups(pending, reads),
    reads,
    stored.state.revision,
  );
  if (response.status !== "ready") return response;
  const managedAttention = await readManagedAttention(
    request.projectId,
    response.managedUses,
    reads,
    observedReads.remainingBytes,
    bases,
  );
  if (!(await currentGrantRoot(grant)) || grant.expiresAt <= now()) return { status: "unavailable", reason: "root" };
  return { ...response, managedAttention };
}

async function compareCopies(
  request: SkillCopyComparisonRequest,
  registry: RegistryIpcServices,
  store: SkillRelationshipStore,
  now: Clock,
  reader: ReturnType<typeof createSkillCopyComparisonReader>,
): Promise<SkillCopyComparisonResponse> {
  const grant = registry.get(request.grantHandle);
  if (!grant || !sameProject(grant, request.projectId, now)) return { status: "unavailable", reason: "grant" };
  if (!(await currentGrantRoot(grant))) return { status: "unavailable", reason: "root" };
  const observed = await registry.observeEntryWithGrant(
    { kind: "project", id: request.projectId },
    request.grantHandle,
  );
  if (observed.status !== "observed") {
    return {
      status: "unavailable",
      reason: observed.status === "inaccessible" || observed.status === "missing" ? "root" : "read",
    };
  }
  if (
    !hasCompleteObservationForLocation(observed, request.a.folderPath) ||
    !hasCompleteObservationForLocation(observed, request.b.folderPath)
  )
    return { status: "unavailable", reason: "read" };
  if (!(await currentGrantRoot(grant)) || grant.expiresAt <= now()) return { status: "unavailable", reason: "root" };
  const service = createSkillCopyComparisonService({ store, reader });
  const response = await service.readComparison(request, grantedObservation(grant));
  if (!(await currentGrantRoot(grant)) || grant.expiresAt <= now()) return { status: "unavailable", reason: "root" };
  return response;
}

export function registerSkillReconciliationIpcHandlers(
  assertTrustedSender: SenderGuard,
  registry: RegistryIpcServices,
  options: Options,
): void {
  const now = options.now ?? Date.now;
  const store =
    options.store ?? createSkillRelationshipStore(join(options.userDataPath, "omni", "skill-relationships.json"));
  const bases = options.baseReader ?? createSkillBaseStore(options.userDataPath);
  ipcMain.handle(WORKSPACE_SKILL_USES_CHANNEL, async (event, request: unknown) => {
    assertTrustedSender(event);
    if (request !== undefined) throw new Error("Workspace relationship reads do not accept a request.");
    try {
      const result = await store.read();
      return parseWorkspaceSkillUsesResponse(
        result.status === "ready" ? { status: "ready", uses: result.state.uses } : { status: "unavailable" },
      );
    } catch {
      return { status: "unavailable" };
    }
  });
  ipcMain.handle(SKILL_RECONCILIATION_IPC_CHANNELS.observe, async (event, rawRequest: unknown) => {
    assertTrustedSender(event);
    let request: ObserveSkillCopiesRequest;
    try {
      request = parseObserveSkillCopiesRequest(rawRequest);
    } catch {
      throw new Error("Skill observation request is invalid.");
    }
    try {
      return parseObserveSkillCopiesResponse(await observeProjectCopies(request, registry, store, bases, now));
    } catch {
      return { status: "unavailable", reason: "observation" } satisfies ObserveSkillCopiesResponse;
    }
  });
  const comparisonReader = createSkillCopyComparisonReader();
  ipcMain.handle(SKILL_COPY_COMPARISON_CHANNEL, async (event, rawRequest: unknown) => {
    assertTrustedSender(event);
    let request: SkillCopyComparisonRequest;
    try {
      request = parseSkillCopyComparisonRequest(rawRequest);
    } catch {
      throw new Error("Skill copy comparison request is invalid.");
    }
    try {
      return parseSkillCopyComparisonResponse(await compareCopies(request, registry, store, now, comparisonReader));
    } catch {
      return { status: "unavailable", reason: "read" } satisfies SkillCopyComparisonResponse;
    }
  });
}
