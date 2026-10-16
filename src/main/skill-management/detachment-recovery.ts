import { resolveTarget } from "../../domain/harness-targets";
import { buildSkillDetachmentRecoveryEffect } from "./detachment-recovery-effect";
import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type {
  SkillOperationJournal,
  SkillOperationJournalRecord,
  SkillJournalStep,
} from "../../application/skill-management-journal";
import type { SkillEffectStep, SkillIssue } from "../../shared/skill-management-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { SkillDetachmentEvidence } from "../../shared/skill-detachment-effects";
import type { SkillDetachmentRequest } from "../../shared/skill-detachment-request";
import type { BindingsStore } from "../bindings-store";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { RegistryIpcServices } from "../registry-ipc";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import type { OperationStore } from "../operation-store";
import {
  readInterruptedDetachmentInverse,
  readInterruptedDetachmentReceipt,
  closeInterruptedDetachmentInverses,
  type InterruptedDetachmentInverse,
} from "./detachment-inverse-journal";
import { recordParentRestored } from "./restore-parent";
import {
  readSkillDetachmentSnapshot,
  type SkillDetachmentReaderDependencies,
  type SkillDetachmentSnapshot,
} from "./detachment-reader";
import { createSkillDetachmentReceipt } from "./detachment-receipt";
import { detachmentRecoveryStateKey, planSkillDetachmentRecovery } from "./detachment-recovery-plan";
import {
  hasSkillDetachmentReceiptLink,
  readOriginalDetachmentStep,
  resolveSkillDetachmentReceipt,
  type SkillDetachmentSavedStep,
} from "./detachment-recovery-receipt";

type ReadySnapshot = Extract<SkillDetachmentSnapshot, { status: "ready" }>;
type ReadyStep = SkillDetachmentSavedStep;
type ManagedProgress = NonNullable<SkillJournalStep["managementProgress"]>;
type Decision = ReturnType<typeof planSkillDetachmentRecovery>;
type SavedPlan = Readonly<{
  record: SkillOperationJournalRecord;
  step: ReadyStep;
  sourceReceipt?: OperationReceipt;
  effect: SkillEffectDraft;
  noOp: boolean;
  restoreBinding: boolean;
  restoreUse: boolean;
  stateKey: string;
  priorInverse?: InterruptedDetachmentInverse;
}>;

export type SkillDetachmentRecoveryDependencies = Readonly<{
  registry: RegistryIpcServices;
  relationships: SkillRelationshipStore;
  bindings: BindingsStore;
  bases: SkillBaseStore;
  operationStore: OperationStore;
  journal: SkillOperationJournal;
  now?: () => number;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function issue(code: string, message: string): SkillIssue {
  return { code, message, recoveryAction: "inspect-recovery" };
}

function blocked(message: string): SkillEffectBuild {
  return { status: "blocked", reason: message, details: [issue("detachment-recovery-blocked", message)] };
}

function requestFor(evidence: SkillDetachmentEvidence): SkillDetachmentRequest {
  return { choice: "detach-managed", skillId: evidence.skillId, locations: [evidence.local.location] };
}

function readerDependencies(args: SkillDetachmentRecoveryDependencies): SkillDetachmentReaderDependencies {
  return {
    registry: args.registry,
    relationships: args.relationships,
    bindings: args.bindings,
    bases: args.bases,
    ...(args.now ? { now: args.now } : {}),
  };
}

function progressFor(record: SkillOperationJournalRecord, step: ReadyStep): ManagedProgress | undefined {
  return record.steps.find(({ stepId }) => stepId === step.stepId)?.managementProgress;
}

function targetFolder(binding: import("../../domain/assignment-plan").Binding): string | undefined {
  if (binding.kind !== "skill") return undefined;
  const artifact = binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
  const id = artifact.split("/").at(-1);
  if (!id) return undefined;
  const target = resolveTarget({ kind: "skill", id, harnessId: binding.harnessId });
  return target.status === "target" ? target.relativePath : undefined;
}

async function baseMatches(
  args: SkillDetachmentRecoveryDependencies,
  evidence: SkillDetachmentEvidence,
): Promise<boolean> {
  const base = await args.bases.read(evidence.base.baseRevisionId);
  return (
    base.status === "ready" &&
    base.baseRevisionId === evidence.base.baseRevisionId &&
    same(base.revision, evidence.base.revision)
  );
}

export function createSkillDetachmentRecoveryAdapter(args: SkillDetachmentRecoveryDependencies): Readonly<{
  previewOriginal(record: SkillOperationJournalRecord, intentId: string): Promise<SkillEffectBuild>;
  previewReceipt(receipt: OperationReceipt, intentId: string): Promise<SkillEffectBuild>;
  previewInverse(record: SkillOperationJournalRecord, intentId: string): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress: SkillStepProgress): Promise<SkillEffectOutcome>;
  has(planId: string): boolean;
}> {
  const plans = new Map<string, SavedPlan>();
  const reader = readerDependencies(args);
  const inspect = async (
    record: SkillOperationJournalRecord,
    step: ReadyStep,
    receipt: OperationReceipt | undefined,
    intentId: string,
  ): Promise<SkillEffectBuild> => {
    try {
      const evidence = step.detachmentEvidence;
      const snapshot = await readSkillDetachmentSnapshot(requestFor(evidence), reader);
      if (snapshot.status !== "ready") return blocked(snapshot.message);
      const priorInverse = await readInterruptedDetachmentInverse(args.journal, record, step);
      if (receipt?.restored && !priorInverse)
        return blocked("The selected stop-management child has already been restored.");
      const decision = planSkillDetachmentRecovery({
        snapshot,
        evidence,
        ...(priorInverse
          ? { inverse: { step: priorInverse.step, progress: progressFor(priorInverse.record, priorInverse.step) } }
          : {}),
        baseMatches: await baseMatches(args, evidence),
        progress: progressFor(record, step),
      });
      if (decision.status === "blocked") return blocked(decision.reason);
      if (receipt && decision.status !== "restore")
        return blocked("The saved stop-management receipt is already restored or its metadata state changed.");
      const effect = buildSkillDetachmentRecoveryEffect(record, step, intentId, decision);
      plans.set(effect.planId, {
        record,
        step,
        ...(receipt ? { sourceReceipt: receipt } : {}),
        effect,
        noOp: decision.status === "unchanged",
        restoreBinding: decision.status === "restore" && decision.restoreBinding,
        restoreUse: decision.status === "restore" && decision.restoreUse,
        stateKey: detachmentRecoveryStateKey(snapshot, evidence),
        ...(priorInverse ? { priorInverse } : {}),
      });
      return effect;
    } catch (error: unknown) {
      return blocked(error instanceof Error ? error.message : "Saved management inverse progress is unavailable.");
    }
  };

  const savedPlan = (effect: SkillEffectDraft): SavedPlan => {
    const saved = plans.get(effect.planId);
    if (!saved || !same(saved.effect.steps, effect.steps))
      throw new Error("The stop-management recovery preview expired; refresh before restoring.");
    return saved;
  };

  const readState = async (saved: SavedPlan): Promise<ReadySnapshot> => {
    const snapshot = await readSkillDetachmentSnapshot(requestFor(saved.step.detachmentEvidence), reader);
    if (snapshot.status !== "ready" || !(await baseMatches(args, saved.step.detachmentEvidence)))
      throw new Error("The project copy or immutable base is unavailable; stop-management recovery is withheld.");
    return snapshot;
  };

  const validate = async (saved: SavedPlan): Promise<ReadySnapshot> => {
    const snapshot = await readState(saved);
    const priorInverse = await readInterruptedDetachmentInverse(args.journal, saved.record, saved.step);
    if (!same(priorInverse, saved.priorInverse))
      throw new Error("Saved inverse progress changed after recovery review.");
    const decision = planSkillDetachmentRecovery({
      snapshot,
      ...(priorInverse
        ? { inverse: { step: priorInverse.step, progress: progressFor(priorInverse.record, priorInverse.step) } }
        : {}),
      evidence: saved.step.detachmentEvidence,
      baseMatches: true,
      progress: progressFor(saved.record, saved.step),
    });
    if (
      (saved.noOp && decision.status !== "unchanged") ||
      (!saved.noOp && decision.status !== "restore") ||
      detachmentRecoveryStateKey(snapshot, saved.step.detachmentEvidence) !== saved.stateKey
    ) {
      throw new Error("The selected copy or tracking records changed after recovery review.");
    }
    return snapshot;
  };

  const validateExpected = async (saved: SavedPlan, expectedBinding: boolean, expectedUse: boolean): Promise<void> => {
    const snapshot = await readState(saved);
    const evidence = saved.step.detachmentEvidence;
    const locationUses = snapshot.relationships.uses.filter((use) => same(use.location, evidence.local.location));
    const claims = snapshot.bindings.filter(
      (binding) =>
        binding.projectId === evidence.local.location.projectId &&
        binding.harnessId === evidence.local.location.harnessId &&
        targetFolder(binding) === evidence.local.location.folderPath,
    );
    if (
      snapshot.rootIdentity !== evidence.local.rootIdentity ||
      !same(snapshot.localTree.revision, evidence.local.revision) ||
      !same(snapshot.envelope, evidence.local.envelope) ||
      !snapshot.record?.locations.some((location) => same(location, evidence.local.location)) ||
      locationUses.length !== Number(expectedUse) ||
      (expectedUse && !same(locationUses[0], evidence.use)) ||
      claims.length !== Number(expectedBinding) ||
      (expectedBinding && !same(claims[0], evidence.binding)) ||
      snapshot.relationships.uses.some(
        (use) => use.skillId === evidence.skillId && !same(use.source, evidence.use.source),
      )
    ) {
      throw new Error("Fresh project and metadata checks withheld stop-management restoration.");
    }
  };

  const finishOriginalJournal = async (saved: SavedPlan, result: SkillEffectOutcome): Promise<void> => {
    await args.journal.write({
      ...saved.record,
      status: "terminal",
      result: { intentId: saved.record.intentId, operationId: saved.record.intentId, ...result },
      updatedAt: new Date((args.now ?? Date.now)()).toISOString(),
      steps: saved.record.steps.map((step) => ({ ...step, status: "applied" })),
    });
  };

  const prepare = async (_intentId: string, effect: SkillEffectDraft): Promise<void> => {
    await validate(savedPlan(effect));
  };

  const apply = async (
    intentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome> => {
    const saved = savedPlan(effect);
    plans.delete(effect.planId);
    const step = effect.steps[0]!;
    const evidence = saved.step.detachmentEvidence;
    const location = evidence.local.location;
    await validate(saved);
    await progress({
      stepId: step.stepId,
      status: "applying",
      managementProgress: { bindings: "pending", uses: "pending" },
    });
    if (saved.noOp) {
      await validate(saved);
      const unchanged: SkillEffectOutcome = {
        status: "no-op",
        source: { status: "unchanged", sourceId: evidence.use.source.sourceId },
        targets: [
          {
            projectId: location.projectId,
            harnessId: location.harnessId,
            bindingId: evidence.binding.bindingId,
            artifactPath: evidence.binding.artifactPath,
            status: "no-op",
          },
        ],
        receiptIds: [],
        issues: [],
        recoveryAvailable: false,
        detachment: {
          choice: "detach-managed",
          skillId: evidence.skillId,
          location,
          source: evidence.use.source,
          bindingId: evidence.binding.bindingId,
          status: "unchanged",
        },
      };
      await finishOriginalJournal(saved, unchanged);
      return unchanged;
    }

    await validate(saved);
    await validateExpected(saved, !saved.restoreBinding, !saved.restoreUse);
    if (saved.restoreBinding) {
      await validateExpected(saved, false, !saved.restoreUse);
      const updated = await args.bindings.updateExact([
        { bindingId: evidence.binding.bindingId, next: evidence.binding },
      ]);
      if (updated.status !== "ready") throw new Error("The original Binding could not be restored exactly.");
      await validateExpected(saved, true, !saved.restoreUse);
    }
    await progress({
      stepId: step.stepId,
      status: "applying",
      managementProgress: { bindings: "applied", uses: "pending" },
    });
    await validateExpected(saved, true, !saved.restoreUse);
    if (saved.restoreUse) {
      const updated = await args.relationships.updateUsesExact(undefined, [
        { skillId: evidence.skillId, location, after: evidence.use },
      ]);
      if (updated.status !== "saved") throw new Error("The original managed use could not be restored exactly.");
    }
    await progress({
      stepId: step.stepId,
      status: "verifying",
      managementProgress: { bindings: "applied", uses: "applied" },
    });
    await validateExpected(saved, true, true);

    const inverseHistory = await args.operationStore.read();
    if (inverseHistory.status !== "ready") throw new Error("Interrupted inverse receipt history is unavailable.");
    const inverseReceipt =
      readInterruptedDetachmentReceipt(inverseHistory.receipts, saved.priorInverse, saved.sourceReceipt) ??
      createSkillDetachmentReceipt(intentId, step, args.now ?? Date.now, saved.sourceReceipt?.operationId);
    const persisted = await args.operationStore.append(inverseReceipt);
    if (
      persisted.status !== "ready" ||
      !persisted.receipts.some(
        (receipt) => receipt.operationId === inverseReceipt.operationId && same(receipt, inverseReceipt),
      )
    )
      throw new Error("The stop-management restore receipt could not be durably verified.");
    if (saved.sourceReceipt) {
      const marked = await args.operationStore.markRestored(saved.sourceReceipt.operationId);
      if (
        marked.status !== "ready" ||
        !marked.receipts.some((receipt) => receipt.operationId === saved.sourceReceipt!.operationId && receipt.restored)
      )
        throw new Error("The original stop-management child could not be marked restored safely.");
    }
    const result: SkillEffectOutcome = {
      status: "restored",
      source: { status: "unchanged", sourceId: evidence.use.source.sourceId },
      targets: [
        {
          projectId: location.projectId,
          harnessId: location.harnessId,
          bindingId: evidence.binding.bindingId,
          artifactPath: evidence.binding.artifactPath,
          status: "restored",
        },
      ],
      receiptIds: [inverseReceipt.operationId],
      receipts: [inverseReceipt],
      issues: [],
      recoveryAvailable: false,
      detachment: {
        choice: "detach-managed",
        skillId: evidence.skillId,
        location,
        source: evidence.use.source,
        bindingId: evidence.binding.bindingId,
        status: "restored",
      },
    };
    await closeInterruptedDetachmentInverses({
      journal: args.journal,
      operationStore: args.operationStore,
      original: saved.record,
      step: saved.step,
      result,
      now: args.now ?? Date.now,
    });
    const history = await args.operationStore.read();
    const parent =
      history.status === "ready"
        ? history.receipts.find(
            (receipt) => receipt.operationId === saved.record.intentId && receipt.kind === "skill-management",
          )
        : undefined;
    if (parent?.skillManagement) await recordParentRestored(args.operationStore, args.journal, saved.record.intentId);
    else await finishOriginalJournal(saved, result);
    return result;
  };

  const previewOriginal = async (record: SkillOperationJournalRecord, intentId: string): Promise<SkillEffectBuild> => {
    const step = readOriginalDetachmentStep(record);
    if (!step) return blocked("The saved operation is not one exact stop-management step.");
    const history = await args.operationStore.read();
    if (history.status !== "ready") return blocked("Operation receipt history is unavailable for recovery.");
    const parent = history.receipts.find(
      (receipt) => receipt.operationId === record.intentId && receipt.kind === "skill-management",
    );
    const childIds = parent?.children ?? record.result?.receiptIds ?? [];
    const receiptInStore = childIds
      .map((id) => history.receipts.find((candidate) => candidate.operationId === id))
      .find((candidate): candidate is OperationReceipt =>
        Boolean(candidate && resolveSkillDetachmentReceipt(candidate, record)),
      );
    const receipt =
      receiptInStore ?? record.result?.receipts?.find((candidate) => resolveSkillDetachmentReceipt(candidate, record));
    if (receipt) {
      if (!hasSkillDetachmentReceiptLink(history.receipts, record, receipt))
        return blocked("The stop-management parent and child receipt do not agree.");
      return inspect(record, step, receipt, intentId);
    }
    if (record.status !== "recovery-required")
      return blocked("The applied stop-management child receipt is missing; inspect the saved operation history.");
    return inspect(record, step, undefined, intentId);
  };

  const previewReceipt = async (receipt: OperationReceipt, intentId: string): Promise<SkillEffectBuild> => {
    if (receipt.kind !== "detach-skill" || !receipt.detachment)
      return blocked("The selected receipt is not an active stop-management child.");
    const loaded = await args.journal.read(receipt.detachment.intentId);
    if (loaded.status !== "ready") return blocked("The original stop-management journal is missing or corrupt.");
    const step = resolveSkillDetachmentReceipt(receipt, loaded.record);
    if (!step) return blocked("The stop-management receipt does not match its saved journal step.");
    const history = await args.operationStore.read();
    if (history.status !== "ready" || !hasSkillDetachmentReceiptLink(history.receipts, loaded.record, receipt))
      return blocked("The public parent does not contain this exact stop-management child receipt.");
    return inspect(loaded.record, step, receipt, intentId);
  };

  const previewInverse = async (record: SkillOperationJournalRecord, intentId: string): Promise<SkillEffectBuild> => {
    const origin = record.effect?.steps.length === 1 ? record.effect.steps[0].detachmentRestoreOrigin : undefined;
    if (record.intent.kind !== "restore" || record.status !== "recovery-required" || !origin)
      return blocked("The selected operation is not an interrupted management inverse.");
    const original = await args.journal.read(origin.intentId);
    if (original.status !== "ready") return blocked("The original stop-management journal is unavailable.");
    return previewOriginal(original.record, intentId);
  };

  return { previewOriginal, previewReceipt, previewInverse, prepare, apply, has: (planId) => plans.has(planId) };
}
