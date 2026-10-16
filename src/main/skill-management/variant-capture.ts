import { createHash } from "node:crypto";

import { createUnifiedDiff } from "../../domain/unified-diff";
import { parsePackageManifest } from "../../domain/marketplace-format";
import { planSkillVariantCapture } from "../../domain/skill-reconciliation/variant-capture";
import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillEffectFingerprint } from "../../domain/skill-management-intent";
import type { SkillVariantCaptureRequest } from "../../shared/skill-variant-capture-request";
import type { SkillIntent, SkillIssue, SkillEffectStep, SkillFileSummary } from "../../shared/skill-management-ipc";
import type { SkillVariantSnapshot, SkillVariantReaderDependencies } from "./variant-reader";
import { readSkillVariantSnapshot } from "./variant-reader";
import {
  prepareVariantPayload,
  readPreparedVariantPayload,
  publishVariantCapture,
  preparedPayloadMatchesRevision,
} from "./variant-publication";
import { createSkillVariantCaptureReceipt } from "./variant-receipt";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";
import type { SkillJournalAction, SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { OperationStore } from "../operation-store";
import type { SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { RegistryGrant } from "../registry-ipc";

type CaptureIntent = Extract<SkillIntent, { kind: "reconcile" }> & Readonly<{ request: SkillVariantCaptureRequest }>;
type ReadySnapshot = Extract<SkillVariantSnapshot, { status: "ready" }>;
type CaptureBuildFailure = Extract<SkillEffectBuild, { status: "blocked" | "needs-input" }>;
type PreparedCapture = Readonly<{
  intentId: string;
  createdAt: string;
  request: SkillVariantCaptureRequest;
  snapshot: ReadySnapshot;
  step: SkillEffectStep;
  manifestAfter: Uint8Array;
  files: ReadonlyMap<string, Uint8Array>;
  directories: readonly string[];
  skillsDirectoryPresent: boolean;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

function uuid(seed: string): string {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function physicalRoot(packageRoot: string): string {
  return packageRoot === "root" ? "" : packageRoot;
}

function relativePath(packageRoot: string, artifactPath: string, child = ""): string {
  return [physicalRoot(packageRoot), artifactPath, child].filter(Boolean).join("/");
}

function issue(code: string, message: string, recoveryAction: SkillIssue["recoveryAction"]): SkillIssue {
  return { code, message, recoveryAction };
}

function blocked(code: string, message: string, status: "blocked" | "needs-input" = "blocked"): CaptureBuildFailure {
  return {
    status,
    reason: message,
    details: [issue(code, message, status === "needs-input" ? "choose-targets" : "reconnect")],
  };
}

function manifestAfter(snapshot: ReadySnapshot, origin: unknown): Uint8Array {
  const before = Buffer.from(snapshot.manifestBefore).toString("utf8");
  const raw = JSON.parse(before) as Record<string, unknown>;
  if (!Array.isArray(raw.artifacts)) throw new Error("The selected plugin manifest has no artifact list.");
  raw.artifacts = [...raw.artifacts, { kind: "skill", path: snapshot.source.artifactPath, variantOrigin: origin }];
  parsePackageManifest(raw);
  const indentation = /\n([ \t]+)"/u.exec(before)?.[1] ?? "  ";
  const encoded = `${JSON.stringify(raw, null, indentation)}\n`;
  parsePackageManifest(JSON.parse(encoded) as unknown);
  return Buffer.from(encoded, "utf8");
}

function targetDirectories(snapshot: ReadySnapshot): string[] {
  const root = relativePath(snapshot.packageRoot, snapshot.source.artifactPath);
  const skillsRoot = relativePath(snapshot.packageRoot, "skills");
  const directories = [root, skillsRoot];
  for (const entry of snapshot.localTree.manifest.entries) {
    if (entry.kind === "directory") directories.push(`${root}/${entry.path}`);
  }
  return [...new Set(directories)].sort(
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  );
}

function fileSummaries(snapshot: ReadySnapshot, afterManifest: Uint8Array): SkillFileSummary[] {
  const files = snapshot.localTree.revision.files.map((file): SkillFileSummary => {
    const path = relativePath(snapshot.packageRoot, snapshot.source.artifactPath, file.path);
    const bytes = snapshot.localTree.files.get(file.path)!;
    const diff = createUnifiedDiff(`${path} (absent)`, `${path} (captured copy)`, new Uint8Array(), bytes);
    return {
      rootId: snapshot.source.sourceId,
      relativePath: path,
      change: "add",
      byteLength: file.byteLength,
      afterHash: file.hash,
      ...(diff.text === "binary file differs"
        ? { summary: "Binary file; complete byte length and hash are shown." }
        : { diff: diff.text }),
    };
  });
  const beforeText = Buffer.from(snapshot.manifestBefore);
  const afterText = Buffer.from(afterManifest);
  const manifestDiff = createUnifiedDiff(
    `${snapshot.manifestPath} (current)`,
    `${snapshot.manifestPath} (proposed)`,
    beforeText,
    afterText,
  );
  files.push({
    rootId: snapshot.source.sourceId,
    relativePath: snapshot.manifestPath,
    change: "change",
    byteLength: afterManifest.byteLength,
    beforeHash: snapshot.manifestHash,
    afterHash: digest(afterManifest),
    diff: manifestDiff.text,
  });
  return files;
}

function actionFingerprint(step: SkillEffectStep): NonNullable<SkillEffectFingerprint["actions"]> {
  return step.plan.actions.map((action) => ({
    rootId: step.scope.sourceId!,
    kind: action.kind,
    relativePath: action.relativePath,
    ...(action.beforeHash ? { beforeHash: action.beforeHash } : {}),
    ...(action.afterHash ? { afterHash: action.afterHash } : {}),
  }));
}

function buildPrepared(
  intent: CaptureIntent,
  intentId: string,
  createdAt: string,
  snapshot: ReadySnapshot,
): PreparedCapture | CaptureBuildFailure {
  const planned = planSkillVariantCapture({
    request: intent.request,
    record: snapshot.record,
    storeRevision: snapshot.storeRevision,
    local: { rootIdentity: snapshot.rootIdentities.project, revision: snapshot.localTree.revision },
    destination: {
      source: snapshot.source,
      rootIdentity: snapshot.rootIdentities.source,
      packageRoot: snapshot.packageRoot,
      manifestPath: snapshot.manifestPath,
      beforeManifestHash: snapshot.manifestHash,
      existingArtifactKeys: snapshot.existingArtifactKeys,
      existingFolderNames: snapshot.existingFolderNames,
    },
    intentId,
    createdAt,
    ...(snapshot.use ? { use: snapshot.use } : {}),
    ...(snapshot.binding ? { binding: snapshot.binding } : {}),
  });
  if (planned.status !== "ready")
    return blocked(planned.code, planned.reason, planned.code === "destination-collision" ? "needs-input" : "blocked");
  const afterManifest = manifestAfter(snapshot, planned.evidence.origin);
  const files = fileSummaries(snapshot, afterManifest);
  const directories = targetDirectories(snapshot);
  const actions = [
    ...directories
      .filter((path) => !(snapshot.skillsDirectoryPresent && path === relativePath(snapshot.packageRoot, "skills")))
      .map((relativePath) => ({ kind: "create-directory" as const, relativePath })),
    ...files
      .filter(({ relativePath }) => relativePath !== snapshot.manifestPath)
      .map((file) => ({
        kind: "write-file" as const,
        relativePath: file.relativePath,
        byteLength: file.byteLength,
        afterHash: file.afterHash,
      })),
    {
      kind: "write-file" as const,
      relativePath: snapshot.manifestPath,
      byteLength: afterManifest.byteLength,
      beforeHash: snapshot.manifestHash,
      afterHash: digest(afterManifest),
      manifest: true,
      diff: files.at(-1)?.diff,
    },
  ];
  const stepId = uuid(`${intentId}\ncapture-skill-step`);
  const step: SkillEffectStep = {
    stepId,
    scope: planned.scope,
    plan: {
      planId: stepId,
      kind: "capture-skill",
      displayTarget: `${snapshot.source.packageId}/${snapshot.source.artifactPath}`,
      actions,
      git: { mode: "disabled", warnings: [] },
    },
    bindingEffects: [],
    files,
    variantCaptureEvidence: planned.evidence,
  };
  const fingerprint: SkillEffectFingerprint = {
    scope: step.scope,
    files: step.files,
    bindings: [],
    actions: actionFingerprint(step),
    variantCaptureEvidence: planned.evidence,
  };
  const draft: SkillEffectDraft = {
    status: "ready",
    planId: stepId,
    scope: step.scope,
    steps: [step],
    fingerprint,
    backupReferences: [{ rootId: "omni-profile", path: `skill-variant-captures/${intentId}` }],
  };
  const payloadFiles = new Map<string, Uint8Array>();
  for (const file of snapshot.localTree.revision.files) {
    payloadFiles.set(
      relativePath(snapshot.packageRoot, snapshot.source.artifactPath, file.path),
      snapshot.localTree.files.get(file.path)!,
    );
  }
  return {
    intentId,
    createdAt,
    request: intent.request,
    snapshot,
    step,
    manifestAfter: afterManifest,
    files: payloadFiles,
    directories,
    skillsDirectoryPresent: snapshot.skillsDirectoryPresent,
  };
}

function captureDetails(
  saved: PreparedCapture,
  status: "applied" | "failed" | "unknown",
): NonNullable<SkillEffectOutcome["capture"]> {
  return {
    choice: "keep-variant",
    skillId: saved.request.skillId,
    variantId: saved.step.variantCaptureEvidence!.origin.variantId,
    location: saved.request.locations[0]!,
    destination: saved.snapshot.source,
    status,
  };
}

function progressWithActions(progress: SkillStepProgress, step: SkillEffectStep) {
  return async (actions: readonly SkillJournalAction[]) =>
    progress({ stepId: step.stepId, status: "applying", actions });
}

export function createSkillVariantCaptureAdapter(
  args: Readonly<{
    userDataPath: string;
    registry: SkillVariantReaderDependencies["registry"];
    relationships: SkillVariantReaderDependencies["relationships"];
    bindings: SkillVariantReaderDependencies["bindings"];
    operationStore: OperationStore;
    filesystem?: SkillObservationFilesystem;
    now?: () => number;
  }>,
): Readonly<{
  preview(intent: CaptureIntent, intentId: string, createdAt: number): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  validateAuthorization(record: SkillOperationJournalRecord): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress: SkillStepProgress): Promise<SkillEffectOutcome>;
  has(planId: string): boolean;
}> {
  const now = args.now ?? Date.now;
  const plans = new Map<string, PreparedCapture>();
  const read = (request: SkillVariantCaptureRequest) =>
    readSkillVariantSnapshot(request, {
      registry: args.registry,
      relationships: args.relationships,
      bindings: args.bindings,
      ...(args.filesystem ? { filesystem: args.filesystem } : {}),
      now,
    });
  const getSaved = (effect: SkillEffectDraft): PreparedCapture => {
    const saved = plans.get(effect.planId);
    if (!saved || effect.steps.length !== 1 || effect.steps[0]?.stepId !== saved.step.stepId)
      throw new Error("The personal variant preview expired; review it again.");
    return saved;
  };
  const fresh = async (saved: PreparedCapture): Promise<ReadySnapshot> => {
    const current = await read(saved.request);
    if (current.status !== "ready") throw new Error(current.message);
    const rebuilt = buildPrepared(
      { kind: "reconcile", request: saved.request },
      saved.intentId,
      saved.createdAt,
      current,
    );
    if (
      !("step" in rebuilt) ||
      canonical(rebuilt.step.variantCaptureEvidence) !== canonical(saved.step.variantCaptureEvidence) ||
      canonical(rebuilt.directories) !== canonical(saved.directories) ||
      current.skillsDirectoryPresent !== saved.skillsDirectoryPresent ||
      canonical(current.localTree.manifest.entries) !== canonical(saved.snapshot.localTree.manifest.entries)
    ) {
      throw new Error("The approved project copy, destination, management records or grants changed after review.");
    }
    return current;
  };
  const preview = async (intent: CaptureIntent, intentId: string, createdAt: number): Promise<SkillEffectBuild> => {
    const snapshot = await read(intent.request);
    if (snapshot.status !== "ready") return blocked(snapshot.code, snapshot.message);
    const createdAtText = new Date(createdAt).toISOString();
    const built = buildPrepared(intent, intentId, createdAtText, snapshot);
    if ("status" in built) return built;
    const draft: SkillEffectDraft = {
      status: "ready",
      planId: built.step.stepId,
      scope: built.step.scope,
      steps: [built.step],
      fingerprint: {
        scope: built.step.scope,
        files: built.step.files,
        bindings: [],
        actions: actionFingerprint(built.step),
        variantCaptureEvidence: built.step.variantCaptureEvidence,
      },
      backupReferences: [{ rootId: "omni-profile", path: `skill-variant-captures/${intentId}` }],
    };
    plans.set(draft.planId, built);
    return draft;
  };
  const prepare = async (_intentId: string, effect: SkillEffectDraft): Promise<void> => {
    const saved = getSaved(effect);
    const current = await fresh(saved);
    const output = buildPrepared(
      { kind: "reconcile", request: saved.request },
      saved.intentId,
      saved.createdAt,
      current,
    );
    if (!("step" in output)) throw new Error(output.reason);
    await prepareVariantPayload({
      userDataPath: args.userDataPath,
      intentId: saved.intentId,
      files: output.files,
      directories: output.directories,
      manifestPath: current.manifestPath,
      manifestBefore: current.manifestBefore,
      manifestAfter: output.manifestAfter,
    });
  };
  const validateAuthorization = async (record: SkillOperationJournalRecord): Promise<void> => {
    if (record.intent.kind !== "reconcile" || record.intent.request.choice !== "keep-variant" || !record.effect) return;
    const saved = plans.get(record.effect.planId);
    if (!saved) throw new Error("The personal variant preview expired; refresh before applying.");
    await fresh(saved);
  };
  const apply = async (
    _intentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome> => {
    const saved = getSaved(effect);
    const snapshot = await fresh(saved);
    const payload = await readPreparedVariantPayload(args.userDataPath, saved.intentId);
    if (
      !payload ||
      !preparedPayloadMatchesRevision(payload, snapshot.localTree.revision) ||
      digest(payload.manifestAfter) !== digest(saved.manifestAfter)
    ) {
      throw new Error("The prepared capture payload is missing, corrupt or different from the reviewed copy.");
    }
    const receiptFn = progressWithActions(progress, saved.step);
    const publication = await publishVariantCapture({
      grant: snapshot.sourceGrant,
      filesystem: args.filesystem ?? strictSkillObservationFilesystem,
      payload,
      skillsDirectoryPresent: snapshot.skillsDirectoryPresent,
      progress: receiptFn,
    });
    const receipt = createSkillVariantCaptureReceipt(
      saved.intentId,
      saved.step,
      publication,
      new Date(now()).toISOString(),
    );
    if ((await args.operationStore.append(receipt)).status !== "ready")
      throw new Error("The personal variant receipt could not be saved; inspect recovery.");
    await progress({ stepId: saved.step.stepId, status: "applied", receiptId: receipt.operationId });
    return {
      status: "applied",
      source: { status: "updated", sourceId: snapshot.source.sourceId },
      targets: [],
      receiptIds: [receipt.operationId],
      receipts: [receipt],
      capture: captureDetails(saved, "applied"),
      issues: [],
      recoveryAvailable: true,
    };
  };
  return { preview, prepare, validateAuthorization, apply, has: (planId) => plans.has(planId) };
}
