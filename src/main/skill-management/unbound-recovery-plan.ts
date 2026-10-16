import { createHash } from "node:crypto";

import type {
  SkillJournalAction,
  SkillJournalStep,
  SkillOperationJournalRecord,
} from "../../application/skill-management-journal";
import type { SkillLocationKey } from "../../domain/skill-reconciliation/types";
import type { OperationAction } from "../../shared/operations-ipc";
import type { SkillEffectStep } from "../../shared/skill-management-ipc";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import type { BindingsStore } from "../bindings-store";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import { hasCompleteObservationForLocation } from "../skill-reconciliation/location-observation";
import { currentGrantRoot } from "../granted-hashing";
import {
  captureComplete,
  freshGrant,
  observedLocalTarget,
  observationGrant,
  SKILL_SCAN_BUDGET_BYTES,
  skillRootIdentity,
} from "./adoption-reader";
import { revalidateSkillTree } from "../skill-reconciliation/capture-engine";
import { bytesHash } from "./unbound-file-effects";
import { createSkillRevision } from "../../domain/skill-reconciliation/revisions";
import { readSkillDirectoryEnvelope } from "./unbound-reader";
import type { OperationStore } from "../operation-store";
import type { PreparedUnboundPayload } from "./unbound-payload";
import type { SkillDirectoryEnvelope } from "./unbound-reader";
import type { LocalSnapshot } from "./unbound-recovery";

type TreeState = Readonly<{
  files: Map<string, Uint8Array>;
  envelope: Map<string, { path: string; kind: "file" | "directory"; identity: string }>;
}>;
type RecoveryActionPlan = Readonly<{
  inverse: readonly OperationAction[];
  files: SkillEffectStep["files"];
  current: TreeState;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

function identityMap(
  envelope: SkillDirectoryEnvelope,
): Map<string, { path: string; kind: "file" | "directory"; identity: string }> {
  return new Map(envelope.map((entry) => [entry.path, { ...entry }]));
}

function inverseKind(action: OperationAction, beforeBytes: Uint8Array | undefined): SkillJournalAction["kind"] {
  if (action.kind === "create-directory") return "remove-directory";
  if (action.kind === "delete-file") return "write-file";
  return beforeBytes === undefined ? "delete-file" : "write-file";
}

export async function readUnboundRecoveryLocalSnapshot(
  args: Readonly<{
    location: SkillLocationKey;
    registry: RegistryIpcServices;
    relationships: SkillRelationshipStore;
    bindings: BindingsStore;
    filesystem: SkillObservationFilesystem;
    now: () => number;
  }>,
): Promise<LocalSnapshot> {
  const listed = await args.registry.listRegistry();
  if (
    listed.status !== "ready" ||
    !listed.registry.projects.some(
      (entry) =>
        entry.ref.id === args.location.projectId &&
        entry.availability === "available" &&
        entry.archivedAt === undefined,
    )
  )
    throw new Error("The selected project is not active and available for restore.");
  const grant = await freshGrant(args.registry, { kind: "project", id: args.location.projectId }, args.now);
  if (!grant || !(await currentGrantRoot(grant)))
    throw new Error("A fresh unchanged project grant is required for restore.");
  const [observation, relationshipRead, bindingRead] = await Promise.all([
    args.registry.observeEntryWithGrant({ kind: "project", id: args.location.projectId }, grant.handle),
    args.relationships.read(),
    args.bindings.read(),
  ]);
  if (
    !hasCompleteObservationForLocation(observation, args.location.folderPath) ||
    !observedLocalTarget(observation.observation.inventory, args.location)
  )
    throw new Error("The exact selected project copy is no longer safely observed.");
  if (relationshipRead.status !== "ready" || bindingRead.status !== "ready")
    throw new Error("The skill relationship or Binding store is unavailable for restore.");
  const tree = await captureComplete(
    grant,
    args.location.folderPath,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    args.filesystem,
    (value) => createHash("sha256").update(value, "utf8").digest("hex"),
  );
  if (!tree) throw new Error("The current selected project tree is incomplete or unsafe.");
  const firstEnvelope = await readSkillDirectoryEnvelope(grant, args.location.folderPath, args.filesystem);
  const secondEnvelope = await readSkillDirectoryEnvelope(grant, args.location.folderPath, args.filesystem);
  if (
    !firstEnvelope ||
    canonical(firstEnvelope) !== canonical(secondEnvelope) ||
    (await revalidateSkillTree(tree, observationGrant(grant), args.filesystem)).status !== "complete"
  )
    throw new Error("The project directory envelope changed during restore inspection.");
  const [afterObservation, afterRelationships, afterBindings] = await Promise.all([
    args.registry.observeEntryWithGrant({ kind: "project", id: args.location.projectId }, grant.handle),
    args.relationships.read(),
    args.bindings.read(),
  ]);
  if (
    !hasCompleteObservationForLocation(afterObservation, args.location.folderPath) ||
    !observedLocalTarget(afterObservation.observation.inventory, args.location) ||
    afterRelationships.status !== "ready" ||
    afterRelationships.state.revision !== relationshipRead.state.revision ||
    afterBindings.status !== "ready" ||
    canonical(afterBindings.bindings) !== canonical(bindingRead.bindings) ||
    !(await currentGrantRoot(grant))
  )
    throw new Error("Project identity or management changed during restore inspection.");
  return {
    grant,
    tree,
    envelope: firstEnvelope,
    rootIdentity: skillRootIdentity(grant, (value) => createHash("sha256").update(value).digest("hex")),
    relationships: relationshipRead.state,
    bindings: bindingRead.bindings,
  };
}

export function assertSavedPayload(payload: PreparedUnboundPayload, sourceStep: SkillEffectStep): void {
  const evidence = sourceStep.unboundResolutionEvidence!;
  if (
    canonical(payload.index.sourceEnvelope) !== canonical(sourceStep.unboundResolutionEnvelope!.source) ||
    canonical(payload.index.beforeEnvelope) !== canonical(sourceStep.unboundResolutionEnvelope!.local)
  )
    throw new Error("The saved unbound recovery bytes or envelope do not match the approved link step.");
  const sourceRevision = createSkillRevision(
    [...payload.sourceFiles].map(([path, bytes]) => ({ path, hash: bytesHash(bytes), byteLength: bytes.byteLength })),
    (value) => createHash("sha256").update(value, "utf8").digest("hex"),
  );
  const beforeRevision = createSkillRevision(
    [...payload.beforeFiles].map(([path, bytes]) => ({ path, hash: bytesHash(bytes), byteLength: bytes.byteLength })),
    (value) => createHash("sha256").update(value, "utf8").digest("hex"),
  );
  if (
    canonical(sourceRevision) !== canonical(evidence.source.revision) ||
    canonical(beforeRevision) !== canonical(evidence.local.revision)
  )
    throw new Error("The saved source or before-tree bytes no longer match their approved revisions.");
}

export function makeInverseActions(
  args: Readonly<{
    record: SkillOperationJournalRecord;
    sourceStep: SkillEffectStep;
    payload: PreparedUnboundPayload;
    snapshot: LocalSnapshot;
    resumeStep?: SkillJournalStep;
  }>,
): RecoveryActionPlan {
  const { record, sourceStep, payload, snapshot } = args;
  const location = sourceStep.unboundResolutionEvidence!.local.location;
  const sourceProgress = record.steps.find((step) => step.stepId === sourceStep.stepId);
  if (!sourceProgress || !["applied", "recovery-required", "applying", "verifying"].includes(sourceProgress.status))
    throw new Error("The saved link step has no attributable forward effects to restore.");
  if (record.status === "terminal" && record.result?.status !== "applied")
    throw new Error("The original link did not finish successfully; inspect its partial recovery state.");
  const actions = sourceProgress.actions ?? [];
  const expectedFiles = new Map(payload.beforeFiles);
  const expectedEnvelope = identityMap(payload.index.beforeEnvelope);
  const actualFiles = new Map(snapshot.tree.files);
  const actualEnvelope = identityMap(snapshot.envelope);
  const known = new Set<string>(expectedEnvelope.keys());
  const inverse: OperationAction[] = [];
  const temporaryCleanup: OperationAction[] = [];
  const inverseFiles: SkillEffectStep["files"][number][] = [];
  const temporaryFiles: SkillEffectStep["files"][number][] = [];
  const hashOf = (files: ReadonlyMap<string, Uint8Array>, path: string) => {
    const bytes = files.get(path);
    return bytes ? bytesHash(bytes) : undefined;
  };
  for (const action of sourceStep.plan.actions) {
    const path = action.relativePath.slice(location.folderPath.length + 1);
    if (!path || action.relativePath !== `${location.folderPath}/${path}`)
      throw new Error("A saved link action escaped its selected folder.");
    const saved = actions.find(
      (candidate) => candidate.relativePath === action.relativePath && candidate.kind === action.kind,
    );
    const current = actualEnvelope.get(path);
    const before = payload.index.beforeEnvelope.find((entry) => entry.path === path);
    const beforeBytes = payload.beforeFiles.get(path);
    const sourceBytes = payload.sourceFiles.get(path);
    const inverseProgress = args.resumeStep?.actions?.find(
      (candidate) =>
        candidate.relativePath === action.relativePath && candidate.kind === inverseKind(action, beforeBytes),
    );
    const beforeStateOnDisk =
      action.kind === "create-directory"
        ? !current
        : beforeBytes === undefined
          ? !current
          : Boolean(
              current?.kind === "file" &&
              current.identity === before?.identity &&
              hashOf(actualFiles, path) === bytesHash(beforeBytes),
            );
    const afterState =
      action.kind === "create-directory"
        ? Boolean(saved?.identity && current?.kind === "directory" && current.identity === saved.identity)
        : action.kind === "delete-file"
          ? !current
          : Boolean(
              saved?.identity &&
              current?.kind === "file" &&
              current.identity === saved.identity &&
              sourceBytes &&
              hashOf(actualFiles, path) === bytesHash(sourceBytes),
            );
    const restoredState =
      inverseProgress?.identity !== undefined &&
      (action.kind === "create-directory" || (action.kind === "write-file" && beforeBytes === undefined)
        ? !current
        : inverseProgress?.kind === "write-file" &&
          current?.kind === "file" &&
          current.identity === inverseProgress.identity &&
          beforeBytes !== undefined &&
          hashOf(actualFiles, path) === bytesHash(beforeBytes));
    const restoredProgress = inverseProgress?.status === "applied" || inverseProgress?.status === "applying";
    const beforeState = beforeStateOnDisk || (restoredProgress && restoredState);
    if (inverseProgress?.status === "applied" && !restoredState)
      throw new Error(`A completed inverse action no longer has its exact restored state: ${action.relativePath}`);
    if (inverseProgress?.status === "applying" && !restoredState && !afterState)
      throw new Error(`An interrupted inverse action has an unknown file state: ${action.relativePath}`);
    if (!beforeState && !afterState)
      throw new Error(`The link-owned path has an unknown identity or content: ${action.relativePath}`);
    if (saved?.status === "applied" && !afterState && !restoredState)
      throw new Error(`An applied link action is no longer in its exact after-state: ${action.relativePath}`);
    if (restoredState && action.kind === "write-file" && current?.kind === "file")
      expectedEnvelope.set(path, { path, kind: "file", identity: current.identity });
    if (action.kind === "create-directory") {
      known.add(path);
      if (afterState) {
        expectedEnvelope.set(path, { path, kind: "directory", identity: saved!.identity! });
        inverse.push({ kind: "delete-directory", relativePath: action.relativePath });
      }
    } else if (action.kind === "delete-file") {
      known.add(path);
      if (afterState) {
        expectedFiles.delete(path);
        expectedEnvelope.delete(path);
        inverseFiles.push({
          rootId: location.projectId,
          relativePath: action.relativePath,
          change: "add",
          afterHash: bytesHash(beforeBytes!),
        });
        inverse.push({
          kind: "write-file",
          relativePath: action.relativePath,
          afterHash: bytesHash(beforeBytes!),
          byteLength: beforeBytes!.byteLength,
        });
      }
    } else {
      known.add(path);
      if (afterState) {
        const afterBytes = sourceBytes!;
        expectedFiles.set(path, afterBytes);
        expectedEnvelope.set(path, { path, kind: "file", identity: saved!.identity! });
        if (beforeBytes === undefined) {
          inverseFiles.push({
            rootId: location.projectId,
            relativePath: action.relativePath,
            change: "delete",
            beforeHash: bytesHash(afterBytes),
            byteLength: afterBytes.byteLength,
          });
          inverse.push({ kind: "delete-file", relativePath: action.relativePath, beforeHash: bytesHash(afterBytes) });
        } else {
          inverseFiles.push({
            rootId: location.projectId,
            relativePath: action.relativePath,
            change: "change",
            beforeHash: bytesHash(afterBytes),
            afterHash: bytesHash(beforeBytes),
            byteLength: beforeBytes.byteLength,
          });
          inverse.push({
            kind: "write-file",
            relativePath: action.relativePath,
            beforeHash: bytesHash(afterBytes),
            afterHash: bytesHash(beforeBytes),
            byteLength: beforeBytes.byteLength,
          });
        }
      }
    }
    if (saved?.temporaryPath) {
      const temp = saved.temporaryPath.startsWith(`${location.folderPath}/`)
        ? saved.temporaryPath.slice(location.folderPath.length + 1)
        : "";
      const staged = actualEnvelope.get(temp);
      if (staged) {
        const stagedBytes = actualFiles.get(temp);
        if (
          staged.identity !== saved.identity ||
          (action.kind === "write-file" &&
            (!stagedBytes || !sourceBytes || bytesHash(stagedBytes) !== bytesHash(sourceBytes)))
        )
          throw new Error("A staged link temporary has unknown ownership.");
        known.add(temp);
        expectedEnvelope.set(temp, { ...staged });
        if (stagedBytes) expectedFiles.set(temp, stagedBytes);
        inverseFiles.push({
          rootId: location.projectId,
          relativePath: saved.temporaryPath,
          change: "delete",
          ...(stagedBytes ? { beforeHash: bytesHash(stagedBytes), byteLength: stagedBytes.byteLength } : {}),
        });
        inverse.push({
          kind: action.kind === "create-directory" ? "delete-directory" : "delete-file",
          relativePath: saved.temporaryPath,
          ...(stagedBytes ? { beforeHash: bytesHash(stagedBytes) } : {}),
        });
      }
    }
    if (inverseProgress?.status === "applying" && inverseProgress.temporaryPath) {
      const temp = inverseProgress.temporaryPath.startsWith(`${location.folderPath}/`)
        ? inverseProgress.temporaryPath.slice(location.folderPath.length + 1)
        : "";
      const staged = actualEnvelope.get(temp);
      if (staged) {
        const stagedBytes = actualFiles.get(temp);
        if (
          !temp ||
          staged.identity !== inverseProgress.identity ||
          !stagedBytes ||
          !beforeBytes ||
          bytesHash(stagedBytes) !== bytesHash(beforeBytes)
        )
          throw new Error("An interrupted inverse temporary has unknown ownership or content.");
        known.add(temp);
        expectedEnvelope.set(temp, { ...staged });
        expectedFiles.set(temp, stagedBytes);
        temporaryFiles.push({
          rootId: location.projectId,
          relativePath: inverseProgress.temporaryPath,
          change: "delete",
          afterHash: bytesHash(stagedBytes),
        });
        temporaryCleanup.push({
          kind: "delete-file",
          relativePath: inverseProgress.temporaryPath,
          beforeHash: bytesHash(stagedBytes),
        });
      }
    }
  }
  for (const entry of snapshot.envelope)
    if (!known.has(entry.path)) throw new Error(`The selected copy contains unreviewed content: ${entry.path}`);
  const expectedEnvelopeSorted = [...expectedEnvelope.values()].sort((a, b) => a.path.localeCompare(b.path));
  const actualEnvelopeSorted = [...actualEnvelope.values()].sort((a, b) => a.path.localeCompare(b.path));
  const envelopeMatches = canonical(expectedEnvelopeSorted) === canonical(actualEnvelopeSorted);
  const fileMatches =
    expectedFiles.size === actualFiles.size &&
    [...expectedFiles].every(([path, bytes]) => {
      const current = actualFiles.get(path);
      return current !== undefined && bytesHash(bytes) === bytesHash(current);
    });
  if (!envelopeMatches || !fileMatches) {
    const extra = actualEnvelopeSorted
      .filter((entry) => !expectedEnvelope.has(entry.path))
      .map((entry) => `+${entry.path}`);
    const missing = expectedEnvelopeSorted
      .filter((entry) => !actualEnvelope.has(entry.path))
      .map((entry) => `-${entry.path}`);
    const identities = expectedEnvelopeSorted.flatMap((entry) => {
      const actual = actualEnvelope.get(entry.path);
      return actual && actual.identity !== entry.identity ? [`~${entry.path}`] : [];
    });
    const bytes = [...new Set([...expectedFiles.keys(), ...actualFiles.keys()])]
      .filter((path) => {
        const left = expectedFiles.get(path);
        const right = actualFiles.get(path);
        return !left || !right || bytesHash(left) !== bytesHash(right);
      })
      .map((path) => `!${path}`);
    throw new Error(
      `The current selected tree is not an exact known before/after state (${[...extra, ...missing, ...identities, ...bytes].join(", ")}).`,
    );
  }
  return {
    inverse: [...temporaryCleanup, ...inverse].sort((left, right) => {
      if (left.kind !== "delete-directory" && right.kind !== "delete-directory") return 0;
      if (left.kind !== "delete-directory") return -1;
      if (right.kind !== "delete-directory") return 1;
      return right.relativePath.split("/").length - left.relativePath.split("/").length;
    }),
    files: [...temporaryFiles, ...inverseFiles],
    current: { files: actualFiles, envelope: actualEnvelope },
  };
}
