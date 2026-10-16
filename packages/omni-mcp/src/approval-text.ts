import type { ApprovalReason } from "../../../src/shared/agents-ipc.js";
import { describeApprovalReason } from "../../../src/shared/approval-reason-text.js";

const WAIT_INSTRUCTIONS =
  "Tell the user in one line, then call omni_apply; it returns pending while the request waits. Call it again with the same requestId; the request does not expire. If the user approves in Omni later, omni_receipt shows the result.";

export const OMNI_APPROVAL_INSTRUCTIONS = `Approval happens in Omni Desktop: <reason>. ${WAIT_INSTRUCTIONS}`;

export function summarizeOmniApproval(reason?: ApprovalReason): string {
  return `Approval happens in Omni Desktop: ${describeApprovalReason(reason)}. ${WAIT_INSTRUCTIONS}`;
}
