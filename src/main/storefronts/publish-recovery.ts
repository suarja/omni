import { readUnpushedLineage } from "./publish-lineage";
export { PublicationRecoveryError } from "./publish-lineage";
import { retryPublication } from "./retry-publication";
import { readCommittedFile } from "../git-read";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  OperationPlan,
  OperationReceipt,
  ApplyOperationResponse,
  OperationApplyProvenance,
} from "../../shared/operations-ipc";
import { readRegularFile, backupFiles } from "../operation-files";
import { hashContent } from "../marketplace-manifests";
import { context, repositoryState, rootIdentity, stores, type PublicationOptions } from "./publish-context";
import { applyEdits, assertEditFresh, errorText, persistReceipt } from "./publish-write";
import type { PublicationEdit } from "./publish-plan";
export type RecoveryStored = Readonly<{
  plan: OperationPlan;
  original: OperationReceipt;
  rootReceipt: OperationReceipt;
  root: string;
  identity: string;
  state: Awaited<ReturnType<typeof repositoryState>>;
  edits: readonly PublicationEdit[];
}>;
export async function publicationReceipt(
  options: PublicationOptions,
  operationId: string,
): Promise<OperationReceipt | undefined> {
  const loaded = await options.operationStore.read();
  if (loaded.status !== "ready") throw new Error(loaded.diagnostic);
  return loaded.receipts.find((receipt) => receipt.operationId === operationId && receipt.publication);
}
export async function buildRecoveryPlan(
  options: PublicationOptions,
  original: OperationReceipt,
  kind: "retry-push" | "restore-import",
): Promise<RecoveryStored> {
  const lineage = await readUnpushedLineage(options, original, kind);
  const rootReceipt = lineage.root;
  const data = original.publication!;
  const ctx = await context(options, data.storefrontId);
  const root = ctx.root!;
  const state = await repositoryState(root, options.git);
  if (state.head !== original.git.commit || state.branch !== data.branch)
    throw new Error("The storefront commit or branch changed. Preserve the current work before recovery.");
  const edits: PublicationEdit[] = [];
  for (const action of rootReceipt.actions) {
    const current = await readRegularFile(root, action.relativePath);
    if ((current && hashContent(current)) !== action.afterHash)
      throw new Error(`Publication file changed: ${action.relativePath}. Preserve it before recovery.`);
    const committed = await readCommittedFile(root, original.git.commit, action.relativePath);
    if ((committed && hashContent(committed)) !== action.afterHash)
      throw new Error("The recorded commit differs from the reviewed publication files. Inspect it before recovery.");
    if (kind === "retry-push") continue;
    const before = action.beforeHash
      ? await readRegularFile(join(options.userDataPath, "omni/backups", rootReceipt.operationId), action.relativePath)
      : undefined;
    if (action.beforeHash && (!before || hashContent(before) !== action.beforeHash))
      throw new Error(`Publication backup is missing or changed: ${action.relativePath}. Recover it before restoring.`);
    edits.push({
      before: current,
      after: before,
      view: {
        kind: before === undefined ? "delete-file" : "write-file",
        relativePath: action.relativePath,
        ...(current ? { beforeHash: hashContent(current) } : {}),
        ...(before ? { afterHash: hashContent(before), byteLength: before.byteLength } : {}),
      },
    });
  }
  const identity = await rootIdentity(root);
  const approvalFingerprint = hashContent(
    JSON.stringify({ identity, state, rootReceipt, requestedReceiptId: original.operationId }),
  );
  return {
    plan: {
      planId: randomUUID(),
      kind,
      displayTarget: original.displayTarget,
      actions: edits.map((edit) => edit.view),
      git: { mode: "commit", warnings: [] },
      publication: { approvalFingerprint, files: [], conflicts: [], findings: [] },
      notes: [
        kind === "retry-push"
          ? `Push the recorded local commit on ${state.branch} to origin.`
          : "Restore the local publication files with a new commit. No push.",
      ],
    },
    original,
    rootReceipt,
    root,
    identity,
    state,
    edits,
  };
}
async function assertRecoveryFresh(options: PublicationOptions, stored: RecoveryStored): Promise<void> {
  const latest = await publicationReceipt(options, stored.original.operationId);
  if (
    !latest ||
    latest.restored ||
    !(["committed-not-pushed", "push-outcome-unknown"] as const).some((state) => state === latest.publication?.state)
  )
    throw new Error("The publication recovery state changed. Preview again.");
  const fresh = await buildRecoveryPlan(
    options,
    latest,
    stored.plan.kind === "retry-push" ? "retry-push" : "restore-import",
  );
  if (
    fresh.root !== stored.root ||
    fresh.identity !== stored.identity ||
    JSON.stringify(fresh.state) !== JSON.stringify(stored.state)
  )
    throw new Error("The publication recovery target changed. Preview again.");
  for (const edit of stored.edits) await assertEditFresh(stored.root, edit);
}
export async function applyRecovery(
  options: PublicationOptions,
  stored: RecoveryStored,
  provenance?: OperationApplyProvenance,
): Promise<ApplyOperationResponse> {
  const operationId = randomUUID();
  const appliedAt = new Date((options.now ?? Date.now)()).toISOString();
  const completed: string[] = [];
  let commit: string | undefined;
  let diagnostic: string | undefined;
  let succeeded = false;
  const retry = stored.plan.kind === "retry-push";
  const data = stored.rootReceipt.publication!;
  try {
    await assertRecoveryFresh(options, stored);
    if (retry) return retryPublication(options, stored, provenance);
    {
      await backupFiles(
        stored.root,
        join(options.userDataPath, "omni/backups", operationId),
        stored.edits.filter((edit) => edit.before !== undefined).map((edit) => edit.view.relativePath),
      );
      await applyEdits(options, stored.root, stored.edits, completed);
      const result = await options.git.commitAll(
        stored.root,
        `Restore unpushed publication ${data.pluginId ?? stored.original.displayTarget}`,
        stored.edits.map((edit) => edit.view.relativePath),
      );
      if (result.status !== "committed") throw new Error(result.diagnostic);
      commit = result.commit;
      if (data.pluginId) {
        const saved = data.previousPublication
          ? await stores(options).publications.save([data.previousPublication])
          : await stores(options).publications.remove(data.storefrontId, data.pluginId);
        if (saved.status !== "ready")
          throw new Error(
            "The local restore committed, but publication metadata could not be restored. Inspect History and recover the store.",
          );
      }
      const marked = await options.operationStore.markRestored(stored.rootReceipt.operationId);
      if (marked.status !== "ready")
        throw new Error("The publication restore could not be recorded. Inspect History before retrying.");
      succeeded = true;
    }
  } catch (error) {
    diagnostic = errorText(error);
  }
  return persistReceipt(options, {
    operationId,
    kind: stored.plan.kind,
    status: succeeded && !diagnostic ? "applied" : "failed",
    appliedAt,
    displayTarget: stored.plan.displayTarget,
    actions: stored.plan.actions.map((action) => ({
      ...action,
      status: completed.includes(action.relativePath) ? "applied" : "failed",
    })),
    git: {
      mode: "commit",
      headBefore: stored.state.head,
      ...(commit ? { commit } : {}),
    },
    registered: { sourceId: data.storefrontId },
    restores: stored.rootReceipt.operationId,
    ...(diagnostic ? { diagnostic } : {}),
    ...(provenance ? { provenance } : {}),
  });
}
