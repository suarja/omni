import type { HarnessId } from "../../../../domain/harness-targets";
import type { TranslationKey } from "../../../i18n";
import type { PropagationOutcome, PropagationTone } from "./view-model";
import type { IconName } from "../../../components/Icon";
export function harnessName(harness: HarnessId): string {
  return harness === "claude-code" ? "Claude Code" : harness === "codex" ? "Codex" : "Cursor";
}
export const outcomeKeys: Record<PropagationOutcome, TranslationKey> = {
  applied: "skillManagement.propagationResultApplied",
  restored: "skillManagement.propagationResultRestored",
  "retained-local": "skillManagement.propagationResultRetained",
  unavailable: "skillManagement.propagationStateUnavailable",
  failed: "skillManagement.propagationResultFailed",
  unknown: "skillManagement.propagationResultUnknown",
  pending: "skillManagement.propagationResultPending",
  "no-op": "skillManagement.propagationResultNoOp",
  unselected: "skillManagement.propagationUnselected",
};
export const toneIcons: Record<PropagationTone, IconName> = {
  success: "review",
  review: "review",
  unknown: "question",
  conflict: "warning",
  neutral: "info",
};
