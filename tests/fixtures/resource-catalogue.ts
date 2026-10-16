import type { Binding } from "../../src/domain/assignment-plan";
import type { ObservedArtifact, ObservedPackage } from "../../src/domain/inventory";
import type { EntryRef, Observation, RegistryView } from "../../src/domain/project-source-registry";
import type { ResourceRef, ResourceSnapshot } from "../../src/domain/resource-catalogue";

const sourceRef = { kind: "source", id: "source-one" } as const satisfies EntryRef;
const projectOneRef = { kind: "project", id: "project-one" } as const satisfies EntryRef;
const projectTwoRef = { kind: "project", id: "project-two" } as const satisfies EntryRef;
const skill: ObservedArtifact = {
  id: "skill-one",
  physicalIdentity: "plugins/pstack/skills/review/SKILL.md",
  projectionPaths: ["plugins/pstack/skills/review/SKILL.md"],
  kind: "skill",
  relativePath: "plugins/pstack/skills/review/SKILL.md",
  displayPath: "plugins/pstack/skills/review/SKILL.md",
  providerIds: [],
  scope: "source",
  confidence: "exact",
  symlinkState: "none",
  packageId: "pstack",
  summary: "Review source with evidence.",
};
const otherSkill: ObservedArtifact = {
  ...skill,
  id: "skill-copy",
  packageId: "other",
  relativePath: "plugins/other/skills/review/SKILL.md",
  displayPath: "plugins/other/skills/review/SKILL.md",
  physicalIdentity: "plugins/other/skills/review/SKILL.md",
  projectionPaths: ["plugins/other/skills/review/SKILL.md"],
};
const support: ObservedArtifact = {
  ...skill,
  id: "review-reference",
  kind: "unknown",
  relativePath: "plugins/pstack/skills/review/references/note.md",
  displayPath: "plugins/pstack/skills/review/references/note.md",
  physicalIdentity: "plugins/pstack/skills/review/references/note.md",
  projectionPaths: ["plugins/pstack/skills/review/references/note.md"],
  packageId: "pstack",
};
const command: ObservedArtifact = {
  ...skill,
  id: "check-command",
  kind: "command",
  packageId: "pstack",
  relativePath: "plugins/pstack/commands/check.md",
  displayPath: "plugins/pstack/commands/check.md",
  physicalIdentity: "plugins/pstack/commands/check.md",
  projectionPaths: ["plugins/pstack/commands/check.md"],
};
const manifest: ObservedArtifact = {
  ...skill,
  id: "manifest",
  kind: "plugin-manifest",
  packageId: "pstack",
  relativePath: "plugins/pstack/.claude-plugin/plugin.json",
  displayPath: "plugins/pstack/.claude-plugin/plugin.json",
  physicalIdentity: "plugins/pstack/.claude-plugin/plugin.json",
  projectionPaths: ["plugins/pstack/.claude-plugin/plugin.json"],
};
const packages: readonly ObservedPackage[] = [
  {
    id: "pstack",
    relativeRoot: "plugins/pstack",
    displayName: "pstack",
    format: "claude-plugin",
    manifestPaths: [manifest.relativePath],
    readmePath: "plugins/pstack/README.md",
    description: "Tools",
    version: "1.0.0",
    artifactIds: [skill.id, support.id, command.id, manifest.id],
  },
  {
    id: "other",
    relativeRoot: "plugins/other",
    displayName: "Other",
    format: "implicit",
    manifestPaths: [],
    artifactIds: [otherSkill.id],
  },
];

function observation(subject: EntryRef, artifacts: readonly ObservedArtifact[], observedAt: string): Observation {
  return {
    subject,
    observedAt,
    inventory: {
      rootHandle: "secret-grant-handle",
      displayRoot: "private-root",
      observedAt,
      harnesses: [],
      artifacts,
      packages: subject.kind === "source" ? packages : [],
      marketplace:
        subject.kind === "source"
          ? {
              name: "Personal Skills",
              description: "Reusable tools.",
              readmePath: "README.md",
              manifestPath: "marketplace.json",
            }
          : undefined,
      diagnostics: [
        { location: "plugins/pstack", code: "git-unavailable", severity: "warning", message: "Git unavailable" },
      ],
      gitScopes: [],
    },
  };
}

const sourceObservation = observation(
  sourceRef,
  [skill, support, command, manifest, otherSkill],
  "2026-10-04T10:00:00.000Z",
);
const projectSkill = {
  ...skill,
  id: "project-skill",
  packageId: undefined,
  relativePath: ".claude/skills/review/SKILL.md",
  displayPath: ".claude/skills/review/SKILL.md",
  physicalIdentity: ".claude/skills/review/SKILL.md",
  projectionPaths: [".claude/skills/review/SKILL.md"],
};
const projectObservation = observation(projectOneRef, [projectSkill], "2026-10-04T10:01:00.000Z");
const registry: RegistryView = {
  revision: 1,
  sources: [
    {
      ref: sourceRef,
      displayName: "Personal Skills",
      displayRoot: "skills",
      availability: "available",
      ownership: "personal",
      capabilities: { observe: true, write: false },
    },
  ],
  projects: [
    { ref: projectOneRef, displayName: "Project One", displayRoot: "one", availability: "available" },
    { ref: projectTwoRef, displayName: "Project Two", displayRoot: "two", availability: "available" },
  ],
};
const bindings: readonly Binding[] = [
  {
    bindingId: "binding-one",
    sourceId: sourceRef.id,
    packageId: "pstack",
    artifactPath: "skills/review",
    kind: "skill",
    projectId: projectOneRef.id,
    harnessId: "codex",
    boundHash: "old",
    createdAt: "2026-10-04T10:00:00.000Z",
  },
  {
    bindingId: "binding-two",
    sourceId: sourceRef.id,
    packageId: "pstack",
    artifactPath: "skills/review",
    kind: "skill",
    projectId: projectOneRef.id,
    harnessId: "claude-code",
    boundHash: "old",
    createdAt: "2026-10-04T10:00:00.000Z",
  },
];

export const sourceRefResource: ResourceRef = { kind: "entry", entry: sourceRef };
export const skillRef: ResourceRef = { kind: "artifact", entry: sourceRef, artifactId: skill.id };
export const otherSkillRef: ResourceRef = { kind: "artifact", entry: sourceRef, artifactId: otherSkill.id };
export const snapshot: ResourceSnapshot = {
  registry,
  roots: [
    { entry: sourceRef, evidence: { status: "observed", observation: sourceObservation } },
    { entry: projectOneRef, evidence: { status: "observed", observation: projectObservation } },
    { entry: projectTwoRef, evidence: { status: "unobserved" } },
  ],
  uses: { status: "ready", bindings },
};

export const resourceFixture = {
  registry,
  bindings,
  sourceRef,
  projectOneRef,
  projectTwoRef,
  sourceObservation,
  projectObservation,
};
