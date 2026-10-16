export type SkillInventoryLocation = Readonly<{ harness: string; folder: string; linkTo?: string }>;
export type SkillInventoryOrigin =
  | Readonly<{ kind: "marketplace"; sourceId: string; packageId: string; bindingId?: string; state?: string }>
  | Readonly<{ kind: "external"; repo: string; skillPath?: string; state: string }>
  | Readonly<{ kind: "local" }>;

/** Main-process observation, before compact projection. Full hashes are retained for identity; only the public projection shortens them. */
export type SkillInventoryReadUnit = Readonly<{
  id: string;
  name: string;
  scope: string;
  packageId?: string;
  locations: readonly SkillInventoryLocation[];
  origin: SkillInventoryOrigin;
  description: string;
  lines: number | null;
  files: number | null;
  contentHash: string | null;
  skillMdPath: string;
}>;
export type SkillInventoryScope = Readonly<{
  key: string;
  kind: "project" | "marketplace";
  projectId?: string;
  sourceId?: string;
  name: string;
  root: string;
}>;
/** path is the primary SKILL.md location. locations contains only additional aliases. */
export type SkillInventoryUnit = Readonly<{
  id: string;
  name: string;
  scope: string;
  path: string;
  hash?: string;
  packageId?: string;
  locations?: readonly SkillInventoryLocation[];
  origin?: Exclude<SkillInventoryOrigin, { kind: "local" }>;
  description?: string;
  lines?: number;
  files?: number;
}>;
export type SkillInventoryIdentity = Readonly<{
  byName: readonly Readonly<{
    name: string;
    kinds: readonly ("sameNameDifferentContent" | "unlinkedCopies" | "multipleSources")[];
    units: readonly string[];
    hashes: Readonly<Record<string, string>>;
    unlinkedCopies?: readonly Readonly<{ project: string; marketplace: string }>[];
  }>[];
  sameContentDifferentNames: readonly Readonly<{ contentHash: string; units: readonly string[] }>[];
  staleBindings: readonly Readonly<{ bindingId: string; projectId: string; folder: string }>[];
}>;
export type SkillInventoryLimit = Readonly<{ scope: string; path: string; reason: string }>;
export type SkillInventorySnapshot = Readonly<{
  status: "ready" | "partial";
  scopes: readonly SkillInventoryScope[];
  units: readonly SkillInventoryUnit[];
  identity: SkillInventoryIdentity;
  unavailable: readonly Readonly<{ projectId?: string; name: string; reason: string }>[];
  limits: readonly SkillInventoryLimit[];
}>;
export type SkillInventoryPublicLimit =
  | SkillInventoryLimit
  | Readonly<{
      reason: "description-capped-at-160";
      count: number;
      examples: readonly Readonly<{ scope: string; path: string }>[];
    }>;
export type AgentSkillInventoryResponse = Readonly<{
  status?: "ready" | "partial";
  scopes?: readonly SkillInventoryScope[];
  units: readonly SkillInventoryUnit[];
  identity?: SkillInventoryIdentity;
  unavailable?: SkillInventorySnapshot["unavailable"];
  limits?: readonly SkillInventoryPublicLimit[];
  nextCursor?: string;
}>;
