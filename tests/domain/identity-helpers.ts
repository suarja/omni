import { describe, expect, it } from "vitest";

import type { ObservedPackage } from "../../src/domain/inventory";
import type { EntryRef } from "../../src/domain/project-source-registry";
import {
  createArtifactIdentity,
  deriveIdentityFindings,
  executionClassForKind,
  type ArtifactIdentity,
  type PhysicalIdentityLookup,
} from "../../src/domain/identity";

export const project: EntryRef = { kind: "project", id: "project-a" };
export const source: EntryRef = { kind: "source", id: "source-a" };

export function identity(overrides: Partial<ArtifactIdentity> = {}): ArtifactIdentity {
  return {
    artifactId: "artifact-a",
    logicalId: "loose:instructions/review.md",
    contentHash: "a".repeat(64),
    byteLength: 12,
    executionClass: "static",
    kind: "instruction",
    provenance: { root: project, relativePath: "instructions/review.md" },
    ...overrides,
  };
}

export function packageRecord(id: string, relativeRoot = id): ObservedPackage {
  return {
    id,
    relativeRoot,
    displayName: id,
    format: "omni",
    manifestPaths: [`${relativeRoot}/omni.plugin.json`],
    artifactIds: [],
  };
}
