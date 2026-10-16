import { createHash } from "node:crypto";

import type { SkillJournalAction, SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillEffectOutcome, SkillStepProgress } from "../../application/skill-management";
import type { SkillEffectStep } from "../../shared/skill-management-ipc";
import type { OperationActionReceipt, OperationReceipt } from "../../shared/operations-ipc";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import type { SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import { createSkillRevision } from "../../domain/skill-reconciliation/revisions";
import { currentGrantRoot } from "../granted-hashing";
import { recordParentRestored } from "./restore-parent";
import { deleteOwnedFile, removeOwnedDirectory, bytesHash, writeOwnedFile } from "./unbound-file-effects";
import type { UnboundRecoveryDependencies, UnboundRecoveryPlan, LocalSnapshot } from "./unbound-recovery";
import { planUnboundRecovery } from "./unbound-recovery";
import { readUnboundRecoveryLocalSnapshot } from "./unbound-recovery-plan";
import type { SkillUnboundResolutionRequest } from "../../shared/skill-unbound-resolution-request";
import type { SkillDirectoryEnvelope } from "./unbound-reader";
import type { Binding } from "../../domain/assignment-plan";

type RecoveryArgs = Readonly<{
  plan: UnboundRecoveryPlan;
  restoreIntentId: string;
  progress: SkillStepProgress;
  dependencies: UnboundRecoveryDependencies;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

function locationKey(location: { projectId: string; harnessId: string; folderPath: string }): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function pathInside(
  location: NonNullable<SkillEffectStep["unboundResolutionEvidence"]>["local"]["location"],
  path: string,
): string {
  const prefix = `${location.folderPath}/`;
  if (!path.startsWith(prefix)) throw new Error("A reviewed restore action escaped the selected skill folder.");
  return path.slice(prefix.length);
}

function envelopeMap(
  envelope: SkillDirectoryEnvelope,
): Map<string, { path: string; kind: "file" | "directory"; identity: string }> {
  return new Map(envelope.map((entry) => [entry.path, { ...entry }]));
}

function findUse(snapshot: LocalSnapshot, step: SkillEffectStep) {
  const evidence = step.unboundResolutionEvidence!;
  return snapshot.relationships.uses.find((use) => locationKey(use.location) === locationKey(evidence.local.location));
}

function bindingFolder(binding: Binding): string | undefined {
  if (binding.kind !== "skill") return undefined;
  const artifact = binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
  const key = artifact.split("/").at(-1);
  const root = binding.harnessId === "codex" ? ".agents" : binding.harnessId === "claude-code" ? ".claude" : ".cursor";
  return key ? `${root}/skills/${key}` : undefined;
}

function findBinding(snapshot: LocalSnapshot, step: SkillEffectStep) {
  const location = step.unboundResolutionEvidence!.local.location;
  return snapshot.bindings.filter(
    (binding) =>
      binding.projectId === location.projectId &&
      binding.harnessId === location.harnessId &&
      bindingFolder(binding) === location.folderPath,
  );
}

function assertManagement(
  snapshot: LocalSnapshot,
  step: SkillEffectStep,
  usePresent: boolean,
  bindingPresent: boolean,
): void {
  const evidence = step.unboundResolutionEvidence!;
  const expectedUse = step.metadataEffects?.[0]?.before;
  const expectedBinding = step.bindingEffects[0]?.before;
  if (
    snapshot.relationships.skills.find((record) => record.skillId === evidence.skillId) === undefined ||
    canonical(snapshot.relationships.skills.find((record) => record.skillId === evidence.skillId)) !==
      canonical(evidence.record)
  )
    throw new Error("The logical skill identity or membership changed during restore.");
  const use = findUse(snapshot, step);
  const bindings = findBinding(snapshot, step);
  if ((usePresent && (!expectedUse || canonical(use) !== canonical(expectedUse))) || (!usePresent && use))
    throw new Error("The operation-created managed use changed during restore.");
  if (
    (bindingPresent &&
      (!expectedBinding || bindings.length !== 1 || canonical(bindings[0]) !== canonical(expectedBinding))) ||
    (!bindingPresent && bindings.length !== 0)
  )
    throw new Error("The operation-created Binding changed during restore.");
}

function sameFiles(left: ReadonlyMap<string, Uint8Array>, right: ReadonlyMap<string, Uint8Array>): boolean {
  return (
    left.size === right.size &&
    [...left].every(([path, bytes]) => {
      const other = right.get(path);
      return other !== undefined && bytesHash(bytes) === bytesHash(other);
    })
  );
}

async function assertLiveState(
  args: Readonly<{
    plan: UnboundRecoveryPlan;
    dependencies: UnboundRecoveryDependencies;
    expectedFiles: ReadonlyMap<string, Uint8Array>;
    expectedEnvelope: ReadonlyMap<string, { path: string; kind: "file" | "directory"; identity: string }>;
    usePresent: boolean;
    bindingPresent: boolean;
    temporaryPath?: string;
  }>,
): Promise<LocalSnapshot> {
  const evidence = args.plan.sourceStep.unboundResolutionEvidence!;
  const location = evidence.local.location;
  const current = await readUnboundRecoveryLocalSnapshot({
    location,
    registry: args.dependencies.registry,
    relationships: args.dependencies.relationships,
    bindings: args.dependencies.bindings,
    filesystem: args.dependencies.filesystem,
    now: args.dependencies.now,
  });
  if (current.rootIdentity !== evidence.local.rootIdentity || !(await currentGrantRoot(args.plan.projectGrant)))
    throw new Error("The selected project root changed during restore.");
  const files = new Map(current.tree.files);
  const envelope = envelopeMap(current.envelope);
  if (args.temporaryPath) {
    const temporary = pathInside(location, args.temporaryPath);
    files.delete(temporary);
    envelope.delete(temporary);
  }
  const expectedEnvelope = [...args.expectedEnvelope.values()].sort((a, b) => a.path.localeCompare(b.path));
  const actualEnvelope = [...envelope.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (!sameFiles(files, args.expectedFiles) || canonical(actualEnvelope) !== canonical(expectedEnvelope)) {
    const extra = actualEnvelope
      .filter((entry) => !args.expectedEnvelope.has(entry.path))
      .map((entry) => `+${entry.path}`);
    const missing = expectedEnvelope.filter((entry) => !envelope.has(entry.path)).map((entry) => `-${entry.path}`);
    const identity = expectedEnvelope.flatMap((entry) => {
      const actual = envelope.get(entry.path);
      return actual && actual.identity !== entry.identity ? [`~${entry.path}`] : [];
    });
    const changed = [...new Set([...files.keys(), ...args.expectedFiles.keys()])]
      .filter((path) => {
        const actual = files.get(path);
        const expected = args.expectedFiles.get(path);
        return !actual || !expected || bytesHash(actual) !== bytesHash(expected);
      })
      .map((path) => `!${path}`);
    throw new Error(
      `A selected file, directory, or file identity changed during restore (${[...extra, ...missing, ...identity, ...changed].join(", ")}).`,
    );
  }
  assertManagement(current, args.plan.effect.steps[0]!, args.usePresent, args.bindingPresent);
  return current;
}

function updateExpectedState(
  args: Readonly<{
    location: NonNullable<SkillEffectStep["unboundResolutionEvidence"]>["local"]["location"];
    step: SkillEffectStep;
    action: SkillJournalAction;
    payload: UnboundRecoveryPlan["payload"];
    expectedFiles: Map<string, Uint8Array>;
    expectedEnvelope: Map<string, { path: string; kind: "file" | "directory"; identity: string }>;
  }>,
): void {
  const path = pathInside(args.location, args.action.relativePath);
  if (args.action.kind === "remove-directory" || args.action.kind === "delete-file") {
    args.expectedFiles.delete(path);
    args.expectedEnvelope.delete(path);
    return;
  }
  if (args.action.kind === "write-file") {
    const bytes = args.payload.beforeFiles.get(path);
    if (!bytes || !args.action.identity) throw new Error(`The immutable before-tree bytes are missing: ${path}`);
    args.expectedFiles.set(path, bytes);
    args.expectedEnvelope.set(path, { path, kind: "file", identity: args.action.identity });
  }
}

function receiptId(intentId: string): string {
  const hex = createHash("sha256").update(`${intentId}\nunbound-restore-receipt`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function restoreReceipt(
  plan: UnboundRecoveryPlan,
  intentId: string,
  now: () => number,
  actions: readonly OperationActionReceipt[],
): OperationReceipt {
  const evidence = plan.sourceStep.unboundResolutionEvidence!;
  return {
    operationId: receiptId(intentId),
    kind: "restore-apply",
    status: "applied",
    appliedAt: new Date(now()).toISOString(),
    displayTarget: evidence.local.location.folderPath,
    actions,
    git: { mode: "unavailable" },
    registered: null,
    source: { kind: "source", id: evidence.source.ref.sourceId, relativePath: evidence.source.ref.artifactPath },
    project: { id: evidence.local.location.projectId },
    restores: plan.original.intentId,
  };
}

function actionReceipts(step: SkillEffectStep, actions: readonly SkillJournalAction[]): OperationActionReceipt[] {
  return step.plan.actions.map((action) => {
    const inverseKind = action.kind === "delete-directory" ? "remove-directory" : action.kind;
    const saved = actions.find(
      (candidate) => candidate.relativePath === action.relativePath && candidate.kind === inverseKind,
    );
    return { ...action, status: saved?.status === "applied" ? "applied" : "failed" };
  });
}

async function savedOrNewReceipt(
  plan: UnboundRecoveryPlan,
  intentId: string,
  dependencies: UnboundRecoveryDependencies,
  actions: readonly OperationActionReceipt[],
): Promise<OperationReceipt> {
  const history = await dependencies.operationStore.read();
  if (history.status !== "ready") throw new Error("The operation receipt store is unavailable during restore.");
  return (
    history.receipts.find(
      (receipt) =>
        receipt.kind === "restore-apply" && receipt.restores === plan.original.intentId && receipt.status === "applied",
    ) ?? restoreReceipt(plan, intentId, dependencies.now, actions)
  );
}

function restoredOutcome(plan: UnboundRecoveryPlan, receipt: OperationReceipt): SkillEffectOutcome {
  const evidence = plan.sourceStep.unboundResolutionEvidence!;
  const bindingId = plan.sourceStep.bindingEffects[0]?.bindingId;
  if (!bindingId) throw new Error("The exact linked Binding id is missing from the saved step.");
  return {
    status: "restored",
    source: { status: "unchanged", sourceId: evidence.source.ref.sourceId },
    targets: [
      {
        ...plan.effect.steps[0]!.scope.targets[0]!,
        bindingId,
        artifactPath: evidence.source.ref.artifactPath,
        status: "restored",
      },
    ],
    receiptIds: [receipt.operationId],
    receipts: [receipt],
    link: {
      choice: "link-canonical",
      skillId: evidence.skillId,
      source: evidence.source.ref,
      location: evidence.local.location,
      bindingId,
      status: "restored",
    },
    issues: [],
    recoveryAvailable: false,
  };
}

function inverseTreeMatches(
  plan: UnboundRecoveryPlan,
  files: ReadonlyMap<string, Uint8Array>,
  envelope: ReadonlyMap<string, { path: string; kind: "file" | "directory"; identity: string }>,
): boolean {
  const evidence = plan.sourceStep.unboundResolutionEvidence!;
  const revision = createSkillRevision(
    [...files].map(([path, bytes]) => ({ path, hash: bytesHash(bytes), byteLength: bytes.byteLength })),
    (value) => createHash("sha256").update(value, "utf8").digest("hex"),
  );
  const before = plan.payload.index.beforeEnvelope;
  const current = [...envelope.values()].sort((a, b) => a.path.localeCompare(b.path));
  return (
    canonical(revision) === canonical(evidence.local.revision) &&
    current.length === before.length &&
    current.every((entry, index) => {
      const expected = before[index];
      return (
        entry.path === expected?.path &&
        entry.kind === expected.kind &&
        (entry.kind === "file" || entry.identity === expected.identity)
      );
    })
  );
}

export async function applyUnboundRecovery(args: RecoveryArgs): Promise<SkillEffectOutcome> {
  const { plan, restoreIntentId, progress, dependencies } = args;
  const step = plan.effect.steps[0]!;
  const evidence = plan.sourceStep.unboundResolutionEvidence!;
  const location = evidence.local.location;
  const actions: SkillJournalAction[] = [];
  const expectedFiles = new Map(plan.initial.tree.files);
  const expectedEnvelope = envelopeMap(plan.initial.envelope);
  let usePresent = Boolean(findUse(plan.initial, step));
  let bindingPresent = findBinding(plan.initial, step).length === 1;
  let changed = plan.resuming;
  const completed = new Set<string>();
  const guard = (temporaryPath?: string) =>
    assertLiveState({
      plan,
      dependencies,
      expectedFiles,
      expectedEnvelope,
      usePresent,
      bindingPresent,
      ...(temporaryPath ? { temporaryPath } : {}),
    });
  const saveProgress = async (saved: readonly SkillJournalAction[], temporaryPath?: string): Promise<void> => {
    for (const action of saved) {
      const key = `${action.kind}\n${action.relativePath}`;
      if (action.status === "applied" && !completed.has(key)) {
        updateExpectedState({ location, step, action, payload: plan.payload, expectedFiles, expectedEnvelope });
        changed = true;
        completed.add(key);
      }
    }
    actions.splice(0, actions.length, ...saved);
    await progress({ stepId: step.stepId, status: "applying", actions: [...actions] });
    await guard(temporaryPath);
  };
  try {
    await progress({ stepId: step.stepId, status: "applying" });
    await guard();
    for (const action of step.plan.actions) {
      await guard();
      const path = pathInside(location, action.relativePath);
      const identity = expectedEnvelope.get(path)?.identity;
      const bytes = expectedFiles.get(path);
      if (action.kind === "delete-directory") {
        const owner = plan.original.steps
          .find((saved) => saved.stepId === plan.sourceStep.stepId)
          ?.actions?.find(
            (candidate) => candidate.kind === "create-directory" && candidate.relativePath === action.relativePath,
          );
        const stagedOwner = plan.original.steps
          .find((saved) => saved.stepId === plan.sourceStep.stepId)
          ?.actions?.find(
            (candidate) => candidate.kind === "create-directory" && candidate.temporaryPath === action.relativePath,
          );
        const directoryIdentity = owner?.identity ?? stagedOwner?.identity ?? identity;
        if (!directoryIdentity) throw new Error(`The created directory identity is missing: ${action.relativePath}`);
        await removeOwnedDirectory({
          grant: plan.projectGrant,
          relativePath: action.relativePath,
          identity: directoryIdentity,
          actions,
          progress: (saved) => saveProgress(saved),
          beforeEffect: async () => {
            await guard();
          },
        });
        continue;
      }
      if (action.kind === "delete-file") {
        if (!bytes || !identity)
          throw new Error(`The operation-owned file is no longer present: ${action.relativePath}`);
        await deleteOwnedFile({
          grant: plan.projectGrant,
          relativePath: action.relativePath,
          beforeHash: bytesHash(bytes),
          beforeIdentity: identity,
          actions,
          progress: (saved) => saveProgress(saved),
          beforeEffect: async () => {
            await guard();
          },
        });
        continue;
      }
      if (action.kind === "write-file") {
        const file = step.files.find((candidate) => candidate.relativePath === action.relativePath);
        const restoredBytes = plan.payload.beforeFiles.get(path);
        if (!file || !restoredBytes || bytesHash(restoredBytes) !== file.afterHash)
          throw new Error(`The exact before-tree bytes are unavailable: ${action.relativePath}`);
        await writeOwnedFile({
          grant: plan.projectGrant,
          relativePath: action.relativePath,
          ...(bytes ? { beforeHash: bytesHash(bytes) } : {}),
          ...(identity ? { beforeIdentity: identity } : {}),
          bytes: restoredBytes,
          actions,
          progress: (saved) => saveProgress(saved, saved.at(-1)?.temporaryPath),
          beforeEffect: async (temporaryPath) => {
            await guard(temporaryPath);
          },
        });
        continue;
      }
      throw new Error(`Unsupported reviewed restore action: ${action.kind}`);
    }
    await progress({ stepId: step.stepId, status: "verifying", actions: [...actions] });
    await guard();
    if (!inverseTreeMatches(plan, expectedFiles, expectedEnvelope))
      throw new Error("Restored project files or directories do not match the saved before-tree.");
    const useEffect = step.metadataEffects?.[0];
    if (useEffect) {
      const update = await dependencies.relationships.updateUsesExact(plan.initial.relationships.revision, [useEffect]);
      if (update.status !== "saved") throw new Error("The exact operation-created use could not be removed safely.");
      usePresent = false;
      changed = true;
      await progress({ stepId: step.stepId, status: "verifying", actions: [...actions] });
      await guard();
    }
    const bindingEffect = step.bindingEffects[0];
    if (bindingEffect) {
      const update = await dependencies.bindings.updateExact([
        { bindingId: bindingEffect.bindingId, expected: bindingEffect.before },
      ]);
      if (update.status !== "ready")
        throw new Error("The exact operation-created Binding could not be removed safely.");
      bindingPresent = false;
      changed = true;
      await progress({ stepId: step.stepId, status: "verifying", actions: [...actions] });
      await guard();
    }
    const final = await guard();
    if (
      !inverseTreeMatches(plan, expectedFiles, expectedEnvelope) ||
      findUse(final, step) ||
      findBinding(final, step).length
    )
      throw new Error("The selected copy or operation-created management records failed inverse verification.");
    const receipt = await savedOrNewReceipt(plan, restoreIntentId, dependencies, actionReceipts(step, actions));
    if (
      receipt.operationId === receiptId(restoreIntentId) &&
      (await dependencies.operationStore.append(receipt)).status !== "ready"
    )
      throw new Error("The attributed restore receipt could not be saved.");
    const history = await dependencies.operationStore.read();
    const originalReceiptExists =
      history.status === "ready" && history.receipts.some((item) => item.operationId === plan.sourceStep.stepId);
    if (
      originalReceiptExists &&
      (await dependencies.operationStore.markRestored(plan.sourceStep.stepId)).status !== "ready"
    )
      throw new Error("The original link receipt could not be marked restored.");
    await recordParentRestored(dependencies.operationStore, dependencies.journal, plan.original.intentId);
    await progress({ stepId: step.stepId, status: "applied", receiptId: receipt.operationId, actions: [...actions] });
    return restoredOutcome(plan, receipt);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "The unbound link restore stopped safely.";
    await progress({ stepId: step.stepId, status: changed ? "recovery-required" : "failed", actions: [...actions] });
    return {
      status: changed ? "recovery-required" : "failed",
      source: { status: "unchanged", sourceId: evidence.source.ref.sourceId },
      targets: [
        {
          ...step.scope.targets[0]!,
          bindingId: step.bindingEffects[0]?.bindingId ?? plan.sourceStep.bindingEffects[0]!.bindingId,
          artifactPath: evidence.source.ref.artifactPath,
          status: changed ? "unknown" : "failed",
        },
      ],
      receiptIds: [],
      link: {
        choice: "link-canonical",
        skillId: evidence.skillId,
        source: evidence.source.ref,
        location,
        bindingId: plan.sourceStep.bindingEffects[0]!.bindingId,
        status: changed ? "unknown" : "failed",
      },
      issues: [
        {
          code: changed ? "unbound-restore-recovery-required" : "unbound-restore-failed",
          message,
          recoveryAction: "inspect-recovery",
        },
      ],
      recoveryAvailable: changed,
    };
  }
}
