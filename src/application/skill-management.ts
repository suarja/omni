import { randomUUID } from "node:crypto";
import { recoveryResult } from "./skill-management-recovery-result";

import {
  fingerprintSkillEffects,
  normalizeSkillIntent,
  type SkillEffectFingerprint,
} from "../domain/skill-management-intent";
import type {
  SkillJournalBackupReference,
  SkillJournalStep,
  SkillOperationJournal,
  SkillOperationJournalRecord,
} from "./skill-management-journal";
import type {
  SkillActor,
  SkillAuthorization,
  SkillEffectStep,
  SkillIntent,
  SkillIssue,
  SkillPreview,
  SkillResult,
  SkillScope,
} from "../shared/skill-management-ipc";
import type { SkillPropagationSummary } from "../shared/skill-propagation-ipc";
import type { SkillPropagationCandidate } from "../shared/skill-propagation-ipc";
import type { SourceSkillRef } from "../domain/skill-reconciliation/types";
import type { SkillVariantCaptureDetails } from "../shared/skill-variant-effects";
import type { SkillUnboundResolutionDetails } from "../shared/skill-unbound-resolution-effects";
import type { LegacyBindingBridgeDiagnostic } from "../shared/legacy-binding-bridge-diagnostic";
import type { SkillDetachmentDetails } from "../shared/skill-detachment-effects";

export type SkillEffectDraft = Readonly<{
  status: "ready";
  planId: string;
  scope: SkillScope;
  steps: readonly SkillEffectStep[];
  fingerprint: SkillEffectFingerprint;
  backupReferences: readonly SkillJournalBackupReference[];
  propagation?: SkillPropagationSummary;
}>;
export type SkillEffectBuild =
  SkillEffectDraft | Readonly<{ status: "blocked" | "needs-input"; reason: string; details: readonly SkillIssue[] }>;
export type SkillEffectOutcome = Readonly<{
  status: SkillResult["status"];
  source: SkillResult["source"];
  targets: SkillResult["targets"];
  receiptIds: readonly string[];
  receipts?: SkillResult["receipts"];
  resolution?: SkillResult["resolution"];
  capture?: SkillVariantCaptureDetails;
  link?: SkillUnboundResolutionDetails;
  detachment?: SkillDetachmentDetails;
  propagation?: SkillPropagationSummary;
  issues: readonly SkillIssue[];
  recoveryAvailable: boolean;
}>;

export type SkillStepProgress = (step: SkillJournalStep) => Promise<void>;

export interface SkillManagementEffects {
  preview(intent: SkillIntent, actor: SkillActor, intentId: string, createdAt: number): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  validateAuthorization(record: SkillOperationJournalRecord, authorization: SkillAuthorization): Promise<void>;
  apply(
    intentId: string,
    intent: SkillIntent,
    actor: SkillActor,
    authorization: SkillAuthorization,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome>;
}

export type SkillManagementService = Readonly<{
  initialize(): Promise<void>;
  preview(intent: unknown, actor: SkillActor): Promise<SkillPreview>;
  refresh(intentId: string, actor: SkillActor): Promise<SkillPreview>;
  apply(intentId: string, authorization: SkillAuthorization): Promise<SkillResult>;
  readResult(intentId: string): Promise<SkillResult | undefined>;
  listRecoveries(): Promise<readonly SkillResult[]>;
  readProjectSkills?(projectId: string): Promise<import("../shared/project-skills-ipc").ProjectSkills>;
  readLegacyBridgeDiagnostic?(): LegacyBindingBridgeDiagnostic | undefined;
  readPropagationCandidates?(source: SourceSkillRef): Promise<readonly SkillPropagationCandidate[]>;
}>;

type ServiceOptions = Readonly<{
  effects: SkillManagementEffects;
  journal: SkillOperationJournal;
  now?: () => number;
  createId?: () => string;
  onProgress?: (intentId: string) => void;
  recordResult?: (result: SkillResult, record: SkillOperationJournalRecord) => Promise<void>;
}>;

function sameActor(left: SkillActor, right: SkillActor): boolean {
  if (left.kind === "desktop" && right.kind === "desktop") return left.automatic === right.automatic;
  return (
    left.kind === right.kind && (left.kind !== "mcp" || (right.kind === "mcp" && left.requestId === right.requestId))
  );
}
function effectFingerprint(intent: SkillIntent, draft: SkillEffectDraft): string {
  return fingerprintSkillEffects(intent, draft.fingerprint);
}
function scopesKey(scope: SkillScope): string[] {
  const keys = scope.targets.map((target) => `project:${target.projectId}:${target.harnessId}`);
  if (scope.sourceId) keys.push(`source:${scope.sourceId}`);
  return [...new Set(keys)].sort();
}
function issue(code: string, message: string, recoveryAction: SkillIssue["recoveryAction"]): SkillIssue {
  return { code, message, recoveryAction };
}
export { recoveryResult };

function buildJournalRecord(
  args: Readonly<{
    intentId: string;
    actor: SkillActor;
    intent: SkillIntent;
    draft: SkillEffectDraft;
    fingerprint: string;
    now: string;
  }>,
): SkillOperationJournalRecord {
  return {
    version: 1,
    intentId: args.intentId,
    actor: args.actor,
    intent: args.intent,
    status: "previewed",
    effectFingerprint: args.fingerprint,
    effect: {
      planId: args.draft.planId,
      scope: args.draft.scope,
      steps: args.draft.steps,
      ...(args.draft.propagation ? { propagation: args.draft.propagation } : {}),
    },
    backupReferences: args.draft.backupReferences,
    steps: args.draft.steps.map((step) => ({ stepId: step.stepId, status: "prepared" })),
    createdAt: args.now,
    updatedAt: args.now,
  };
}

export function createSkillManagementService(options: ServiceOptions): SkillManagementService {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const activeEffects = new Map<string, SkillEffectDraft>();
  const activeActors = new Map<string, SkillActor>();
  const locks = new Set<string>();
  const running = new Map<string, Promise<SkillResult>>();
  let journalUnavailable: string | undefined;

  const initialize = async (): Promise<void> => {
    try {
      await options.journal.recoverInterrupted();
      const saved = await options.journal.list();
      if (saved.status !== "ready") throw new Error("Saved recovery records are unavailable.");
      for (const record of saved.records.filter((candidate) => candidate.status === "recovery-required"))
        await options.recordResult?.(record.result ?? recoveryResult(record), record);
      journalUnavailable = undefined;
    } catch (error: unknown) {
      journalUnavailable = error instanceof Error ? error.message : "The skill operation journal is unavailable.";
    }
  };

  const previewDraft = async (intent: SkillIntent, actor: SkillActor, intentId: string): Promise<SkillPreview> => {
    if (journalUnavailable)
      return {
        status: "blocked",
        intentId,
        reason: journalUnavailable,
        details: [
          issue(
            "journal-unavailable",
            "The operation journal is unavailable; no write can be approved safely.",
            "inspect-recovery",
          ),
        ],
      };
    const existing = await options.journal.read(intentId);
    if (existing.status !== "missing")
      return {
        status: "blocked",
        intentId,
        reason: "The operation id is already in use.",
        details: [
          issue(
            "intent-id-conflict",
            "Refresh the operation with its saved id instead of replacing its history.",
            "inspect-recovery",
          ),
        ],
      };
    const createdAt = now();
    const built = await options.effects.preview(intent, actor, intentId, createdAt);
    if (built.status !== "ready")
      return { status: built.status, intentId, reason: built.reason, details: built.details };
    const fingerprint = effectFingerprint(intent, built);
    const record = buildJournalRecord({
      intentId,
      actor,
      intent,
      draft: built,
      fingerprint,
      now: new Date(createdAt).toISOString(),
    });
    await options.journal.write(record);
    activeEffects.set(intentId, built);
    activeActors.set(intentId, actor);
    return {
      status: "ready",
      intentId,
      planId: built.planId,
      effectFingerprint: fingerprint,
      scope: built.scope,
      steps: built.steps,
      ...(built.propagation ? { propagation: built.propagation } : {}),
    };
  };

  const preview = async (intentValue: unknown, actor: SkillActor): Promise<SkillPreview> => {
    const intent = normalizeSkillIntent(intentValue);
    return previewDraft(intent, actor, createId());
  };

  const refresh = async (intentId: string, actor: SkillActor): Promise<SkillPreview> => {
    if (journalUnavailable)
      return {
        status: "blocked",
        intentId,
        reason: journalUnavailable,
        details: [
          issue(
            "journal-unavailable",
            "The operation journal is unavailable; no write can be approved safely.",
            "inspect-recovery",
          ),
        ],
      };
    const loaded = await options.journal.read(intentId);
    if (loaded.status !== "ready")
      return {
        status: "blocked",
        intentId,
        reason: loaded.status === "corrupt" ? loaded.diagnostic : "The operation is unavailable.",
        details: [issue("intent-unavailable", "The saved operation cannot be refreshed safely.", "inspect-recovery")],
      };
    const record = loaded.record;
    if (!sameActor(record.actor, actor) || record.status !== "previewed")
      return {
        status: "blocked",
        intentId,
        reason: "The operation cannot be refreshed in its current state.",
        details: [
          issue(
            "intent-state",
            "Reopen the operation from its original request or inspect its recovery state.",
            "inspect-recovery",
          ),
        ],
      };
    const built = await options.effects.preview(record.intent, actor, intentId, Date.parse(record.createdAt));
    if (built.status !== "ready")
      return { status: built.status, intentId, reason: built.reason, details: built.details };
    const fingerprint = effectFingerprint(record.intent, built);
    if (fingerprint !== record.effectFingerprint) {
      activeEffects.delete(intentId);
      return {
        status: "stale",
        intentId,
        reason: "The operation effects changed; review a new preview before authorizing writes.",
        details: [
          issue(
            "effects-changed",
            "Files, metadata, or selected targets changed after the original preview.",
            "refresh",
          ),
        ],
      };
    }
    const refreshed = {
      ...built,
      steps: built.steps.map((step, index) => ({ ...step, stepId: record.steps[index]?.stepId ?? step.stepId })),
    };
    await options.journal.write({
      ...record,
      effect: {
        planId: refreshed.planId,
        scope: refreshed.scope,
        steps: refreshed.steps,
        ...(refreshed.propagation ? { propagation: refreshed.propagation } : {}),
      },
      backupReferences: refreshed.backupReferences,
      updatedAt: new Date(now()).toISOString(),
    });
    activeEffects.set(intentId, refreshed);
    activeActors.set(intentId, actor);
    return {
      status: "ready",
      intentId,
      planId: built.planId,
      effectFingerprint: fingerprint,
      scope: refreshed.scope,
      steps: refreshed.steps,
      ...(refreshed.propagation ? { propagation: refreshed.propagation } : {}),
    };
  };

  const applyOnce = async (intentId: string, authorization: SkillAuthorization): Promise<SkillResult> => {
    const loaded = await options.journal.read(intentId);
    if (loaded.status !== "ready")
      return {
        intentId,
        operationId: intentId,
        status: "failed",
        source: { status: "unchanged" },
        targets: [],
        receiptIds: [],
        issues: [
          issue(
            "intent-unavailable",
            "The saved operation is unavailable and no effect was repeated.",
            "inspect-recovery",
          ),
        ],
        recoveryAvailable: false,
      };
    const record = loaded.record;
    if (record.result) return record.result;
    if (record.status === "recovery-required") return recoveryResult(record);
    if (record.status === "terminal") return recoveryResult(record);
    if (authorization.effectFingerprint !== record.effectFingerprint)
      return {
        intentId,
        operationId: intentId,
        status: "failed",
        source: { status: "unchanged" },
        targets: [],
        receiptIds: [],
        issues: [issue("authorization-stale", "Approval does not cover the current effect fingerprint.", "refresh")],
        recoveryAvailable: false,
      };
    const actor = activeActors.get(intentId) ?? record.actor;
    if (authorization.kind === "agent" && (actor.kind !== "mcp" || actor.requestId !== authorization.requestId))
      throw new Error("Agent authorization does not match the saved request.");
    if (authorization.kind === "desktop" && actor.kind !== "desktop")
      throw new Error("Desktop authorization does not match the saved operation.");
    const effect = activeEffects.get(intentId);
    if (!effect)
      return {
        intentId,
        operationId: intentId,
        status: "failed",
        source: {
          status: "unchanged",
          ...(record.intent.kind === "write" ? { sourceId: record.intent.request.sourceId } : {}),
        },
        targets: [],
        receiptIds: [],
        issues: [
          issue("preview-expired", "The preview is no longer available; refresh it before applying.", "refresh"),
        ],
        recoveryAvailable: false,
      };
    const keys = scopesKey(effect.scope);
    const savedOperations = await options.journal.list();
    if (savedOperations.status !== "ready")
      return {
        intentId,
        operationId: intentId,
        status: "failed",
        source: { status: "unchanged" },
        targets: [],
        receiptIds: [],
        recoveryAvailable: false,
        issues: [
          issue(
            "journal-unavailable",
            "Saved recovery scopes cannot be read safely; no effect was started.",
            "inspect-recovery",
          ),
        ],
      };
    // Process-local leases disappear on restart; durable recovery scopes must still withhold writes.
    const interrupted = savedOperations.records.find(
      (candidate) =>
        candidate.intentId !== intentId &&
        candidate.status === "recovery-required" &&
        !(
          record.intent.kind === "restore" &&
          (record.intent.operationId === candidate.intentId ||
            (candidate.intent.kind === "restore" && candidate.intent.operationId === record.intent.operationId))
        ) &&
        (!candidate.effect ||
          scopesKey(candidate.effect.scope).length === 0 ||
          scopesKey(candidate.effect.scope).some((key) => keys.includes(key))),
    );
    if (interrupted)
      return {
        intentId,
        operationId: intentId,
        status: "failed",
        source: { status: "unchanged" },
        targets: [],
        receiptIds: [],
        recoveryAvailable: false,
        issues: [
          issue(
            "scope-recovery-required",
            `Operation ${interrupted.intentId} requires recovery on this scope; no new effect was started.`,
            "inspect-recovery",
          ),
        ],
      };
    if (keys.some((key) => locks.has(key)))
      return {
        intentId,
        operationId: intentId,
        status: "failed",
        source: { status: "unchanged" },
        targets: [],
        receiptIds: [],
        issues: [
          issue("scope-busy", "Another skill operation is applying to this source or project target.", "refresh"),
        ],
        recoveryAvailable: false,
      };
    for (const key of keys) locks.add(key);
    try {
      await options.effects.validateAuthorization(record, authorization);
      const prepared: SkillOperationJournalRecord = {
        ...record,
        status: "prepared",
        updatedAt: new Date(now()).toISOString(),
      };
      await options.journal.write(prepared);
      try {
        await options.effects.prepare(intentId, effect);
      } catch (error: unknown) {
        const result: SkillResult = {
          intentId,
          operationId: intentId,
          status: "failed",
          source: {
            status: "unchanged",
            ...(record.intent.kind === "write" ? { sourceId: record.intent.request.sourceId } : {}),
          },
          targets: [],
          receiptIds: [],
          issues: [
            issue(
              "backup-failed",
              error instanceof Error
                ? error.message
                : "Recovery material could not be saved; no operation effect was started.",
              "inspect-recovery",
            ),
          ],
          recoveryAvailable: false,
        };
        await options.recordResult?.(result, prepared);
        await options.journal.write({
          ...prepared,
          status: "terminal",
          result,
          updatedAt: new Date(now()).toISOString(),
          steps: prepared.steps.map((step) => ({ ...step, status: "failed" })),
        });
        return result;
      }
      let applying: SkillOperationJournalRecord = {
        ...prepared,
        status: "applying",
        updatedAt: new Date(now()).toISOString(),
        steps: prepared.steps,
      };
      await options.journal.write(applying);
      const progress: SkillStepProgress = async (step) => {
        if (!applying.steps.some((saved) => saved.stepId === step.stepId))
          throw new Error("Unknown skill operation step.");
        applying = {
          ...applying,
          updatedAt: new Date(now()).toISOString(),
          steps: applying.steps.map((saved) =>
            saved.stepId === step.stepId
              ? {
                  ...saved,
                  ...step,
                  ...(step.receiptId === undefined && saved.receiptId !== undefined
                    ? { receiptId: saved.receiptId }
                    : {}),
                  ...(step.actions === undefined && saved.actions !== undefined ? { actions: saved.actions } : {}),
                }
              : saved,
          ),
        };
        await options.journal.write(applying);
        options.onProgress?.(intentId);
      };
      let outcome: SkillEffectOutcome;
      try {
        outcome = await options.effects.apply(intentId, record.intent, actor, authorization, effect, progress);
      } catch (error: unknown) {
        outcome = {
          ...recoveryResult(applying),
          issues: [
            issue(
              "effect-failed",
              error instanceof Error ? error.message : "The operation failed before verification.",
              "inspect-recovery",
            ),
          ],
        };
      }

      // Legacy adapters report attempted rollback without verifying its final state.
      if ((outcome.status === "failed" || outcome.status === "partial") && outcome.recoveryAvailable) {
        outcome = {
          ...outcome,
          status: "recovery-required",
          source: outcome.source.status === "failed" ? { ...outcome.source, status: "unknown" } : outcome.source,
          targets: outcome.targets.map((target) =>
            target.status === "failed" ? { ...target, status: "unknown" } : target,
          ),
        };
        if (effect.steps.length === 1 && outcome.receiptIds[0])
          applying = {
            ...applying,
            steps: applying.steps.map((step) => ({ ...step, receiptId: outcome.receiptIds[0] })),
          };
      }

      const finalStatus: SkillResult["status"] = outcome.status;
      const result: SkillResult = { intentId, operationId: intentId, ...outcome };
      const terminalRecord: SkillOperationJournalRecord = {
        ...applying,
        status: finalStatus === "recovery-required" ? "recovery-required" : "terminal",
        result,
        updatedAt: new Date(now()).toISOString(),
        steps: applying.steps.map((step) => {
          if (finalStatus === "recovery-required" || ["applied", "failed", "skipped"].includes(step.status))
            return step;
          const effectStep = effect.steps.find((candidate) => candidate.stepId === step.stepId);
          const targets = outcome.targets.filter((target) =>
            effectStep?.scope.targets.some((scope) => scope.bindingId === target.bindingId),
          );
          const status =
            targets.some((target) => target.status === "failed") || (!targets.length && finalStatus === "failed")
              ? ("failed" as const)
              : targets.length && targets.every((target) => target.status === "skipped")
                ? ("skipped" as const)
                : ("applied" as const);
          return {
            ...step,
            status,
            ...(effect.steps.length === 1 && outcome.receiptIds[0] ? { receiptId: outcome.receiptIds[0] } : {}),
          };
        }),
      };
      await options.recordResult?.(result, terminalRecord);
      await options.journal.write(terminalRecord);
      options.onProgress?.(intentId);
      return result;
    } finally {
      for (const key of keys) locks.delete(key);
    }
  };

  const apply = (intentId: string, authorization: SkillAuthorization): Promise<SkillResult> => {
    const existing = running.get(intentId);
    if (existing) return existing;
    const operation = applyOnce(intentId, authorization).finally(() => running.delete(intentId));
    running.set(intentId, operation);
    return operation;
  };

  const readResult = async (intentId: string): Promise<SkillResult | undefined> => {
    const loaded = await options.journal.read(intentId);
    if (loaded.status !== "ready") return undefined;
    const record = loaded.record;
    if (record.result) return record.result;
    if (running.has(intentId)) {
      const progress = recoveryResult(record);
      return {
        ...progress,
        status: "applying",
        issues: [],
        recoveryAvailable: false,
        targets: progress.targets.map((target) => {
          const step = record.effect?.steps.find((candidate) =>
            candidate.scope.targets.some((scope) => scope.bindingId === target.bindingId),
          );
          const saved = record.steps.find((candidate) => candidate.stepId === step?.stepId);
          return saved?.status === "prepared" ? { ...target, status: "pending" as const } : target;
        }),
      };
    }
    if (
      record.status === "prepared" ||
      record.status === "applying" ||
      record.status === "verifying" ||
      record.status === "recovery-required"
    )
      return recoveryResult({ ...record, status: "recovery-required" });
    return undefined;
  };

  const listRecoveries = async (): Promise<readonly SkillResult[]> => {
    const saved = await options.journal.list();
    if (saved.status !== "ready") throw new Error("The recovery journal is unavailable.");
    return saved.records
      .filter((record) => record.status === "recovery-required")
      .map((record) => record.result ?? recoveryResult(record));
  };
  return { initialize, preview, refresh, apply, readResult, listRecoveries };
}
