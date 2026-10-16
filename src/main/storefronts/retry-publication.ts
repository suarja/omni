import { pushWithEvidence } from "./push-evidence";
import { randomUUID } from "node:crypto";
import type { OperationApplyProvenance, OperationReceipt, ApplyOperationResponse } from "../../shared/operations-ipc";
import { stores, type PublicationOptions } from "./publish-context";
import { readUnpushedLineage, type PublicationLineage } from "./publish-lineage";
import { errorText, persistReceipt } from "./publish-write";
import type { RecoveryStored } from "./publish-recovery";
function retryReceipt(
  options: PublicationOptions,
  stored: RecoveryStored,
  operationId: string,
  state: "pushed" | "committed-not-pushed",
  diagnostic?: string,
  provenance?: OperationApplyProvenance,
): OperationReceipt {
  return {
    operationId,
    kind: "retry-push",
    status: state === "pushed" && !diagnostic ? "applied" : "failed",
    appliedAt: new Date((options.now ?? Date.now)()).toISOString(),
    displayTarget: stored.plan.displayTarget,
    actions: [],
    git: { mode: "commit", commit: stored.state.head, headBefore: stored.state.head },
    registered: { sourceId: stored.original.publication!.storefrontId },
    publication: {
      ...stored.original.publication!,
      state,
      remoteUrl: stored.state.remoteUrl,
      retryOf: stored.original.operationId,
    },
    ...(diagnostic ? { diagnostic } : {}),
    ...(provenance ? { provenance } : {}),
  };
}
async function markPushedMembers(
  options: PublicationOptions,
  lineage: PublicationLineage,
  remoteUrl: string,
): Promise<boolean> {
  let failed = false;
  for (const receipt of lineage.members) {
    try {
      await persistReceipt(options, {
        ...receipt,
        status: "applied",
        diagnostic: undefined,
        publication: { ...receipt.publication!, state: "pushed", remoteUrl },
      });
    } catch {
      failed = true;
    }
  }
  return failed;
}
export async function retryPublication(
  options: PublicationOptions,
  stored: RecoveryStored,
  provenance?: OperationApplyProvenance,
): Promise<ApplyOperationResponse> {
  const operationId = randomUUID();
  let lineage: PublicationLineage;
  try {
    lineage = await readUnpushedLineage(options, stored.original);
    const publication = lineage.root.publication?.publication;
    if (publication) {
      const saved = await stores(options).publications.save([publication]);
      if (saved.status !== "ready")
        throw new Error("Publication metadata is unavailable. Recover its store before pushing.");
    }
  } catch (error) {
    return persistReceipt(
      options,
      retryReceipt(options, stored, operationId, "committed-not-pushed", errorText(error), provenance),
    );
  }
  const durable = await pushWithEvidence(
    options,
    retryReceipt(options, stored, operationId, "committed-not-pushed", undefined, provenance),
    stored.root,
  );
  if (durable.receipt.publication?.state !== "pushed") return durable;
  const pushedReceipt = durable.receipt;
  if (!(await markPushedMembers(options, lineage, stored.state.remoteUrl))) return durable;
  return persistReceipt(options, {
    ...pushedReceipt,
    status: "failed",
    diagnostic:
      "Publication pushed, but some earlier receipts could not be updated. Durable pushed evidence keeps recovery closed.",
  });
}
