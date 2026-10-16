import { createResourceCatalogue as createCatalogue } from "./catalogue";
import type { ResourceCatalogue, ResourceSnapshot } from "./types";

export type {
  ProjectSkillGroup,
  ProjectSkillGroupPackage,
  ProjectSkillLocation,
  SourceSkillPackageObservation,
} from "./project-skill-groups";

export type {
  BindingSnapshot,
  ResourceCatalogue,
  ResourceContext,
  ResourceDetails,
  ResourceListing,
  ResourceRecord,
  ResourceRef,
  ResourceRelation,
  ResourceSnapshot,
  RootEvidence,
} from "./types";

export function createResourceCatalogue(snapshot: ResourceSnapshot): ResourceCatalogue {
  return createCatalogue(snapshot);
}
