import type { SkillActor, SkillEffectStep, SkillIntent, SkillResult, SkillScope } from "../shared/skill-management-ipc";
import type { SkillPropagationSummary } from "../shared/skill-propagation-ipc";

export type SkillJournalStatus = "previewed" | "prepared" | "applying" | "verifying" | "terminal" | "recovery-required";
export type SkillJournalAction = Readonly<{
  relativePath: string;
  kind: "create-directory" | "write-file" | "write-manifest" | "delete-file" | "restore-manifest" | "remove-directory";
  status: "applying" | "applied" | "failed";
  beforeHash?: string;
  afterHash?: string;
  identity?: string;
  temporaryPath?: string;
}>;
export type SkillJournalStep = Readonly<{
  stepId: string;
  status: "prepared" | "applying" | "verifying" | "applied" | "failed" | "skipped" | "recovery-required";
  receiptId?: string;
  actions?: readonly SkillJournalAction[];
  managementProgress?: Readonly<{ bindings: "pending" | "applied"; uses: "pending" | "applied" }>;
}>;
export type SkillJournalBackupReference = Readonly<{ rootId: string; path: string }>;
export type SkillOperationJournalRecord = Readonly<{
  version: 1;
  intentId: string;
  actor: SkillActor;
  intent: SkillIntent;
  status: SkillJournalStatus;
  effectFingerprint: string;
  effect?: Readonly<{
    planId: string;
    scope: SkillScope;
    steps: readonly SkillEffectStep[];
    propagation?: SkillPropagationSummary;
  }>;
  backupReferences: readonly SkillJournalBackupReference[];
  steps: readonly SkillJournalStep[];
  result?: SkillResult;
  createdAt: string;
  updatedAt: string;
}>;

export type SkillJournalRead =
  | Readonly<{ status: "ready"; record: SkillOperationJournalRecord }>
  | Readonly<{ status: "corrupt"; diagnostic: string }>
  | Readonly<{ status: "missing" }>;
export type SkillJournalList =
  | Readonly<{ status: "ready"; records: readonly SkillOperationJournalRecord[] }>
  | Readonly<{ status: "corrupt"; intentId: string; diagnostic: string }>;

export interface SkillOperationJournal {
  read(intentId: string): Promise<SkillJournalRead>;
  list(): Promise<SkillJournalList>;
  write(record: SkillOperationJournalRecord): Promise<void>;
  recoverInterrupted(): Promise<readonly SkillOperationJournalRecord[]>;
}
