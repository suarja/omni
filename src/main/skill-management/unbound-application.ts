import { createHash } from "node:crypto";

import type { SkillJournalAction } from "../../application/skill-management-journal";
import { actionReceipts, makeReceipt, resultLink } from "./unbound-results";
import { createSkillRevision } from "../../domain/skill-reconciliation/revisions";
import type { ManagedSkillUse, SkillLocationKey } from "../../domain/skill-reconciliation/types";
import type { SkillEffectOutcome, SkillStepProgress } from "../../application/skill-management";
import type { SkillEffectStep } from "../../shared/skill-management-ipc";
import type { SkillUnboundResolutionEvidence } from "../../shared/skill-unbound-resolution-effects";
import type { OperationActionReceipt, OperationReceipt } from "../../shared/operations-ipc";
import type { SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import { readSkillUnboundResolutionSnapshot, type SkillUnboundResolutionSnapshot } from "./unbound-reader";
import type { PreparedUnboundPayload } from "./unbound-payload";
import { createOwnedDirectory, deleteOwnedFile, bytesHash, writeOwnedFile } from "./unbound-file-effects";
import { currentGrantRoot } from "../granted-hashing";

type ReadySnapshot = Extract<SkillUnboundResolutionSnapshot, { status: "ready" }>;
type ManagementPhase = "absent" | "binding-created" | "linked";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function bindingFolder(binding: import("../../domain/assignment-plan").Binding): string | undefined {
  if (binding.kind !== "skill") return undefined;
  const path = binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
  const key = path.split("/").at(-1);
  const root = binding.harnessId === "codex" ? ".agents" : binding.harnessId === "claude-code" ? ".claude" : ".cursor";
  return key ? `${root}/skills/${key}` : undefined;
}

function currentRevision(files: ReadonlyMap<string, Uint8Array>) {
  return createSkillRevision(
    [...files].map(([path, bytes]) => ({ path, hash: bytesHash(bytes), byteLength: bytes.byteLength })),
    (value) => createHash("sha256").update(value, "utf8").digest("hex"),
  );
}

function envelopeMap(
  envelope: ReadySnapshot["localEnvelope"],
): Map<string, { path: string; kind: "file" | "directory"; identity: string }> {
  return new Map(envelope.map((entry) => [entry.path, { ...entry }]));
}

function innerPath(location: SkillLocationKey, relativePath: string): string {
  const prefix = `${location.folderPath}/`;
  if (!relativePath.startsWith(prefix)) throw new Error("A reviewed action escaped the selected skill folder.");
  return relativePath.slice(prefix.length);
}

function withoutTemporary(
  location: SkillLocationKey,
  files: ReadonlyMap<string, Uint8Array>,
  envelope: ReadySnapshot["localEnvelope"],
  temporaryPath?: string,
): Readonly<{ files: Map<string, Uint8Array>; envelope: typeof envelope }> {
  if (!temporaryPath) return { files: new Map(files), envelope };
  const path = innerPath(location, temporaryPath);
  const temporaryFiles = new Map(files);
  temporaryFiles.delete(path);
  return { files: temporaryFiles, envelope: envelope.filter((entry) => entry.path !== path) };
}

function useAt(uses: readonly ManagedSkillUse[], location: SkillLocationKey): ManagedSkillUse | undefined {
  return uses.find((use) => locationKey(use.location) === locationKey(location));
}

function bindingAt(bindings: readonly import("../../domain/assignment-plan").Binding[], location: SkillLocationKey) {
  return bindings.filter(
    (binding) =>
      binding.projectId === location.projectId &&
      binding.harnessId === location.harnessId &&
      bindingFolder(binding) === location.folderPath,
  );
}

function assertManagement(snapshot: ReadySnapshot, step: SkillEffectStep, phase: ManagementPhase): void {
  const evidence = step.unboundResolutionEvidence!;
  const location = evidence.local.location;
  const use = useAt(snapshot.relationships.uses, location);
  const bindings = bindingAt(snapshot.bindings, location);
  const expectedUse = step.metadataEffects?.[0]?.after;
  const expectedBinding = step.bindingEffects[0]?.after;
  if (!expectedUse || !expectedBinding) throw new Error("The approved linkage management records are incomplete.");
  if (
    snapshot.relationships.skills.some(
      (record) => record.skillId === evidence.skillId && canonical(record) !== canonical(evidence.record),
    )
  )
    throw new Error("The logical skill record changed during canonical linkage.");
  if (
    snapshot.relationships.uses.some(
      (candidate) =>
        candidate.skillId === evidence.skillId && canonical(candidate.source) !== canonical(evidence.source.ref),
    )
  )
    throw new Error("A different source became approved for the logical skill during linkage.");
  if (phase === "absent") {
    if (snapshot.relationships.revision !== evidence.storeRevision || use || bindings.length)
      throw new Error("The selected copy was claimed before canonical linkage completed.");
    return;
  }
  if (phase === "binding-created") {
    if (
      snapshot.relationships.revision !== evidence.storeRevision ||
      use ||
      bindings.length !== 1 ||
      canonical(bindings[0]) !== canonical(expectedBinding)
    )
      throw new Error("The exact operation-created Binding or absent use changed during linkage.");
    return;
  }
  if (
    !use ||
    canonical(use) !== canonical(expectedUse) ||
    bindings.length !== 1 ||
    canonical(bindings[0]) !== canonical(expectedBinding) ||
    snapshot.relationships.revision !== evidence.storeRevision + 1
  )
    throw new Error("The exact operation-created Binding and use failed verification.");
}

async function assertFreshState(
  args: Readonly<{
    read: (
      request: import("../../shared/skill-unbound-resolution-request").SkillUnboundResolutionRequest,
    ) => Promise<SkillUnboundResolutionSnapshot>;
    request: import("../../shared/skill-unbound-resolution-request").SkillUnboundResolutionRequest;
    sourceGrant: ReadySnapshot["sourceGrant"];
    projectGrant: ReadySnapshot["projectGrant"];
    step: SkillEffectStep;
    expectedFiles: ReadonlyMap<string, Uint8Array>;
    expectedEnvelope: Map<string, { path: string; kind: "file" | "directory"; identity: string }>;
    phase: ManagementPhase;
    temporaryPath?: string;
  }>,
): Promise<ReadySnapshot> {
  const current = await args.read(args.request);
  if (current.status !== "ready") throw new Error(current.message);
  if (
    !(await currentGrantRoot(args.sourceGrant)) ||
    !(await currentGrantRoot(args.projectGrant)) ||
    current.rootIdentities.source !== args.step.unboundResolutionEvidence!.source.rootIdentity ||
    current.rootIdentities.project !== args.step.unboundResolutionEvidence!.local.rootIdentity
  )
    throw new Error("The approved source or project root changed during canonical linkage.");
  const source = args.step.unboundResolutionEvidence!.source;
  if (
    canonical(current.sourceTree.revision) !== canonical(source.revision) ||
    canonical(current.sourceEnvelope) !== canonical(args.step.unboundResolutionEnvelope!.source)
  )
    throw new Error("The selected source changed during canonical linkage.");
  const location = args.step.unboundResolutionEvidence!.local.location;
  const local = withoutTemporary(location, current.localTree.files, current.localEnvelope, args.temporaryPath);
  if (
    canonical(currentRevision(local.files)) !== canonical(currentRevision(args.expectedFiles)) ||
    canonical(local.envelope) !==
      canonical([...args.expectedEnvelope.values()].sort((a, b) => a.path.localeCompare(b.path)))
  )
    throw new Error(
      "The selected local files, directory envelope, or file ownership changed during canonical linkage.",
    );
  assertManagement(current, args.step, args.phase);
  return current;
}

function updateExpectedState(
  step: SkillEffectStep,
  action: SkillJournalAction,
  expectedFiles: Map<string, Uint8Array>,
  expectedEnvelope: Map<string, { path: string; kind: "file" | "directory"; identity: string }>,
  payload: PreparedUnboundPayload,
): void {
  const location = step.unboundResolutionEvidence!.local.location;
  const path = innerPath(location, action.relativePath);
  if (action.kind === "create-directory") {
    expectedEnvelope.set(path, { path, kind: "directory", identity: action.identity! });
  } else if (action.kind === "write-file") {
    const bytes = payload.sourceFiles.get(path);
    if (!bytes) throw new Error(`The frozen selected-source bytes are missing: ${path}`);
    expectedFiles.set(path, bytes);
    expectedEnvelope.set(path, { path, kind: "file", identity: action.identity! });
  } else if (action.kind === "delete-file") {
    expectedFiles.delete(path);
    expectedEnvelope.delete(path);
  }
}

export async function applyUnboundResolution(
  args: Readonly<{
    intentId: string;
    snapshot: ReadySnapshot;
    step: SkillEffectStep;
    payload: PreparedUnboundPayload;
    progress: SkillStepProgress;
    relationships: SkillRelationshipStore;
    bindings: BindingsStore;
    bases: SkillBaseStore;
    operationStore: OperationStore;
    filesystem?: SkillObservationFilesystem;
    now: () => number;
    read: (
      request: import("../../shared/skill-unbound-resolution-request").SkillUnboundResolutionRequest,
    ) => Promise<SkillUnboundResolutionSnapshot>;
  }>,
): Promise<SkillEffectOutcome> {
  const { intentId, snapshot, step, payload, progress } = args;
  const evidence = step.unboundResolutionEvidence!;
  const location = evidence.local.location;
  const actions: SkillJournalAction[] = [];
  const expectedFiles = new Map(snapshot.localTree.files);
  const expectedEnvelope = envelopeMap(snapshot.localEnvelope);
  const completed = new Set<string>();
  let phase: ManagementPhase = "absent";
  let failure: unknown;

  const guard = (temporaryPath?: string) =>
    assertFreshState({
      read: args.read,
      request: snapshot.request,
      sourceGrant: snapshot.sourceGrant,
      projectGrant: snapshot.projectGrant,
      step,
      expectedFiles,
      expectedEnvelope,
      phase,
      ...(temporaryPath ? { temporaryPath } : {}),
    });
  const saveProgress = async (nextActions: readonly SkillJournalAction[], temporaryPath?: string): Promise<void> => {
    for (const action of nextActions) {
      const key = `${action.kind}\n${action.relativePath}`;
      if (action.status === "applied" && !completed.has(key)) {
        updateExpectedState(step, action, expectedFiles, expectedEnvelope, payload);
        completed.add(key);
      }
    }
    actions.splice(0, actions.length, ...nextActions);
    await progress({ stepId: step.stepId, status: "applying", actions: [...actions] });
    await guard(temporaryPath);
  };

  const target = step.scope.targets[0]!;
  const base = step.baseReferences?.[0];
  const expectedBinding = step.bindingEffects[0]?.after;
  const expectedUse = step.metadataEffects?.[0]?.after;
  if (!base || !expectedBinding || !expectedUse) throw new Error("The reviewed unbound link transition is incomplete.");
  await progress({ stepId: step.stepId, status: "applying" });
  await guard();
  try {
    for (const action of step.plan.actions) {
      await guard();
      const file = step.files.find((entry) => entry.relativePath === action.relativePath);
      if (action.kind === "create-directory") {
        const identity = await createOwnedDirectory({
          grant: snapshot.projectGrant,
          relativePath: action.relativePath,
          actions,
          progress: (saved) => saveProgress(saved, saved.at(-1)?.temporaryPath),
          beforeEffect: async (temporaryPath) => {
            await guard(temporaryPath);
          },
        });
        const saved = actions.find(
          (entry) => entry.relativePath === action.relativePath && entry.kind === "create-directory",
        );
        if (saved?.identity !== identity) throw new Error("Created directory ownership was not durably recorded.");
        continue;
      }
      if (!file) throw new Error(`The approved file summary is missing: ${action.relativePath}`);
      const path = innerPath(location, action.relativePath);
      const prior = expectedEnvelope.get(path);
      if (action.kind === "delete-file") {
        if (!prior || prior.kind !== "file" || !file.beforeHash)
          throw new Error(`The local deletion ownership is unavailable: ${action.relativePath}`);
        await deleteOwnedFile({
          grant: snapshot.projectGrant,
          relativePath: action.relativePath,
          beforeHash: file.beforeHash,
          beforeIdentity: prior.identity,
          actions,
          progress: (saved) => saveProgress(saved),
          beforeEffect: async () => {
            await guard();
          },
        });
        continue;
      }
      const bytes = payload.sourceFiles.get(path);
      if (!bytes || bytesHash(bytes) !== file.afterHash)
        throw new Error(`The frozen source payload is unavailable: ${path}`);
      await writeOwnedFile({
        grant: snapshot.projectGrant,
        relativePath: action.relativePath,
        ...(file.beforeHash ? { beforeHash: file.beforeHash } : {}),
        ...(prior?.identity ? { beforeIdentity: prior.identity } : {}),
        bytes,
        actions,
        progress: (saved) => saveProgress(saved, saved.at(-1)?.temporaryPath),
        beforeEffect: async (temporaryPath) => {
          await guard(temporaryPath);
        },
      });
    }
    await progress({ stepId: step.stepId, status: "verifying", actions: [...actions] });
    await guard();
    const baseResult = await args.bases.read(base.baseRevisionId);
    if (baseResult.status !== "ready" || canonical(baseResult.revision) !== canonical(base.revision))
      throw new Error("The selected-source immutable base is missing or changed before management publication.");
    const bindingResult = await args.bindings.updateExact(
      step.bindingEffects.map((effect) => ({
        bindingId: effect.bindingId,
        expected: effect.before,
        next: effect.after,
      })),
    );
    if (bindingResult.status !== "ready")
      throw new Error("The exact Binding could not be saved; recovery is required.");
    phase = "binding-created";
    await progress({ stepId: step.stepId, status: "verifying", actions: [...actions] });
    await guard();
    const useResult = await args.relationships.updateUsesExact(evidence.storeRevision, step.metadataEffects ?? []);
    if (useResult.status !== "saved")
      throw new Error("The exact managed use could not be saved; recovery is required.");
    phase = "linked";
    await progress({ stepId: step.stepId, status: "verifying", actions: [...actions] });
    const verified = await guard();
    if (
      canonical(verified.localTree.revision) !== canonical(evidence.source.revision) ||
      canonical(verified.sourceTree.revision) !== canonical(evidence.source.revision)
    )
      throw new Error("The selected project folder does not match the immutable source after replacement.");
    const receipt = makeReceipt(
      intentId,
      step,
      step.plan.actions.map((action) => ({ ...action, status: "applied" })),
      args.now,
      "applied",
    );
    if ((await args.operationStore.append(receipt)).status !== "ready")
      throw new Error("The public link receipt could not be saved; recovery is required.");
    await progress({ stepId: step.stepId, status: "applied", receiptId: receipt.operationId, actions: [...actions] });
    return {
      status: "applied",
      source: { status: "unchanged", sourceId: evidence.source.ref.sourceId },
      targets: [
        {
          projectId: target.projectId,
          harnessId: target.harnessId,
          bindingId: expectedBinding.bindingId,
          artifactPath: expectedBinding.artifactPath,
          status: "applied",
        },
      ],
      receiptIds: [receipt.operationId],
      receipts: [receipt],
      link: resultLink(step, "applied"),
      issues: [],
      recoveryAvailable: false,
    };
  } catch (error: unknown) {
    failure = error;
  }

  const receiptActions = actionReceipts(step, actions);
  const hasFileOrMetadataEffect =
    actions.some(
      (action) =>
        action.status === "applied" ||
        action.status === "applying" ||
        action.temporaryPath !== undefined ||
        action.identity !== undefined,
    ) || phase !== "absent";
  if (!hasFileOrMetadataEffect) {
    await progress({ stepId: step.stepId, status: "failed", actions: [...actions] });
    return {
      status: "failed",
      source: { status: "unchanged", sourceId: evidence.source.ref.sourceId },
      targets: [
        {
          projectId: target.projectId,
          harnessId: target.harnessId,
          bindingId: expectedBinding.bindingId,
          artifactPath: expectedBinding.artifactPath,
          status: "failed",
        },
      ],
      receiptIds: [],
      link: resultLink(step, "failed"),
      issues: [
        {
          code: "unbound-link-failed",
          message: failure instanceof Error ? failure.message : "Canonical linkage failed safely.",
          recoveryAction: "inspect-recovery",
        },
      ],
      recoveryAvailable: false,
    };
  }
  let receipt: OperationReceipt | undefined;
  try {
    receipt = makeReceipt(intentId, step, receiptActions, args.now, "failed");
    if ((await args.operationStore.append(receipt)).status !== "ready") receipt = undefined;
  } catch {
    receipt = undefined;
  }
  await progress({
    stepId: step.stepId,
    status: "recovery-required",
    ...(receipt ? { receiptId: receipt.operationId } : {}),
    actions: [...actions],
  });
  return {
    status: "recovery-required",
    source: { status: "unchanged", sourceId: evidence.source.ref.sourceId },
    targets: [
      {
        projectId: target.projectId,
        harnessId: target.harnessId,
        bindingId: expectedBinding.bindingId,
        artifactPath: expectedBinding.artifactPath,
        status: "unknown",
      },
    ],
    receiptIds: receipt ? [receipt.operationId] : [],
    ...(receipt ? { receipts: [receipt] } : {}),
    link: resultLink(step, "unknown"),
    issues: [
      {
        code: "unbound-link-recovery-required",
        message: failure instanceof Error ? failure.message : "Canonical linkage stopped after effects began.",
        recoveryAction: "inspect-recovery",
      },
    ],
    recoveryAvailable: true,
  };
}
