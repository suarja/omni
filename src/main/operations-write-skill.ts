import { resolveObservedPackage } from "../domain/observed-package-resolution";
import { StorefrontTargetError } from "../domain/source-roles";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { checkSkill, type SkillFinding } from "../domain/skill-checks";
import type {
  ApplyOperationRequest,
  ApplyOperationResponse,
  OperationAction,
  OperationActionReceipt,
  OperationPlan,
  OperationReceipt,
  PreviewMarketplaceResponse,
} from "../shared/operations-ipc";
import { parseApplyOperationRequest, parsePreviewOperationRequest } from "../shared/operations-ipc";
import type { WriteSkillRequest } from "../shared/operations-write-skill-ipc";
import { readRegisteredSource } from "./operations-paths";
import type { OperationStore } from "./operation-store";
import type { GitCli } from "./git-cli";
import { observedLayout } from "./operations-import-plan";
import { hashContent, safeStat } from "./marketplace-manifests";
import {
  backupFiles,
  ensureDirectories,
  readRegularFile,
  removeDirectoryIfEmpty,
  removeFileOrEmptyDirectories,
  restoreBackup,
  writeAtomically,
} from "./operation-files";
import {
  buildWriteSkillPlan,
  buildSkillCheckProjection,
  gitMode,
  skillNames,
  type SkillManifestReceipt,
  type SkillPlannedAction,
} from "./operations-write-skill-plan";

type FileWriter = (
  path: string,
  content: string | Uint8Array,
  options: { encoding: "utf8"; mode: number },
) => Promise<void>;

type StoredPlan = Readonly<{
  plan: OperationPlan;
  operationId: string;
  sourceId: string;
  root: string;
  actions: readonly SkillPlannedAction[];
  backedUp?: boolean;
  manifests: readonly SkillManifestReceipt[];
  packageRoot: string;
  skillRoot: string;
  commitMessage: string;
  request: WriteSkillRequest;
}>;
type WriteSkillOptions = Readonly<{
  userDataPath: string;
  operationStore: OperationStore;
  git: GitCli;
  now?: () => number;
  fileWriter?: FileWriter;
}>;

function view(action: SkillPlannedAction): OperationAction {
  return {
    kind: action.kind,
    relativePath: action.relativePath,
    ...(action.byteLength === undefined ? {} : { byteLength: action.byteLength }),
    ...(action.beforeHash === undefined ? {} : { beforeHash: action.beforeHash }),
    ...(action.content === undefined ? {} : { afterHash: hashContent(action.content) }),
    ...(action.manifest === undefined ? {} : { manifest: action.manifest }),
    ...(action.diff === undefined ? {} : { diff: action.diff }),
  };
}

function block(reason: string, diagnostic: string, plan?: OperationPlan): PreviewMarketplaceResponse {
  return { status: "blocked", reason, diagnostic, ...(plan ? { plan } : {}) };
}

function hasErrors(findings: readonly SkillFinding[]): boolean {
  return findings.some((finding) => finding.severity === "error");
}

function filesForBackup(actions: readonly SkillPlannedAction[]): readonly string[] {
  return actions
    .filter((action) => action.beforeHash !== undefined || action.kind === "delete-file")
    .map((action) => action.relativePath);
}

function planForFindings(
  request: WriteSkillRequest,
  git: OperationPlan["git"],
  findings: readonly SkillFinding[],
): OperationPlan {
  return {
    planId: randomUUID(),
    kind: "write-skill",
    displayTarget: request.packageId ?? `packages/${request.newPackage!.name}`,
    actions: [],
    git,
    findings,
  };
}

function receiptFiles(actions: readonly SkillPlannedAction[]): NonNullable<OperationReceipt["files"]> {
  return actions
    .filter((action) => !action.manifest && (action.kind === "write-file" || action.kind === "delete-file"))
    .map((action) => ({
      relativePath: action.relativePath,
      contentHash: action.kind === "delete-file" ? action.beforeHash! : hashContent(action.content!),
      ...(action.beforeHash ? { previousHash: action.beforeHash } : {}),
    }));
}

function failedReceipt(
  stored: StoredPlan,
  now: number,
  actions: readonly OperationActionReceipt[],
  diagnostic: string,
  applyRequest?: ApplyOperationRequest,
): OperationReceipt {
  const agent = applyRequest?.provenance?.agent ?? stored.request.agent;
  const approval = applyRequest?.provenance?.approval;
  return {
    operationId: stored.operationId,
    kind: "write-skill",
    status: "failed",
    appliedAt: new Date(now).toISOString(),
    displayTarget: stored.plan.displayTarget,
    packageId: stored.request.packageId ?? `packages/${stored.request.newPackage!.name}`,
    actions,
    git: { mode: stored.plan.git.mode },
    registered: { sourceId: stored.sourceId },
    files: receiptFiles(stored.actions),
    manifests: stored.manifests,
    skillMode: stored.request.mode,
    ...(agent || approval || stored.request.reason
      ? {
          provenance: {
            ...(agent ? { agent } : {}),
            ...(approval ? { approval } : {}),
            ...(stored.request.reason ? { reason: stored.request.reason } : {}),
          },
        }
      : {}),
    diagnostic,
  };
}

export function createWriteSkillOperations(options: WriteSkillOptions): Readonly<{
  preview(raw: unknown, manifestCreatedAt?: number): Promise<PreviewMarketplaceResponse>;
  prepare(planId: string): Promise<void>;
  recoveryReference(planId: string): Readonly<{ sourceId: string; path: string }> | undefined;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const now = options.now ?? Date.now;
  const plans = new Map<string, StoredPlan>();
  const write = options.fileWriter;

  const prepare = async (planId: string): Promise<void> => {
    const stored = plans.get(planId);
    if (!stored) throw new Error("The approved skill plan is unavailable; preview it again.");
    if (stored.request.newPackage && (await safeStat(stored.packageRoot)))
      throw new Error("The new plugin destination appeared after preview. Review a new plan.");
    if (stored.backedUp) return;
    const active = await readRegisteredSource(options.userDataPath, stored.sourceId, "personal");
    if (!active || active.root !== stored.root) throw new Error("The approved marketplace target is no longer safe.");
    for (const action of stored.actions) {
      if (action.kind !== "write-file" && action.kind !== "delete-file") continue;
      const current = await readRegularFile(stored.root, action.relativePath);
      if (action.beforeHash && (!current || hashContent(current) !== action.beforeHash))
        throw new Error(`The approved skill file changed: ${action.relativePath}`);
      if (!action.beforeHash && current)
        throw new Error(`The approved skill destination already exists: ${action.relativePath}`);
    }
    const backupRoot = join(options.userDataPath, "omni/backups", stored.operationId);
    await backupFiles(stored.root, backupRoot, filesForBackup(stored.actions));
    for (const path of filesForBackup(stored.actions)) {
      const saved = await readRegularFile(backupRoot, path);
      const expected = stored.actions.find((action) => action.relativePath === path)?.beforeHash;
      if (!saved || !expected || hashContent(saved) !== expected)
        throw new Error(`Recovery file could not be verified: ${path}`);
    }
    plans.set(planId, { ...stored, backedUp: true });
  };

  const preview = async (raw: unknown, manifestCreatedAt?: number): Promise<PreviewMarketplaceResponse> => {
    let request = parsePreviewOperationRequest(raw);
    if (request.kind !== "write-skill") throw new Error("Operation kind is invalid.");
    let marketplace: Awaited<ReturnType<typeof readRegisteredSource>>;
    try {
      marketplace = await readRegisteredSource(options.userDataPath, request.sourceId, "personal");
    } catch (error) {
      if (error instanceof StorefrontTargetError) return block(error.code, error.message);
      throw error;
    }
    if (!marketplace) return block("source-missing", "The selected marketplace is unavailable.");
    let layout: Awaited<ReturnType<typeof observedLayout>>;
    try {
      layout = await observedLayout(marketplace.root);
    } catch {
      return block("source-missing", "The selected marketplace could not be observed safely.");
    }
    const resolution = request.newPackage
      ? undefined
      : resolveObservedPackage(layout.packages ?? [], request.packageId!);
    if (resolution?.status === "blocked") return block(resolution.code, resolution.message);
    const packageInfo = resolution?.status === "resolved" ? resolution.package : undefined;
    if (packageInfo) request = { ...request, packageId: packageInfo.id };
    if (packageInfo && request.mode === "update") {
      const skillRoot = `${packageInfo.relativeRoot}/skills/${request.folderName}`;
      const existing = await safeStat(join(marketplace.root, skillRoot));
      if (!existing || !existing.isDirectory() || existing.isSymbolicLink())
        return block(
          "source-skill-unavailable",
          `Skill "${request.folderName}" in source "${request.sourceId}", package "${packageInfo.id}" is missing or unsafe. Refresh the source and choose an observed skill folder.`,
        );
    }
    let projectedFiles: Awaited<ReturnType<typeof buildSkillCheckProjection>>;
    try {
      projectedFiles = await buildSkillCheckProjection({
        root: marketplace.root,
        skillRoot: `${packageInfo?.relativeRoot ?? `packages/${request.newPackage!.name}`}/skills/${request.folderName}`,
        mode: request.mode,
        ...(request.replaceFolder === undefined ? {} : { replaceFolder: request.replaceFolder }),
        files: request.files,
      });
    } catch (error: unknown) {
      return block(
        "skill-tree-unavailable",
        error instanceof Error ? error.message : "The current skill tree could not be observed safely.",
      );
    }
    const findings = checkSkill({
      folderName: request.folderName,
      files: projectedFiles,
      marketplace: { skillNames: skillNames(layout.artifacts, request.folderName, request.mode === "update") },
    });
    const available = await options.git.isGitAvailable();
    const git = !available
      ? gitMode("unavailable")
      : (await options.git.isRepositoryRoot(marketplace.root))
        ? gitMode("commit")
        : gitMode("enclosing-repository");
    if (hasErrors(findings)) {
      const plan = planForFindings(request, git, findings);
      return block("skill-checks-failed", "Fix the skill errors before confirming.", plan);
    }
    const built = await buildWriteSkillPlan({
      root: marketplace.root,
      packageId: request.packageId,
      request,
      packages: layout.packages ?? [],
      artifacts: layout.artifacts,
      findings,
      // A born manifest is part of the approved bytes; refresh must retain the intent's date.
      now: manifestCreatedAt ?? now(),
      git,
    });
    if ("blocked" in built) return block("skill-target-invalid", built.blocked);
    plans.set(built.plan.planId, {
      plan: built.plan,
      operationId: randomUUID(),
      sourceId: request.sourceId,
      root: marketplace.root,
      actions: built.actions,
      manifests: built.manifests,
      packageRoot: built.packageRoot,
      skillRoot: built.skillRoot,
      commitMessage: built.commitMessage,
      request,
    });
    return { status: "ready", plan: built.plan };
  };

  const apply = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    const request = parseApplyOperationRequest(raw);
    let stored = plans.get(request.planId);
    if (!stored) return undefined;
    const backupRoot = join(options.userDataPath, "omni/backups", stored.operationId);
    const backupPaths = filesForBackup(stored.actions);
    const completed: SkillPlannedAction[] = [];
    const createdFiles: SkillPlannedAction[] = [];
    const createdDirectories: SkillPlannedAction[] = [];
    try {
      if (stored.request.newPackage && (await safeStat(stored.packageRoot)))
        throw new Error("The new plugin destination appeared after preview. Review a new plan.");
      const active = await readRegisteredSource(options.userDataPath, stored.sourceId, "personal");
      if (!active || active.root !== stored.root) throw new Error("The approved marketplace target is no longer safe.");
      if (!stored.backedUp) {
        await prepare(request.planId);
        stored = plans.get(request.planId)!;
      }
      plans.delete(request.planId);
      for (const action of stored.actions) {
        if (action.kind === "create-directory") {
          await ensureDirectories(stored.root, action.relativePath);
          createdDirectories.push(action);
          completed.push(action);
          continue;
        }
        const current = await readRegularFile(stored.root, action.relativePath);
        if (action.beforeHash && (!current || hashContent(current) !== action.beforeHash))
          throw new Error("The approved skill file changed.");
        if (!action.beforeHash && current) throw new Error("The approved skill destination already exists.");
        if (action.kind === "delete-file") {
          await removeFileOrEmptyDirectories(stored.root, action.relativePath, stored.skillRoot);
        } else {
          await writeAtomically(
            stored.root,
            action.relativePath,
            action.content ?? "",
            write
              ? (path, content, options) => write(path, content, { encoding: "utf8", mode: options.mode ?? 0o600 })
              : undefined,
          );
          const written = await readRegularFile(stored.root, action.relativePath);
          if (!written || hashContent(written) !== hashContent(action.content ?? ""))
            throw new Error("The written skill file could not be verified.");
          if (!action.beforeHash) createdFiles.push(action);
        }
        completed.push(action);
      }
      const paths = stored.actions
        .filter((action) => action.kind === "write-file" || action.kind === "delete-file")
        .map((action) => action.relativePath);
      let commit: string | undefined;
      let headBefore: string | undefined;
      let headAfter: string | undefined;
      if (stored.plan.git.mode === "commit" && paths.length) {
        headBefore = await options.git.headCommit(stored.root);
        const result = await options.git.commitAll(stored.root, stored.commitMessage, paths);
        if (result.status !== "committed") throw new Error(result.diagnostic);
        commit = result.commit;
        headAfter = await options.git.headCommit(stored.root);
      }
      const receipt: OperationReceipt = {
        operationId: stored.operationId,
        kind: "write-skill",
        status: "applied",
        appliedAt: new Date(now()).toISOString(),
        displayTarget: stored.plan.displayTarget,
        packageId: stored.request.packageId ?? `packages/${stored.request.newPackage!.name}`,
        actions: stored.actions.map((action) => ({ ...view(action), status: "applied" as const })),
        git: {
          mode: stored.plan.git.mode,
          ...(commit ? { commit } : {}),
          ...(headBefore ? { headBefore } : {}),
          ...(headAfter ? { headAfter } : {}),
        },
        registered: { sourceId: stored.sourceId },
        files: receiptFiles(stored.actions),
        manifests: stored.manifests,
        skillMode: stored.request.mode,
        ...(request.provenance?.agent || request.provenance?.approval || stored.request.agent || stored.request.reason
          ? {
              provenance: {
                ...((request.provenance?.agent ?? stored.request.agent)
                  ? { agent: request.provenance?.agent ?? stored.request.agent }
                  : {}),
                ...(request.provenance?.approval ? { approval: request.provenance.approval } : {}),
                ...(stored.request.reason ? { reason: stored.request.reason } : {}),
              },
            }
          : {}),
      };
      const delivered = await persistWorkshopReceipt(receipt, stored.root, options);
      return { status: "applied", receipt: delivered };
    } catch (error: unknown) {
      for (const path of backupPaths) await restoreBackup(stored.root, backupRoot, path).catch(() => false);
      for (const action of createdFiles)
        await removeFileOrEmptyDirectories(stored.root, action.relativePath, stored.skillRoot).catch(() => undefined);
      for (const action of [...createdDirectories].reverse())
        await removeDirectoryIfEmpty(stored.root, action.relativePath).catch(() => undefined);
      const done = completed.map((action) => ({ ...view(action), status: "rolled-back" as const }));
      const active = stored.actions.find((action) => !completed.includes(action));
      const actions = active ? [...done, { ...view(active), status: "failed" as const }] : done;
      const diagnostic = error instanceof Error ? error.message : "The skill operation failed.";
      const receipt = failedReceipt(stored, now(), actions, diagnostic, request);
      await options.operationStore.append(receipt).catch(() => undefined);
      return { status: "failed", receipt };
    }
  };

  const recoveryReference = (planId: string): Readonly<{ sourceId: string; path: string }> | undefined => {
    const stored = plans.get(planId);
    return stored ? { sourceId: stored.sourceId, path: `backups/${stored.operationId}` } : undefined;
  };
  return { preview, prepare, recoveryReference, apply };
}
import { persistWorkshopReceipt } from "./workshop-delivery/receipt";
