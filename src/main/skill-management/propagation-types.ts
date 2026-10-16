import type { SkillOperationJournal } from "../../application/skill-management-journal";
import type { SkillPropagationIntent } from "../../shared/skill-propagation-ipc";
import type { OperationStore } from "../operation-store";
import type { createWriteSkillOperations } from "../operations-write-skill";
import type { SkillPropagationReaderDependencies, SkillPropagationSnapshot } from "./propagation-reader";

export type ReadySkillPropagationSnapshot = Extract<SkillPropagationSnapshot, { status: "ready" }>;

export type SkillPropagationDependencies = SkillPropagationReaderDependencies &
  Readonly<{
    userDataPath: string;
    writeSkill: ReturnType<typeof createWriteSkillOperations>;
    operationStore: OperationStore;
    journal: SkillOperationJournal;
    now?: () => number;
  }>;

export type SkillPropagationApplyPlan = Readonly<{
  intent: SkillPropagationIntent;
  snapshot: ReadySkillPropagationSnapshot;
  sourcePlanId?: string;
}>;
