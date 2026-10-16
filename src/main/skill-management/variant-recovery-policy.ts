import { createHash } from "node:crypto";

import type { SkillEffectDraft } from "../../application/skill-management";
import type { SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillEffectStep, SkillFileSummary } from "../../shared/skill-management-ipc";
import type { OperationActionReceipt, OperationReceipt } from "../../shared/operations-ipc";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { PreparedVariantPayload } from "./variant-publication";

import { type VariantPublicationInspection } from "./variant-publication-inspection";
import { readSkillVariantManifestSnapshot } from "./variant-origin-reader";
import { parsePackageManifest } from "../../domain/marketplace-format";
import { variantPayloadFolder } from "./variant-payload";
import { createUnifiedDiff } from "../../domain/unified-diff";

export type CaptureStep = SkillEffectStep &
  Readonly<{ variantCaptureEvidence: NonNullable<SkillEffectStep["variantCaptureEvidence"]> }>;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

export function uuid(seed: string): string {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function originalCaptureStep(record: SkillOperationJournalRecord): CaptureStep {
  if (record.intent.kind !== "reconcile" || record.intent.request.choice !== "keep-variant")
    throw new Error("The saved operation is not a personal variant capture.");
  const step = record.effect?.steps.find(({ variantCaptureEvidence }) => variantCaptureEvidence);
  if (!step || step.plan.kind !== "capture-skill" || !step.variantCaptureEvidence || step.stepId !== step.plan.planId)
    throw new Error("The saved personal variant capture evidence is incomplete.");
  if (canonical(step.variantCaptureEvidence.request) !== canonical(record.intent.request))
    throw new Error("The saved capture evidence does not match its request.");
  return step as CaptureStep;
}

function sameActions(
  left: readonly Readonly<{ kind: string; relativePath: string; beforeHash?: string; afterHash?: string }>[],
  right: readonly Readonly<{ kind: string; relativePath: string; beforeHash?: string; afterHash?: string }>[],
): boolean {
  const project = (values: typeof left) =>
    values.map(({ kind, relativePath, beforeHash, afterHash }) => ({ kind, relativePath, beforeHash, afterHash }));
  return canonical(project(left)) === canonical(project(right));
}

export function resolveSkillVariantCaptureReceiptRecord(
  receipt: OperationReceipt,
  record: SkillOperationJournalRecord,
): SkillOperationJournalRecord | undefined {
  try {
    if (
      receipt.kind !== "capture-skill" ||
      receipt.status !== "applied" ||
      receipt.restored ||
      !receipt.capture ||
      receipt.operationId !== receipt.capture.stepId ||
      record.intentId !== receipt.capture.intentId
    )
      return undefined;
    const step = originalCaptureStep(record);
    const evidence = step.variantCaptureEvidence;
    const expectedActions = step.plan.actions.map(({ kind, relativePath, beforeHash, afterHash }) => ({
      kind,
      relativePath,
      beforeHash,
      afterHash,
    }));
    if (
      receipt.source?.kind !== "source" ||
      receipt.source.id !== evidence.destination.source.sourceId ||
      receipt.source.relativePath !== evidence.destination.packageRoot ||
      receipt.registered !== null ||
      receipt.project ||
      receipt.bindings ||
      receipt.actions.length !== expectedActions.length ||
      !sameActions(receipt.actions, expectedActions)
    )
      return undefined;
    const expectedFiles = step.files
      .filter(({ relativePath }) => relativePath !== evidence.destination.manifest.relativePath)
      .map(({ relativePath, afterHash }) => ({ relativePath, contentHash: afterHash }));
    if (
      canonical(receipt.files) !== canonical(expectedFiles) ||
      receipt.manifests?.length !== 1 ||
      canonical(receipt.manifests[0]) !==
        canonical({
          relativePath: evidence.destination.manifest.relativePath,
          beforeHash: evidence.destination.manifest.beforeHash,
          afterHash: step.files.find(({ relativePath }) => relativePath === evidence.destination.manifest.relativePath)
            ?.afterHash,
        }) ||
      canonical(receipt.createdDirectories ?? []) !==
        canonical(
          record.steps
            .find(({ stepId }) => stepId === step.stepId)
            ?.actions?.filter(({ kind, status }) => kind === "create-directory" && status === "applied")
            .map(({ relativePath }) => relativePath) ?? [],
        )
    )
      return undefined;
    return record;
  } catch {
    return undefined;
  }
}

export function expectedSourceBindings(
  step: CaptureStep,
  bindings: readonly import("../../domain/assignment-plan").Binding[],
): readonly import("../../domain/assignment-plan").Binding[] {
  const evidence = step.variantCaptureEvidence;
  return bindings.filter(
    (binding) =>
      binding.sourceId === evidence.destination.source.sourceId &&
      binding.packageId === evidence.destination.source.packageId &&
      binding.artifactPath.replace(/\/SKILL\.md$/u, "") === evidence.destination.source.artifactPath,
  );
}

function captureProgress(record: SkillOperationJournalRecord, step: CaptureStep) {
  const saved = record.steps.find(({ stepId }) => stepId === step.stepId);
  if (!saved) throw new Error("The capture journal has no matching step state.");
  const actions = saved.actions ?? [];
  const find = (kind: string, relativePath: string) =>
    actions.find((action) => action.kind === kind && action.relativePath === relativePath);
  return { saved, find };
}

export function priorRestoreRecord(
  records: readonly SkillOperationJournalRecord[],
  original: SkillOperationJournalRecord,
  step: CaptureStep,
): SkillOperationJournalRecord | undefined {
  const sourceOperationIds = new Set([original.intentId, step.stepId]);
  return [...records]
    .filter(
      (candidate) =>
        candidate.intent.kind === "restore" &&
        sourceOperationIds.has(candidate.intent.operationId) &&
        candidate.effect?.steps.some(
          (saved) =>
            saved.variantCaptureEvidence?.origin.variantId === step.variantCaptureEvidence.origin.variantId &&
            saved.plan.kind === "restore-apply",
        ) &&
        candidate.steps.some((saved) =>
          saved.actions?.some(
            (action) =>
              action.kind === "delete-file" || action.kind === "restore-manifest" || action.kind === "remove-directory",
          ),
        ),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function validateReceiptOrJournalState(
  original: SkillOperationJournalRecord,
  step: CaptureStep,
  payload: PreparedVariantPayload,
  inspection: VariantPublicationInspection,
  receipt?: OperationReceipt,
  priorRestore?: SkillOperationJournalRecord,
): readonly Readonly<{ relativePath: string; identity: string }>[] {
  const { saved, find } = captureProgress(original, step);
  const inverseActions = (priorRestore?.steps ?? []).flatMap((candidate) => candidate.actions ?? []);
  const hasInverse = (kind: string, relativePath: string, beforeHash?: string, afterHash?: string) =>
    inverseActions.some(
      (action) =>
        action.kind === kind &&
        action.relativePath === relativePath &&
        ["applying", "applied"].includes(action.status) &&
        (beforeHash === undefined || action.beforeHash === beforeHash) &&
        (afterHash === undefined || action.afterHash === afterHash),
    );
  const interrupted =
    original.status === "recovery-required" || saved.status === "recovery-required" || saved.status === "failed";
  const completed =
    original.status === "terminal" && original.result?.status === "applied" && saved.status === "applied";
  if (completed && !receipt)
    throw new Error("The completed capture receipt is unavailable or does not match its journal link.");
  if (receipt && !resolveSkillVariantCaptureReceiptRecord(receipt, original))
    throw new Error("The capture receipt does not match the saved effect and journal.");
  if (!interrupted && !completed && !receipt) throw new Error("The capture has no durable recovery state.");
  for (const path of inspection.presentFiles) {
    const action = find("write-file", path);
    if (
      !action ||
      !["applying", "applied", "failed"].includes(action.status) ||
      action.afterHash !== payload.index.files.find((entry) => entry.relativePath === path)?.hash ||
      !action.identity ||
      action.identity !== inspection.fileIdentities[path]
    )
      throw new Error("A captured file is present without matching durable write progress.");
  }
  if (completed && priorRestore) {
    for (const entry of payload.index.files) {
      if (
        !inspection.presentFiles.includes(entry.relativePath) &&
        !hasInverse("delete-file", entry.relativePath, entry.hash)
      )
        throw new Error("A captured file is absent without matching inverse progress.");
    }
  }
  const manifestAction = find("write-manifest", payload.index.manifest.relativePath);
  if (
    inspection.manifestState === "after" &&
    (!manifestAction ||
      !["applying", "applied", "failed"].includes(manifestAction.status) ||
      manifestAction.afterHash !== payload.index.manifest.afterHash)
  )
    throw new Error("The captured manifest is present without matching durable publication progress.");
  const skillsRoot = variantPayloadFolder(payload).split("/").slice(0, -1).join("/");
  for (const directory of inspection.presentDirectories) {
    if (directory.relativePath === skillsRoot && !find("create-directory", directory.relativePath)) continue;
    const action = find("create-directory", directory.relativePath);
    if (
      !action ||
      !["applying", "applied"].includes(action.status) ||
      (action.identity && action.identity !== directory.identity)
    )
      throw new Error("A captured directory is present without matching durable creation progress.");
    if (!action.identity)
      throw new Error("A captured directory has no saved identity; its ownership cannot be verified safely.");
  }
  if (
    completed &&
    inspection.manifestState === "before" &&
    (!priorRestore ||
      !hasInverse(
        "restore-manifest",
        payload.index.manifest.relativePath,
        payload.index.manifest.afterHash,
        payload.index.manifest.beforeHash,
      ))
  )
    throw new Error("The pre-capture manifest is present without matching inverse progress.");
  if (
    completed &&
    !priorRestore &&
    (inspection.manifestState !== "after" ||
      inspection.presentFiles.length !== payload.index.files.length ||
      payload.index.directories.some(
        (path) => !inspection.presentDirectories.some((entry) => entry.relativePath === path),
      ))
  )
    throw new Error("The completed capture no longer has its exact published after-state.");
  if (completed && priorRestore) {
    for (const path of payload.index.directories) {
      if (inspection.presentDirectories.some((entry) => entry.relativePath === path)) continue;
      const forward = find("create-directory", path);
      if (forward && !hasInverse("remove-directory", path))
        throw new Error("A capture directory is absent without matching inverse progress.");
      if (!forward && path === skillsRoot)
        throw new Error("The original skills directory disappeared outside the capture inverse.");
    }
  }
  return inspection.presentDirectories
    .flatMap(({ relativePath }) => {
      const action = find("create-directory", relativePath);
      return action?.status === "applied" && action.identity ? [{ relativePath, identity: action.identity }] : [];
    })
    .sort(
      (left, right) =>
        right.relativePath.split("/").length - left.relativePath.split("/").length ||
        right.relativePath.localeCompare(left.relativePath),
    );
}

export function validateManifest(
  snapshot: Awaited<ReturnType<typeof readSkillVariantManifestSnapshot>>,
  step: CaptureStep,
  inspection: VariantPublicationInspection,
): void {
  if (!snapshot) throw new Error("The captured personal source is unavailable.");
  const evidence = step.variantCaptureEvidence;
  if (
    snapshot.packageRoot !== evidence.destination.packageRoot ||
    snapshot.manifestPath !== evidence.destination.manifest.relativePath ||
    snapshot.rootIdentity !== evidence.destination.rootIdentity
  )
    throw new Error("The selected personal source root or package changed after capture.");
  const manifest = parsePackageManifest(JSON.parse(Buffer.from(inspection.manifestBytes).toString("utf8")) as unknown);
  const entries = manifest.artifacts.filter(
    ({ kind, path }) => kind === "skill" && path === evidence.destination.source.artifactPath,
  );
  if (inspection.manifestState === "before" && entries.length !== 0)
    throw new Error("The pre-capture manifest already contains the selected variant.");
  if (
    inspection.manifestState === "after" &&
    (entries.length !== 1 || canonical(entries[0]?.variantOrigin) !== canonical(evidence.origin))
  )
    throw new Error("The captured artifact origin differs from its exact saved entry.");
}

export function selectedVariantBindingOrUseExists(
  step: CaptureStep,
  relationships: Awaited<ReturnType<SkillRelationshipStore["read"]>>,
  bindingRead: Awaited<ReturnType<BindingsStore["read"]>>,
): boolean {
  if (relationships.status !== "ready" || bindingRead.status !== "ready") return true;
  const source = step.variantCaptureEvidence.destination.source;
  const use = relationships.state.uses.some(
    (item) =>
      item.source.sourceId === source.sourceId &&
      item.source.packageId === source.packageId &&
      item.source.artifactPath === source.artifactPath,
  );
  return use || expectedSourceBindings(step, bindingRead.bindings).length > 0;
}

export function originalMetadataMatches(
  step: CaptureStep,
  relationships: Awaited<ReturnType<SkillRelationshipStore["read"]>>,
  bindingRead: Awaited<ReturnType<BindingsStore["read"]>>,
): boolean {
  if (relationships.status !== "ready" || bindingRead.status !== "ready") return false;
  const evidence = step.variantCaptureEvidence;
  const location = evidence.request.locations[0]!;
  const record = relationships.state.skills.find(({ skillId }) => skillId === evidence.request.skillId);
  const uses = relationships.state.uses.filter((use) => canonical(use.location) === canonical(location));
  const bindings = evidence.binding
    ? bindingRead.bindings.filter((binding) => binding.bindingId === evidence.binding?.bindingId)
    : [];
  return (
    canonical(record) === canonical(evidence.record) &&
    canonical(uses[0]) === canonical(evidence.use) &&
    uses.length === (evidence.use ? 1 : 0) &&
    canonical(bindings[0]) === canonical(evidence.binding) &&
    bindings.length === (evidence.binding ? 1 : 0)
  );
}

export function buildRestoreEffect(
  record: SkillOperationJournalRecord,
  originalStep: CaptureStep,
  payload: PreparedVariantPayload,
  inspection: VariantPublicationInspection,
  intentId: string,
): SkillEffectDraft {
  const evidence = originalStep.variantCaptureEvidence;
  const files: SkillFileSummary[] = inspection.presentFiles.map((relativePath) => {
    const entry = payload.index.files.find((file) => file.relativePath === relativePath)!;
    return {
      rootId: evidence.destination.source.sourceId,
      relativePath,
      change: "delete",
      beforeHash: entry.hash,
      byteLength: entry.byteLength,
      diff: createUnifiedDiff(
        relativePath,
        `${relativePath} (removed)`,
        payload.files.get(relativePath)!,
        new Uint8Array(),
      ).text,
    };
  });
  if (inspection.manifestState === "after")
    files.push({
      rootId: evidence.destination.source.sourceId,
      relativePath: payload.index.manifest.relativePath,
      change: "change",
      beforeHash: payload.index.manifest.afterHash,
      afterHash: payload.index.manifest.beforeHash,
      byteLength: payload.manifestBefore.byteLength,
      diff: createUnifiedDiff(
        payload.index.manifest.relativePath,
        payload.index.manifest.relativePath,
        payload.manifestAfter,
        payload.manifestBefore,
      ).text,
    });
  const actions = files.map((file) => ({
    kind: file.change === "delete" ? ("delete-file" as const) : ("write-file" as const),
    relativePath: file.relativePath,
    ...(file.beforeHash ? { beforeHash: file.beforeHash } : {}),
    ...(file.afterHash ? { afterHash: file.afterHash } : {}),
    ...(file.relativePath === payload.index.manifest.relativePath
      ? { byteLength: payload.manifestBefore.byteLength, manifest: true }
      : { byteLength: file.byteLength }),
  }));
  const stepId = uuid(`${record.intentId}\nrestore-captured-variant`);
  const step: SkillEffectStep = {
    stepId,
    scope: originalStep.scope,
    plan: {
      planId: stepId,
      kind: "restore-apply",
      displayTarget: originalStep.plan.displayTarget,
      actions,
      git: { mode: "disabled", warnings: [] },
    },
    bindingEffects: [],
    files,
    variantCaptureEvidence: evidence,
  };
  return {
    status: "ready",
    planId: stepId,
    scope: step.scope,
    steps: [step],
    fingerprint: {
      scope: step.scope,
      files,
      bindings: [],
      actions: actions.map(({ kind, relativePath, beforeHash, afterHash }) => ({
        rootId: evidence.destination.source.sourceId,
        kind,
        relativePath,
        ...(beforeHash ? { beforeHash } : {}),
        ...(afterHash ? { afterHash } : {}),
      })),
      variantCaptureEvidence: evidence,
    },
    backupReferences: [{ rootId: "omni-profile", path: `skill-variant-captures/${record.intentId}` }],
  };
}
