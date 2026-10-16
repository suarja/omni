// Explain's hook on a Review finding (Brief 35a): the finding's own message is one side, its
// examples (when it has any) are the other — the same two things already shown in the row. With
// the `none` provider (or no API at all) this always resolves to nothing, and the finding
// renders exactly as it does today.

import type { AuditFinding } from "../audit/audit-report";
import type { DesktopApi } from "../../shared/ipc";

export type ExplainFindingApi = Pick<DesktopApi, "runInferenceCommand">;

const NO_SECOND_SIDE = "(no second side given)";

/**
 * Resolves to a short explanation sentence, or `undefined` when there is no provider, the call
 * is refused or fails, or the model's output does not validate — never a fabricated sentence.
 */
export async function explainFinding(
  finding: AuditFinding,
  api: ExplainFindingApi | null | undefined,
): Promise<string | undefined> {
  if (!api?.runInferenceCommand) return undefined;
  const left = finding.message;
  const right = finding.examples?.length ? finding.examples.join("\n") : NO_SECOND_SIDE;
  try {
    const response = await api.runInferenceCommand({ command: "explain", findingKind: finding.kind, left, right });
    return response.command === "explain" ? response.explanation : undefined;
  } catch {
    return undefined;
  }
}
