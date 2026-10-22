import type { OperationReceipt } from "../../shared/operations-ipc";
import { realpath } from "node:fs/promises";
import type { OperationStore } from "../operation-store";
import { readActiveWorkshop } from "../operations-paths";
import { pushWorkshop } from "./sync";

/** Persist the local write before transport. A remote failure cannot roll back committed files. */
export async function persistWorkshopReceipt(
  receipt: OperationReceipt,
  root: string,
  options: Readonly<{ userDataPath: string; operationStore: OperationStore }>,
): Promise<OperationReceipt> {
  const workshop = await readActiveWorkshop(options.userDataPath).catch(() => undefined);
  const canonicalRoot = await realpath(root).catch(() => undefined);
  const eligible =
    receipt.status === "applied" &&
    receipt.git.commit &&
    Boolean(workshop && canonicalRoot && workshop.root === canonicalRoot);
  const recorded: OperationReceipt = eligible
    ? {
        ...receipt,
        registered: { ...receipt.registered, sourceId: workshop!.id },
        workshopPush: {
          status: "unknown",
          commit: receipt.git.commit!,
          ahead: 0,
          behind: 0,
          diagnostic: "Local commit recorded. Workshop push has not been confirmed; inspect delivery and retry.",
        },
      }
    : receipt;
  const saved = await options.operationStore.append(recorded);
  if (saved.status !== "ready")
    throw new Error("The local operation receipt could not be saved. Preserve its backup and refresh History.");
  if (!eligible) return receipt;
  let workshopPush: NonNullable<OperationReceipt["workshopPush"]>;
  try {
    const confirmed = saved.receipts.find(
      (previous) => previous.registered?.sourceId === workshop!.id && previous.workshopPush?.status === "pushed",
    )?.workshopPush;
    workshopPush = await pushWorkshop(root, undefined, confirmed);
  } catch {
    workshopPush = {
      ...recorded.workshopPush!,
      status: "failed",
      diagnostic: "Workshop push could not be attempted. Inspect its Git upstream and retry.",
    };
  }
  const delivered: OperationReceipt = { ...recorded, workshopPush };
  try {
    const persisted = await options.operationStore.append(delivered);
    if (persisted.status !== "ready") throw new Error("Receipt unavailable");
    return delivered;
  } catch {
    return {
      ...delivered,
      diagnostic:
        "The local commit is preserved, but its push result could not be saved. Inspect workshop delivery and History before retrying.",
    };
  }
}
