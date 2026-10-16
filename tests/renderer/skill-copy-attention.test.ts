import { expect, test } from "vitest";

import { correlateSkillCopies } from "../../src/domain/skill-reconciliation/correlation";
import type { SkillCopyLocationRead, SkillMember, SkillRevision } from "../../src/domain/skill-reconciliation/types";
import { createResourceCatalogue } from "../../src/domain/resource-catalogue";
import type { SkillAttentionSummary } from "../../src/domain/skill-reconciliation/attention";
import { projectCanvas } from "../../src/renderer/canvas/spatial/canvas-projection";
import { layoutCanvas } from "../../src/renderer/canvas/spatial/canvas-layout";
import { createCanvasSession } from "../../src/renderer/canvas/spatial/canvas-session";
import { resourceFixture } from "../fixtures/resource-catalogue";
import { denseSnapshot, projectSnapshot } from "../fixtures/spatial-canvas";

const projectEntry = resourceFixture.projectOneRef;
const skillId = "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18";

function observedRevision(hash: string): SkillRevision {
  return {
    algorithm: "omni-tree-v1",
    hash: hash.repeat(64),
    files: [{ path: "SKILL.md", hash: hash.repeat(64), byteLength: 1 }],
  };
}

function activeCopies() {
  const template = resourceFixture.projectObservation.inventory.artifacts[0]!;
  const artifacts = [".agents/skills/review/SKILL.md", ".claude/skills/review/SKILL.md"].map((path, index) => ({
    ...template,
    id: `attention-copy-${index}`,
    packageId: undefined,
    relativePath: path,
    displayPath: path,
    physicalIdentity: path,
    projectionPaths: [path],
  }));
  const snapshot = projectSnapshot(artifacts);
  const catalogue = createResourceCatalogue({ ...snapshot, uses: { status: "ready", bindings: [] } });
  const group = catalogue.projectSkillGroups(projectEntry)[0]!;
  const members: SkillMember[] = group.locations.map((location) => ({
    location: {
      projectId: projectEntry.id,
      harnessId: location.relativePath.startsWith(".claude/") ? "claude-code" : "codex",
      folderPath: location.relativePath.replace(/\/SKILL\.md$/u, ""),
    },
    ref: location.ref,
    read: { status: "complete", revision: observedRevision("a") },
  }));
  const locations: SkillCopyLocationRead[] = members.map((member, index) => ({
    location: member.location,
    read: index === 0 ? member.read : { status: "complete", revision: observedRevision("b") },
  }));
  const correlation = correlateSkillCopies({
    projectId: projectEntry.id,
    members: members.map((member, index) => ({ ...member, read: locations[index]!.read })),
    records: [
      { skillId, label: "review", evidence: "individual", locations: members.map((member) => member.location) },
    ],
    locationReads: locations,
    allocateId: () => skillId,
  });
  return { catalogue, group, correlation, locations };
}

test("copy differences mark one skill, its provenance group, project and exact ancestor wires", () => {
  const { catalogue, group, correlation } = activeCopies();
  const listing = catalogue.browse({ kind: "entry", entry: projectEntry });
  const attention: SkillAttentionSummary = { state: "copy-difference", reasons: ["copy-difference"] };
  const projectAttention = new Map([[projectEntry.id, attention]]);
  const overview = projectCanvas(listing, catalogue, null, new Map([[group.id, correlation]]), [], projectAttention);
  const groupView = projectCanvas(
    listing,
    catalogue,
    group.id,
    new Map([[group.id, correlation]]),
    [],
    projectAttention,
  );
  const skillNode = overview.groups.find((candidate) => candidate.id === group.id)?.children[0];
  const groupNode = overview.children.find((candidate) => candidate.kind === "group" && candidate.groupId === group.id);

  expect(skillNode).toMatchObject({ kind: "logical-skill", attention: { state: "copy-difference" } });
  expect(groupNode).toMatchObject({ kind: "group", attention: { state: "copy-difference" } });
  expect(overview.center).toMatchObject({ attention: { state: "copy-difference" } });
  expect(overview.relations).toHaveLength(1);
  expect(overview.relations[0]).toMatchObject({
    from: overview.center?.id,
    to: groupNode?.id,
    attention: { state: "copy-difference" },
  });
  expect(groupView.relations).toHaveLength(1);
  expect(groupView.relations[0]).toMatchObject({ to: skillNode?.id, attention: { state: "copy-difference" } });
  expect(layoutCanvas(overview, { width: 1440, height: 900 }).wires[0]).toMatchObject({
    attention: { state: "copy-difference" },
  });
  expect(layoutCanvas(groupView, { width: 1440, height: 900 }).wires[0]).toMatchObject({
    attention: { state: "copy-difference" },
  });
});

test("managed local attention is attributed by both logical skill id and exact location", () => {
  const { catalogue, group, correlation, locations } = activeCopies();
  const shared = observedRevision("a");
  const equalCorrelation = {
    ...correlation,
    groups: correlation.groups.map((candidate) => ({
      ...candidate,
      state: "matching-copies" as const,
      members: candidate.members.map((member) => ({
        ...member,
        read: { status: "complete" as const, revision: shared },
      })),
      locations: candidate.locations.map((item) => ({
        location: item.location,
        read: { status: "complete" as const, revision: shared },
      })),
    })),
  };
  const listing = catalogue.browse({ kind: "entry", entry: projectEntry });
  const project = (attentionSkillId: string) =>
    projectCanvas(listing, catalogue, null, new Map([[group.id, equalCorrelation]]), [], new Map(), [
      { skillId: attentionSkillId, location: locations[0]!.location, state: "local-change" },
    ]).groups.find((candidate) => candidate.id === group.id)?.children[0];

  expect(project(skillId)).toMatchObject({
    kind: "logical-skill",
    attention: { state: "local-change", reasons: ["local-change"] },
  });
  expect(project("f77eb18e-5c7d-4db8-a2fd-1d941a2aef18")).toMatchObject({
    kind: "logical-skill",
    attention: { state: "quiet", reasons: [] },
  });
});

test("one complete unmanaged location remains quiet", () => {
  const template = resourceFixture.projectObservation.inventory.artifacts[0]!;
  const artifact = {
    ...template,
    id: "quiet-copy",
    packageId: undefined,
    relativePath: ".agents/skills/quiet/SKILL.md",
    displayPath: ".agents/skills/quiet/SKILL.md",
    physicalIdentity: "quiet-copy",
    projectionPaths: [".agents/skills/quiet/SKILL.md"],
  };
  const base = projectSnapshot([artifact]);
  const catalogue = createResourceCatalogue({ ...base, uses: { status: "ready", bindings: [] } });
  const group = catalogue.projectSkillGroups(projectEntry)[0]!;
  const location = {
    projectId: projectEntry.id,
    harnessId: "codex" as const,
    folderPath: ".agents/skills/quiet",
  };
  const read = { status: "complete" as const, revision: observedRevision("c") };
  const correlation = correlateSkillCopies({
    projectId: projectEntry.id,
    members: [{ location, ref: group.locations[0]!.ref, read }],
    records: [],
    locationReads: [{ location, read }],
    allocateId: () => "quiet-skill",
  });
  const listing = catalogue.browse({ kind: "entry", entry: projectEntry });
  const overview = projectCanvas(listing, catalogue, null, new Map([[group.id, correlation]]));
  const detail = projectCanvas(listing, catalogue, group.id, new Map([[group.id, correlation]]));

  expect(overview.groups.find((candidate) => candidate.id === group.id)?.attention).toBeUndefined();
  expect(detail.children[0]).toMatchObject({ kind: "logical-skill", attention: { state: "quiet", reasons: [] } });
  expect(overview.relations[0]?.attention).toBeUndefined();
  expect(layoutCanvas(overview, { width: 1440, height: 900 }).wires[0]?.attention).toBeUndefined();
});

test("mixed project reasons retain unavailable copies while unrelated workspace edges stay quiet", () => {
  const { catalogue, group, correlation, locations } = activeCopies();
  const missingLocation = {
    projectId: projectEntry.id,
    harnessId: "codex" as const,
    folderPath: ".agents/skills/retained",
  };
  const retainedSkills = [
    {
      record: {
        skillId: "retained-skill",
        label: "retained",
        evidence: "individual" as const,
        locations: [missingLocation],
      },
      locations: [{ location: missingLocation, read: { status: "unavailable" as const, reason: "missing" as const } }],
    },
  ];
  const listing = catalogue.browse({ kind: "entry", entry: projectEntry });
  const mixedAttention: SkillAttentionSummary = {
    state: "copy-difference",
    reasons: ["copy-difference", "unavailable"],
  };
  const overview = projectCanvas(
    listing,
    catalogue,
    null,
    new Map([[group.id, correlation]]),
    retainedSkills,
    new Map([[projectEntry.id, mixedAttention]]),
  );
  const workspaceCatalogue = createResourceCatalogue(denseSnapshot());
  const workspaceListing = workspaceCatalogue.browse({ kind: "workspace" });
  const project = workspaceListing.children.find((resource) => resource.kind === "project");
  const source = workspaceListing.children.find(
    (resource) => resource.kind === "marketplace" || resource.kind === "external-source",
  );
  if (!project || !source) throw new Error("Workspace fixture must include a project and source.");
  const connectedWorkspace = {
    ...workspaceListing,
    relations: [{ from: source.ref, to: project.ref, kind: "desired-use" as const, bindingIds: ["binding-one"] }],
  };
  const projectAttention = new Map<string, SkillAttentionSummary>([[projectEntry.id, mixedAttention]]);
  const workspace = projectCanvas(connectedWorkspace, workspaceCatalogue, null, new Map(), [], projectAttention);

  expect(
    overview.groups
      .find((candidate) => candidate.id === group.id)
      ?.children.find((child) => child.kind === "logical-skill" && child.skillId === skillId),
  ).toMatchObject({
    attention: { state: "copy-difference", reasons: ["copy-difference"] },
  });
  expect(overview.groups.find((candidate) => candidate.id === group.id)?.attention).toMatchObject(mixedAttention);
  expect(overview.groups.find((candidate) => candidate.id === "individual-skills")?.children[0]).toMatchObject({
    skillId: "retained-skill",
    attention: { state: "unavailable", reasons: ["unavailable"] },
  });
  expect(workspace.children.find((node) => node.kind === "resource" && node.resource.kind === "project")).toMatchObject(
    {
      attention: { state: "copy-difference", reasons: ["copy-difference", "unavailable"] },
    },
  );
  expect(workspace.relations).toHaveLength(1);
  expect(workspace.relations[0]?.attention).toBeUndefined();
});

test("fully retained unavailable records stay reachable in Individual skills without fake members", () => {
  const catalogue = createResourceCatalogue(projectSnapshot([]));
  const a = { projectId: projectEntry.id, harnessId: "codex" as const, folderPath: ".agents/skills/retained" };
  const b = { projectId: projectEntry.id, harnessId: "claude-code" as const, folderPath: ".claude/skills/retained" };
  const retainedSkills = [
    {
      record: { skillId, label: "retained", evidence: "individual" as const, locations: [a, b] },
      locations: [a, b].map((location) => ({
        location,
        read: { status: "unavailable" as const, reason: "missing" as const },
      })),
    },
  ];
  const listing = catalogue.browse({ kind: "entry", entry: projectEntry });
  const overview = projectCanvas(listing, catalogue, null, new Map(), retainedSkills);
  const individual = overview.groups.find((group) => group.id === "individual-skills");

  expect(individual).toMatchObject({ category: "individual", attention: { state: "unavailable" } });
  expect(individual?.children).toHaveLength(1);
  expect(individual?.children[0]).toMatchObject({
    kind: "logical-skill",
    skillId,
    members: [],
    locations: retainedSkills[0]!.locations,
    attention: { state: "unavailable" },
  });
});

test("project attention stays in the injected session and root changes invalidate it", () => {
  const session = createCanvasSession();
  const snapshot = {
    projectId: "project-one",
    rootKey: "root-a",
    observationKey: "scan-one",
    freshness: "fresh" as const,
    observedAt: "2026-10-08T10:00:00.000Z",
    state: "copy-difference" as const,
    reasons: ["copy-difference"] as const,
  };
  session.writeProjectAttention(snapshot);
  expect(session.readProjectAttention("project-one")).toEqual(snapshot);
  expect(createCanvasSession().readProjectAttention("project-one")).toBeUndefined();

  session.retainProjectAttention([{ projectId: "project-one", rootKey: "root-b" }]);
  expect(session.readProjectAttention("project-one")).toBeUndefined();
  session.writeProjectAttention(snapshot);
  session.retainProjectAttention([]);
  expect(session.readProjectAttention("project-one")).toBeUndefined();
});
