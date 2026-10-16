import type { HarnessId } from "../harness-targets";
import type { ResourceRef } from "../resource-catalogue";

export type SkillLocationKey = Readonly<{
  projectId: string;
  harnessId: HarnessId;
  folderPath: string;
}>;

export type SourceSkillRef = Readonly<{
  sourceId: string;
  packageId: string;
  artifactPath: string;
}>;

export type ManagedSkillUse = Readonly<{
  skillId: string;
  bindingId: string;
  location: SkillLocationKey;
  source: SourceSkillRef;
  baseRevisionId: string;
  // A legacy copy without complete ownership evidence must stay out of automatic replacement.
  baseUnavailable?: true;
  disabled?: true;
}>;

export type SkillManagedAttentionState = "matches-base" | "local-change" | "unavailable";
export type SkillManagedAttention = Readonly<{
  skillId: string;
  location: SkillLocationKey;
  state: SkillManagedAttentionState;
}>;

export type SkillUseEffect = Readonly<{
  skillId: string;
  location: SkillLocationKey;
  before?: ManagedSkillUse;
  after?: ManagedSkillUse;
}>;

export type SkillRecordEffect = Readonly<{
  skillId: string;
  before?: LogicalSkillRecord;
  after?: LogicalSkillRecord;
}>;

export type SkillRevision = Readonly<{
  algorithm: "omni-tree-v1";
  hash: string;
  files: readonly Readonly<{ path: string; hash: string; byteLength: number }>[];
}>;

export type SkillTreeRead =
  | Readonly<{ status: "complete"; revision: SkillRevision }>
  | Readonly<{
      status: "unavailable";
      reason: "missing" | "denied" | "unsafe-tree" | "limit" | "changed-during-read" | "io";
    }>;

export type SkillCopyLocationRead = Readonly<{
  location: SkillLocationKey;
  read: SkillTreeRead;
}>;

export type SkillDeclaration = Readonly<{
  locator: string;
  skillKey: string;
  upstreamPath?: string;
}>;

export type SkillMember = Readonly<{
  location: SkillLocationKey;
  ref: Extract<ResourceRef, { kind: "artifact" }>;
  read: SkillTreeRead;
  declaration?: SkillDeclaration;
}>;

export type LogicalSkillRecord = Readonly<{
  skillId: string;
  label: string;
  evidence: "declared" | "observed-equivalence" | "individual";
  declaration?: SkillDeclaration;
  locations: readonly SkillLocationKey[];
  reference?: SkillRevision;
}>;

export type ReconciliationState =
  | "matching-copies"
  | "copy-difference"
  | "update-available"
  | "local-change"
  | "conflict"
  | "needs-link"
  | "unavailable";

export type SkillCorrelationInput = Readonly<{
  projectId: string;
  members: readonly SkillMember[];
  records: readonly LogicalSkillRecord[];
  locationReads?: readonly SkillCopyLocationRead[];
  allocateId: () => string;
}>;

export type SkillCorrelation = Readonly<{
  records: readonly LogicalSkillRecord[];
  groups: readonly Readonly<{
    skillId: string;
    members: readonly SkillMember[];
    locations: readonly SkillCopyLocationRead[];
    state: ReconciliationState;
  }>[];
  candidates: readonly Readonly<{
    locations: readonly SkillLocationKey[];
    reason: "same-name" | "same-content" | "conflicting-lineage";
  }>[];
}>;

export type SkillRelationshipsState = Readonly<{
  schemaVersion: 1;
  revision: number;
  skills: readonly LogicalSkillRecord[];
  uses: readonly ManagedSkillUse[];
}>;
