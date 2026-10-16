import { publicRepositoryUrl } from "../git-push";
import { pushWithEvidence } from "./push-evidence";
import { receiptPublicationActions } from "./publish-preview";
import { readBaseFiles, readCommittedFile } from "../git-read";
import { join } from "node:path";
import { backupFiles, readRegularFile, removeFileOrEmptyDirectories, writeAtomically } from "../operation-files";
import { hashContent } from "../marketplace-manifests";
import type { OperationApplyProvenance, OperationReceipt, ApplyOperationResponse } from "../../shared/operations-ipc";
import type { Publication } from "../../domain/publications";
import { hashes, stores, readTree, sameHashes, repositoryState, type PublicationOptions } from "./publish-context";
import type { PublishStored, PublicationEdit } from "./publish-plan";
export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : "The publication failed safely.")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replaceAll("/", " > ")
    .replaceAll("\\", " > ")
    .replaceAll("..", ".")
    .slice(0, 1000);
}
export async function persistReceipt(
  options: PublicationOptions,
  receipt: OperationReceipt,
): Promise<ApplyOperationResponse> {
  const safeReceipt = receipt.publication
    ? {
        ...receipt,
        publication: { ...receipt.publication, remoteUrl: publicRepositoryUrl(receipt.publication.remoteUrl) },
      }
    : receipt;
  const persisted = await options.operationStore.append(safeReceipt);
  if (persisted.status !== "ready")
    throw new Error(
      "The publication receipt could not be saved. Preserve its backup and inspect History before retrying.",
    );
  return { status: safeReceipt.status, receipt: safeReceipt };
}
export async function assertEditFresh(root: string, edit: PublicationEdit): Promise<void> {
  const current = await readRegularFile(root, edit.view.relativePath);
  if ((current && hashContent(current)) !== edit.view.beforeHash)
    throw new Error(`Publication file changed: ${edit.view.relativePath}. Preview again.`);
}
export async function applyEdits(
  options: PublicationOptions,
  root: string,
  edits: readonly PublicationEdit[],
  completed: string[],
): Promise<void> {
  for (const edit of edits) {
    await assertEditFresh(root, edit);
    if (edit.after === undefined) await removeFileOrEmptyDirectories(root, edit.view.relativePath, ".");
    else
      await writeAtomically(root, edit.view.relativePath, edit.after, options.fileWriter, () =>
        completed.push(edit.view.relativePath),
      );
    if (!completed.includes(edit.view.relativePath)) completed.push(edit.view.relativePath);
    const current = await readRegularFile(root, edit.view.relativePath);
    if ((current && hashContent(current)) !== edit.view.afterHash)
      throw new Error(`Publication file could not be verified: ${edit.view.relativePath}. Inspect its backup.`);
  }
}
async function rollback(
  options: PublicationOptions,
  stored: PublishStored,
  completed: readonly string[],
): Promise<Set<string>> {
  const restored = new Set<string>();
  for (const edit of [...stored.edits].reverse().filter((item) => completed.includes(item.view.relativePath))) {
    try {
      const current = await readRegularFile(stored.root, edit.view.relativePath);
      if ((current && hashContent(current)) !== edit.view.afterHash) continue;
      if (edit.before === undefined) await removeFileOrEmptyDirectories(stored.root, edit.view.relativePath, ".");
      else await writeAtomically(stored.root, edit.view.relativePath, edit.before, options.fileWriter);
      restored.add(edit.view.relativePath);
    } catch {
      /* Report unrolled actions in the receipt; never overwrite concurrent edits. */
    }
  }
  return restored;
}
async function assertPublishedFiles(
  options: PublicationOptions,
  stored: PublishStored,
  commit?: string,
): Promise<void> {
  const plugin = commit
    ? await readBaseFiles(stored.root, commit, `plugins/${stored.request.pluginId}`)
    : await readTree(stored.root, `plugins/${stored.request.pluginId}`);
  if (!plugin || !sameHashes(hashes(plugin), hashes(stored.merged)))
    throw new Error(
      "The publication files do not match the reviewed merge. Preserve the local commit and preview again.",
    );
  for (const edit of stored.edits) {
    const bytes = commit
      ? await readCommittedFile(stored.root, commit, edit.view.relativePath)
      : await readRegularFile(stored.root, edit.view.relativePath);
    if ((bytes && hashContent(bytes)) !== edit.view.afterHash)
      throw new Error("The publication commit differs from the reviewed files. Inspect it before retrying.");
  }
  const state = await repositoryState(stored.root, options.git);
  if (state.head !== (commit ?? stored.head) || state.branch !== stored.branch || state.remoteUrl !== stored.remoteUrl)
    throw new Error("The publication Git target changed. Preview again before pushing.");
}
type PublicationWriteProgress = Readonly<{
  appliedAt: string;
  completed: readonly string[];
  commit: string | undefined;
  diagnostic: string | undefined;
  rolledBack: ReadonlySet<string>;
  publication: Publication | undefined;
  pushed: boolean;
}>;
function buildPublicationReceipt(
  stored: PublishStored,
  { appliedAt, completed, commit, diagnostic, rolledBack, publication, pushed }: PublicationWriteProgress,
  provenance?: OperationApplyProvenance,
): OperationReceipt {
  return {
    operationId: stored.operationId,
    kind: "publish-plugin",
    status: pushed ? "applied" : "failed",
    appliedAt,
    displayTarget: stored.plan.displayTarget,
    actions: receiptPublicationActions(stored.edits, stored.plan.actions).map((action) => ({
      ...action,
      status: rolledBack.has(action.relativePath)
        ? "rolled-back"
        : completed.includes(action.relativePath)
          ? "applied"
          : "failed",
    })),
    git: { mode: "commit", headBefore: stored.head, ...(commit ? { commit } : {}) },
    registered: { sourceId: stored.storefrontId },
    ...(stored.children ? { children: stored.children } : {}),
    publication: {
      state: pushed ? "pushed" : commit ? "committed-not-pushed" : "failed",
      storefrontId: stored.storefrontId,
      pluginId: stored.request.pluginId,
      branch: stored.branch,
      remoteUrl: stored.remoteUrl,
      ...(publication ? { publication } : {}),
      ...(stored.previous ? { previousPublication: stored.previous } : {}),
    },
    ...(provenance ? { provenance } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}
export async function writePublication(
  options: PublicationOptions,
  stored: PublishStored,
  provenance?: OperationApplyProvenance,
): Promise<ApplyOperationResponse> {
  const appliedAt = new Date((options.now ?? Date.now)()).toISOString();
  const completed: string[] = [];
  let commit: string | undefined;
  let diagnostic: string | undefined;
  let rolledBack = new Set<string>();
  let publication: Publication | undefined;
  const pushed = false;
  const receipt = (): OperationReceipt =>
    buildPublicationReceipt(
      stored,
      { appliedAt, completed, commit, diagnostic, rolledBack, publication, pushed },
      provenance,
    );
  try {
    for (const edit of stored.edits) await assertEditFresh(stored.root, edit);
    await backupFiles(
      stored.root,
      join(options.userDataPath, "omni/backups", stored.operationId),
      stored.edits.filter((edit) => edit.before !== undefined).map((edit) => edit.view.relativePath),
    );
    await applyEdits(options, stored.root, stored.edits, completed);
    await assertPublishedFiles(options, stored);
    const committed = await options.git.commitAll(
      stored.root,
      `Publish ${stored.request.pluginId} from ${stored.workshopName}@${stored.workshopCommit.slice(0, 7)}`,
      stored.edits.map((edit) => edit.view.relativePath),
    );
    if (committed.status !== "committed") throw new Error(committed.diagnostic);
    commit = committed.commit;
    publication = {
      storefrontSourceId: stored.storefrontId,
      pluginId: stored.request.pluginId,
      workshopPackagePath: stored.packagePath,
      baseCommit: stored.workshopCommit,
      publishedHashes: hashes(stored.merged),
      storefrontCommit: commit,
      publishedTime: appliedAt,
    };
    await assertPublishedFiles(options, stored, commit);
    const saved = await stores(options).publications.save([publication]);
    if (saved.status !== "ready")
      throw new Error("Publication metadata could not be saved. Inspect its committed receipt before retrying push.");
    // Persist the recoverable local commit before any external side effect.
    diagnostic = "Publication committed locally; push has not completed.";
    await persistReceipt(options, receipt());
    await assertPublishedFiles(options, stored, commit);
    return await pushWithEvidence(options, receipt(), stored.root);
  } catch (error) {
    diagnostic = errorText(error);
    if (!commit) {
      rolledBack = await rollback(options, stored, completed);
      if (completed.some((path) => !rolledBack.has(path)))
        diagnostic += " Some files could not be rolled back. Inspect the operation backup.";
    }
  }
  return persistReceipt(options, receipt());
}
