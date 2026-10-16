import type { SkillRevision } from "./types";
import type { SkillPropagationPlanState } from "../../shared/skill-propagation-ipc";

export type SkillPropagationEligibility = Readonly<{
  source?: SkillRevision;
  local?: SkillRevision;
  base?: SkillRevision;
  managed: boolean;
  safe: boolean;
}>;

function sameTree(left: SkillRevision, right: SkillRevision): boolean {
  return left.algorithm === right.algorithm && left.hash === right.hash;
}

export function planSkillPropagationTarget(evidence: SkillPropagationEligibility): SkillPropagationPlanState {
  if (!evidence.safe || !evidence.managed || !evidence.source || !evidence.local || !evidence.base) return "withheld";
  const sourceEqualsLocal = sameTree(evidence.source, evidence.local);
  const sourceEqualsBase = sameTree(evidence.source, evidence.base);
  const localEqualsBase = sameTree(evidence.local, evidence.base);
  if (sourceEqualsLocal && sourceEqualsBase) return "current";
  if (sourceEqualsLocal) return "already-current";
  if (localEqualsBase) return "eligible";
  return "retained-local";
}
