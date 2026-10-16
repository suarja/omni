export type SkillOriginEvidence = Readonly<{
  artifactId: string;
  relativePath: string;
  source: Readonly<{ kind: "github"; locator: string }>;
  skillKey?: string;
  sourceSkillPath?: string;
  reference?: string;
  lockPath: "skills-lock.json";
  recordedHash: string;
  copyHash?: string;
  verification: "matches-lock" | "modified" | "unverified";
  verificationReason?: "budget" | "unsafe-tree" | "unavailable";
}>;

export type SkillLockEntry = Readonly<{
  skillKey: string;
  source: Readonly<{ kind: "github"; locator: string }>;
  sourceSkillPath?: string;
  reference?: string;
  recordedHash: string;
}>;

export type SkillLockResult = Readonly<{
  entries: readonly SkillLockEntry[];
  issues: readonly Readonly<{ code: "malformed" | "unsupported"; message: string }>[];
}>;
