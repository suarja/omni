import type { OperationReceipt } from "../../shared/operations-ipc";
import type { PublicationOptions } from "./publish-context";

export class PublicationRecoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export type PublicationLineage = Readonly<{ root: OperationReceipt; members: readonly OperationReceipt[] }>;
function sameCommittedPublication(left: OperationReceipt, right: OperationReceipt): boolean {
  return Boolean(
    left.git.commit &&
    left.git.commit === right.git.commit &&
    left.publication &&
    right.publication &&
    left.publication.storefrontId === right.publication.storefrontId &&
    left.publication.branch === right.publication.branch &&
    left.publication.pluginId === right.publication.pluginId,
  );
}
export async function readUnpushedLineage(
  options: PublicationOptions,
  requested: OperationReceipt,
  kind: "retry-push" | "restore-import" = "retry-push",
): Promise<PublicationLineage> {
  const loaded = await options.operationStore.read();
  if (loaded.status !== "ready") throw new Error(loaded.diagnostic);
  const members = loaded.receipts.filter((receipt) => sameCommittedPublication(requested, receipt));
  if (members.some((receipt) => receipt.publication?.state === "pushed"))
    throw new PublicationRecoveryError(
      "publication-pushed",
      "This committed publication was pushed. Recovery is closed for every receipt in its lineage.",
    );
  if (kind === "restore-import" && members.some((receipt) => receipt.publication?.state === "push-outcome-unknown"))
    throw new PublicationRecoveryError(
      "publication-push-uncertain",
      "A push outcome is unknown. Local restore is closed for every receipt in its lineage; preview a retry of the recorded commit and destination.",
    );
  if (
    !requested.git.commit ||
    !(["committed-not-pushed", "push-outcome-unknown"] as const).some(
      (state) => state === requested.publication?.state,
    ) ||
    members.some((receipt) => receipt.restored)
  )
    throw new PublicationRecoveryError(
      "publication-recovery-unavailable",
      "Only a committed, unpushed publication can be retried or restored.",
    );
  let root = members.find((receipt) => receipt.operationId === requested.operationId);
  const seen = new Set<string>();
  while (root?.publication?.retryOf) {
    if (seen.has(root.operationId))
      throw new Error("Publication retry lineage contains a cycle. Inspect History before recovery.");
    seen.add(root.operationId);
    root = members.find((receipt) => receipt.operationId === root!.publication!.retryOf);
  }
  if (!root || root.kind === "retry-push")
    throw new Error("Publication retry lineage is incomplete. Recover its original receipt before retrying.");
  return { root, members };
}
