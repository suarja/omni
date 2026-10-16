import type {
  SkillRelationshipsState,
  SkillRevision,
  SkillUseEffect,
  SkillRecordEffect,
} from "../domain/skill-reconciliation/types";
import type { TextDigest } from "../domain/skill-reconciliation/revisions";
import type { EntryRef } from "../domain/project-source-registry";

export type SkillObservationGrant = Readonly<{
  root: string;
  subject: EntryRef;
  device: string;
  inode: string;
  expiresAt: number;
}>;

export type SkillFilesystemNode = Readonly<{
  kind: "file" | "directory" | "symlink" | "other";
  byteLength: number;
  identity: string;
}>;

export type SkillObservationErrorReason = "missing" | "denied" | "unsafe-tree" | "limit" | "changed-during-read" | "io";

export class SkillObservationError extends Error {
  public constructor(public readonly reason: SkillObservationErrorReason) {
    super("Skill tree observation failed safely.");
    this.name = "SkillObservationError";
  }
}

export interface SkillObservationFilesystem {
  lstat(grant: SkillObservationGrant, relativePath: string): Promise<SkillFilesystemNode>;
  listDirectory(grant: SkillObservationGrant, relativePath: string): Promise<readonly string[]>;
  readFile(
    grant: SkillObservationGrant,
    relativePath: string,
    expectedIdentity: string,
    maximumBytes: number,
  ): Promise<Readonly<{ bytes: Uint8Array; identity: string }>>;
}

export type SkillRelationshipStoreRead =
  | Readonly<{ status: "ready"; state: SkillRelationshipsState }>
  | Readonly<{ status: "corrupt"; diagnostic: string; recoveryAvailable: boolean }>;

export interface SkillRelationshipStore {
  read(): Promise<SkillRelationshipStoreRead>;
  compareAndSave(
    expectedRevision: number,
    skills: SkillRelationshipsState["skills"],
  ): Promise<
    | Readonly<{ status: "saved"; state: SkillRelationshipsState }>
    | Readonly<{ status: "revision-conflict"; actualRevision: number }>
    | Readonly<{ status: "corrupt"; diagnostic: string; recoveryAvailable: boolean }>
  >;
  updateUsesExact(
    expectedRevision: number | undefined,
    effects: readonly SkillUseEffect[],
    records?: readonly SkillRecordEffect[],
  ): ReturnType<SkillRelationshipStore["compareAndSave"]>;
}

export type SkillManagedBaseRead =
  | Readonly<{ status: "ready"; revision: SkillRevision; files: ReadonlyMap<string, Uint8Array> }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "corrupt"; reason: string }>;

export interface SkillManagedBaseReader {
  read(baseRevisionId: string, maximumBytes?: number): Promise<SkillManagedBaseRead>;
}

export type SkillReconciliationDependencies = Readonly<{
  filesystem: SkillObservationFilesystem;
  store: SkillRelationshipStore;
  digest: TextDigest;
}>;
