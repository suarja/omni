import type { OperationReceipt, ApplyOperationResponse } from "../../shared/operations-ipc";
import type { PublicationOptions } from "./publish-context";
import { persistReceipt, errorText } from "./publish-write";

export async function savePushOutcome(
  options: PublicationOptions,
  receipt: OperationReceipt,
  conservative: OperationReceipt,
): Promise<ApplyOperationResponse> {
  try {
    return await persistReceipt(options, receipt);
  } catch {
    const failed: OperationReceipt = {
      ...conservative,
      status: "failed",
      diagnostic: [
        receipt.publication?.state === "pushed"
          ? "Push completed, but its receipt could not be saved. Recovery remains closed; inspect History and preview the same commit and destination before retrying."
          : "The push outcome receipt could not be saved. Recovery remains closed; inspect History before recovery.",
        receipt.diagnostic,
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 1000),
    };
    // The pre-push evidence remains durable even if this diagnostic also cannot be saved.
    try {
      await persistReceipt(options, failed);
    } catch {
      /* Preserve conservative evidence. */
    }
    return { status: "failed", receipt: failed };
  }
}
export async function pushWithEvidence(
  options: PublicationOptions,
  receipt: OperationReceipt,
  root: string,
): Promise<ApplyOperationResponse> {
  const conservative: OperationReceipt = {
    ...receipt,
    status: "failed",
    publication: { ...receipt.publication!, state: "push-outcome-unknown" },
    diagnostic:
      "Push is about to begin; its outcome is unknown. Local restore is closed until the outcome is confirmed.",
  };
  const durableEvidence = (await persistReceipt(options, conservative)).receipt;
  let final: OperationReceipt;
  try {
    const result = await options.git.push(root, "origin", receipt.publication!.branch, {
      remoteUrl: receipt.publication!.remoteUrl,
      commit: receipt.git.commit!,
    });
    final = {
      ...receipt,
      status: result.status === "pushed" && !result.diagnostic ? "applied" : "failed",
      publication: {
        ...receipt.publication!,
        state:
          result.status === "pushed"
            ? "pushed"
            : result.status === "failed"
              ? "committed-not-pushed"
              : "push-outcome-unknown",
      },
      diagnostic: result.diagnostic ? errorText(new Error(result.diagnostic)) : undefined,
    };
  } catch (error) {
    final = { ...conservative, diagnostic: errorText(error) };
  }
  return savePushOutcome(options, final, durableEvidence);
}
