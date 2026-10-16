import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { SkillEffectDraft } from "../../application/skill-management";
import type { SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillUseEffect } from "../../domain/skill-reconciliation/types";
import type { SkillEffectStep, SkillResult } from "../../shared/skill-management-ipc";
import type { SkillResolutionSnapshot } from "./resolution-reader";
import { createUnifiedDiff } from "../../domain/unified-diff";
import { readRegularFile, safePath } from "../operation-files";

export type ReadyResolutionSnapshot = Extract<SkillResolutionSnapshot, { status: "ready" }>;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

export function hash(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
}

export function locationKey(location: SkillUseEffect["location"]): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

export function originalResolutionStep(record: SkillOperationJournalRecord): SkillEffectStep {
  if (record.intent.kind !== "reconcile" || record.intent.request.choice === "adopt-exact")
    throw new Error("The saved operation is not a managed resolution.");
  const step = record.effect?.steps.find(
    (candidate) => candidate.plan.kind === "resolve-skill" && candidate.resolutionEvidence,
  );
  if (!step || !step.resolutionEvidence || step.resolutionEvidence.choice !== "use-canonical")
    throw new Error("Only a canonical replacement can be restored.");
  return step;
}

export function resolutionRestoreSummary(
  step: SkillEffectStep,
  status: NonNullable<SkillResult["resolution"]>["targets"][number]["status"],
) {
  const evidence = step.resolutionEvidence!;
  return {
    skillId: evidence.skillId,
    choice: evidence.choice,
    targets: [{ location: evidence.local.location, bindingId: evidence.use.bindingId, status }],
  } as const;
}

export function resolutionRestoreTargets(
  step: SkillEffectStep,
  status: SkillResult["targets"][number]["status"],
): SkillResult["targets"] {
  const evidence = step.resolutionEvidence!;
  return [
    {
      projectId: evidence.local.location.projectId,
      harnessId: evidence.local.location.harnessId,
      bindingId: evidence.use.bindingId,
      artifactPath: evidence.binding.artifactPath,
      status,
    },
  ];
}

export function reverseResolutionUseEffects(step: SkillEffectStep): readonly SkillUseEffect[] {
  return (step.metadataEffects ?? []).map((effect) => ({
    skillId: effect.skillId,
    location: effect.location,
    ...(effect.after ? { before: effect.after } : {}),
    ...(effect.before ? { after: effect.before } : {}),
  }));
}

export function reverseResolutionBindingEffects(step: SkillEffectStep): SkillEffectStep["bindingEffects"] {
  return step.bindingEffects.map((effect) => ({
    bindingId: effect.bindingId,
    ...(effect.after ? { before: effect.after } : {}),
    ...(effect.before ? { after: effect.before } : {}),
  }));
}

function reverseResolutionFiles(step: SkillEffectStep): SkillEffectStep["files"] {
  const local = new Map(step.resolutionEvidence!.local.revision.files.map((file) => [file.path, file]));
  const canonicalFiles = new Map(step.resolutionEvidence!.sourceTree!.revision.files.map((file) => [file.path, file]));
  const folder = step.resolutionEvidence!.local.location.folderPath;
  return step.files.map((file) => {
    const change =
      file.change === "add" ? ("delete" as const) : file.change === "delete" ? ("add" as const) : ("change" as const);
    const path = file.relativePath.slice(folder.length + 1);
    const byteLength = local.get(path)?.byteLength ?? canonicalFiles.get(path)?.byteLength;
    return {
      rootId: file.rootId,
      relativePath: file.relativePath,
      change,
      ...(byteLength === undefined ? {} : { byteLength }),
      ...(file.afterHash === undefined ? {} : { beforeHash: file.afterHash }),
      ...(file.beforeHash === undefined ? {} : { afterHash: file.beforeHash }),
    };
  });
}

function restoreStep(source: SkillEffectStep, stepId: string): SkillEffectStep {
  const files = reverseResolutionFiles(source);
  const actions = files.map((file) => ({
    kind: file.change === "delete" ? ("delete-file" as const) : ("write-file" as const),
    relativePath: file.relativePath,
    ...(file.byteLength === undefined || file.change === "delete" ? {} : { byteLength: file.byteLength }),
    ...(file.beforeHash === undefined ? {} : { beforeHash: file.beforeHash }),
    ...(file.afterHash === undefined ? {} : { afterHash: file.afterHash }),
  }));
  return {
    stepId,
    scope: source.scope,
    plan: {
      planId: stepId,
      kind: "restore-apply",
      displayTarget: source.plan.displayTarget,
      actions,
      git: { mode: "disabled", warnings: [] },
    },
    bindingEffects: reverseResolutionBindingEffects(source),
    files,
    ...(source.metadataEffects ? { metadataEffects: reverseResolutionUseEffects(source) } : {}),
    baseReferences: source.baseReferences,
    resolutionEvidence: source.resolutionEvidence,
  };
}

export function buildResolutionRestoreEffect(
  source: SkillEffectStep,
  intentId: string,
  beforeBytes: ReadonlyMap<string, Uint8Array>,
  afterBytes: ReadonlyMap<string, Uint8Array>,
): SkillEffectDraft {
  const restored = restoreStep(source, randomUUID());
  const folder = source.resolutionEvidence!.local.location.folderPath;
  const files = restored.files.map((file) => {
    const inner = file.relativePath.slice(folder.length + 1);
    const prior = beforeBytes.get(inner) ?? new Uint8Array();
    const proposed = afterBytes.get(inner) ?? new Uint8Array();
    const diff = createUnifiedDiff(
      `${file.relativePath} (canonical)`,
      `${file.relativePath} (restored)`,
      prior,
      proposed,
    );
    return diff.text === "binary file differs"
      ? { ...file, summary: "Binary file; complete byte length and hashes are shown." }
      : { ...file, diff: diff.text };
  });
  const step = { ...restored, files };
  const fingerprint: import("../../domain/skill-management-intent").SkillEffectFingerprint = {
    scope: step.scope,
    files: step.files,
    bindings: step.bindingEffects,
    actions: step.plan.actions.map((action) => ({
      rootId: source.resolutionEvidence!.local.location.projectId,
      kind: action.kind,
      relativePath: action.relativePath,
      ...(action.beforeHash ? { beforeHash: action.beforeHash } : {}),
      ...(action.afterHash ? { afterHash: action.afterHash } : {}),
    })),
    metadataEffects: step.metadataEffects,
    baseReferences: step.baseReferences,
    resolutionEvidence: step.resolutionEvidence,
  };
  return {
    status: "ready",
    planId: step.stepId,
    scope: step.scope,
    steps: [step],
    fingerprint,
    backupReferences: [
      {
        rootId: source.resolutionEvidence!.local.location.projectId,
        path: `backups/skill-intents/${intentId}/before-managed-resolution`,
      },
    ],
  };
}

export function resolutionRequestFor(
  step: SkillEffectStep,
): import("../../shared/skill-reconciliation-request").SkillManagedResolutionRequest {
  const evidence = step.resolutionEvidence!;
  return { choice: "use-canonical", skillId: evidence.skillId, locations: [evidence.local.location] };
}

export function stateAtExpectedResolutionBytes(snapshot: ReadyResolutionSnapshot, step: SkillEffectStep): boolean {
  if (!step.files.length) return true;
  const evidence = step.resolutionEvidence!;
  const before = new Map(evidence.local.revision.files.map((file) => [file.path, file.hash]));
  const after = new Map(evidence.sourceTree!.revision.files.map((file) => [file.path, file.hash]));
  const current = new Map(snapshot.localTree.revision.files.map((file) => [file.path, file.hash]));
  const knownPaths = new Set([...before.keys(), ...after.keys()]);
  if ([...current.keys()].some((path) => !knownPaths.has(path))) return false;
  for (const path of knownPaths) {
    const actual = current.get(path);
    if (actual !== before.get(path) && actual !== after.get(path)) return false;
  }
  return true;
}

export function metadataAtExpectedResolutionStates(snapshot: ReadyResolutionSnapshot, step: SkillEffectStep): boolean {
  const evidence = step.resolutionEvidence!;
  const use = snapshot.relationships.uses.find(
    (candidate) => locationKey(candidate.location) === locationKey(evidence.local.location),
  );
  const forwardUse = step.metadataEffects?.[0]?.after ?? evidence.use;
  const forwardBinding = step.bindingEffects[0]?.after ?? evidence.binding;
  return (
    (canonical(use) === canonical(evidence.use) || canonical(use) === canonical(forwardUse)) &&
    (canonical(snapshot.binding) === canonical(evidence.binding) ||
      canonical(snapshot.binding) === canonical(forwardBinding))
  );
}

export function stateAtCompletedResolutionEffect(snapshot: ReadyResolutionSnapshot, step: SkillEffectStep): boolean {
  const evidence = step.resolutionEvidence!;
  const expectedUse = step.metadataEffects?.[0]?.after ?? evidence.use;
  const expectedBinding = step.bindingEffects[0]?.after ?? evidence.binding;
  return (
    (!step.files.length || canonical(snapshot.localTree.revision) === canonical(evidence.sourceTree?.revision)) &&
    canonical(snapshot.use) === canonical(expectedUse) &&
    canonical(snapshot.binding) === canonical(expectedBinding)
  );
}

async function backupDirectory(userDataPath: string, intentId: string): Promise<string> {
  const path = await safePath(userDataPath, `omni/backups/skill-intents/${intentId}/before-managed-resolution`);
  const root = await realpath(path);
  const parent = await realpath(userDataPath);
  const distance = relative(parent, root);
  if (distance === ".." || distance.startsWith(`..${sep}`) || (await lstat(path)).isSymbolicLink())
    throw new Error("The verified resolution backup escaped the profile.");
  return path;
}

async function backupPaths(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const visit = async (folder: string, prefix: string): Promise<void> => {
    for (const name of await readdir(folder)) {
      const path = join(folder, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("The saved resolution backup contains a symbolic link.");
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (stat.isDirectory()) await visit(path, relativePath);
      else if (stat.isFile()) paths.push(relativePath);
      else throw new Error("The saved resolution backup contains a special file.");
    }
  };
  await visit(root, "");
  return paths.sort((a, b) => a.localeCompare(b));
}

export async function verifyResolutionBackup(
  args: Readonly<{ userDataPath: string; record: SkillOperationJournalRecord; step: SkillEffectStep }>,
): Promise<Readonly<{ root: string; bytes: ReadonlyMap<string, Uint8Array> }>> {
  const evidence = args.step.resolutionEvidence!;
  if (!args.step.files.length) return { root: "", bytes: new Map() };
  const expected = evidence.local.revision.files
    .map((file) => `${evidence.local.location.folderPath}/${file.path}`)
    .sort((a, b) => a.localeCompare(b));
  if (!expected.length) return { root: "", bytes: new Map() };
  const root = await backupDirectory(args.userDataPath, args.record.intentId);
  if (canonical(await backupPaths(root)) !== canonical(expected))
    throw new Error("The complete before-resolution backup does not match the reviewed local tree.");
  const bytes = new Map<string, Uint8Array>();
  for (const file of evidence.local.revision.files) {
    const path = `${evidence.local.location.folderPath}/${file.path}`;
    const content = await readRegularFile(root, path);
    if (!content || content.byteLength !== file.byteLength || hash(content) !== file.hash)
      throw new Error(`The saved before-resolution file is missing or corrupt: ${file.path}`);
    bytes.set(file.path, content);
  }
  return { root, bytes };
}
