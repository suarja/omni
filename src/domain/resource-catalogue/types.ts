import type { InventoryArtifactKind, InventoryDiagnostic } from "../inventory";
import type { Binding } from "../assignment-plan";
import type { ObservedPackageFormat } from "../inventory";
import type { Availability, EntryRef, Observation, RegistryView } from "../project-source-registry";
import type { SkillOriginEvidence } from "../skill-origins/types";
import type { ProjectSkillGroup } from "./project-skill-groups";

export type ResourceRef =
  | Readonly<{ kind: "entry"; entry: EntryRef }>
  | Readonly<{ kind: "package"; entry: EntryRef; packageId: string }>
  | Readonly<{ kind: "artifact"; entry: EntryRef; artifactId: string }>;
export type ResourceContext = Readonly<{ kind: "workspace" }> | ResourceRef;
export type BindingSnapshot =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; bindings: readonly Binding[] }>
  | Readonly<{ status: "unavailable" }>;
export type RootEvidence =
  | Readonly<{ status: "unobserved" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "unavailable"; reason: "missing" | "inaccessible" | "denied" | "failed" }>
  | Readonly<{ status: "observed"; observation: Observation }>;
export type ResourceSnapshot = Readonly<{
  registry: RegistryView;
  roots: readonly Readonly<{ entry: EntryRef; evidence: RootEvidence }>[];
  uses: BindingSnapshot;
}>;
export type ResourceRecord = Readonly<{
  ref: ResourceRef;
  label: string;
  kind: "marketplace" | "storefront" | "external-source" | "project" | "plugin" | "artifact";
  artifactKind?: InventoryArtifactKind;
  state: RootEvidence["status"];
  availability: Availability;
  unavailableReason?: "missing" | "inaccessible" | "denied" | "failed";
  relativePath?: string;
  description?: string;
  version?: string;
  observedAt?: string;
}>;
export type ResourceRelation = Readonly<{
  from: ResourceRef;
  to: ResourceRef;
  kind: "contains" | "desired-use";
  bindingIds: readonly string[];
}>;
export type ResourceListing = Readonly<{
  status: "ready" | "partial" | "unobserved" | "loading" | "unavailable" | "not-found";
  context: ResourceContext;
  center?: ResourceRecord;
  children: readonly ResourceRecord[];
  relations: readonly ResourceRelation[];
}>;
export type ResourceDetails = Readonly<{
  resource: ResourceRecord;
  parent?: ResourceRef;
  diagnostics: readonly InventoryDiagnostic[];
  files: readonly Readonly<{ relativePath: string; role: "readme" | "content" | "support" }>[];
  uses: BindingSnapshot;
  packageFormat?: ObservedPackageFormat;
  skillOrigins?: readonly SkillOriginEvidence[];
  membershipIssues?: readonly Readonly<{
    relativePath: string;
    reason: NonNullable<ProjectSkillGroup["locations"][number]["membershipIssue"]>;
  }>[];
}>;
export type ResourceCatalogue = Readonly<{
  browse(context: ResourceContext): ResourceListing;
  inspect(ref: ResourceRef): ResourceDetails | null;
  search(query: string): readonly ResourceRecord[];
  projectSkillGroups(entry: EntryRef): readonly ProjectSkillGroup[];
}>;
