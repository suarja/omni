// @vitest-environment jsdom
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { SkillCopiesSheet } from "../../src/renderer/canvas/SkillCopiesSheet";
import { ChangesWorkbench } from "../../src/renderer/canvas/changes/ChangesWorkbench";
import type { SkillLocationKey } from "../../src/domain/skill-reconciliation/types";
import type { ObserveSkillCopiesRequest } from "../../src/shared/skill-reconciliation-ipc";
import { correlateSkillCopies } from "../../src/domain/skill-reconciliation/correlation";
import type { LogicalSkillNode } from "../../src/renderer/canvas/spatial/spatial-types";
import type { ProjectSkillGroup } from "../../src/domain/resource-catalogue";
import type { DesktopApi } from "../../src/shared/ipc";
import type {
  SkillCopyComparisonRequest,
  SkillCopyComparisonResponse,
} from "../../src/shared/skill-copy-comparison-ipc";
import { I18nProvider } from "../../src/renderer/i18n";
import { resourceFixture, snapshot } from "../fixtures/resource-catalogue";
export { snapshot };
import { projectSnapshot } from "../fixtures/spatial-canvas";

export const ref = { kind: "artifact" as const, entry: resourceFixture.projectOneRef, artifactId: "copy" };
export const locationA: SkillLocationKey = {
  projectId: ref.entry.id,
  harnessId: "codex",
  folderPath: ".agents/skills/review",
};
export const locationB: SkillLocationKey = {
  projectId: ref.entry.id,
  harnessId: "claude-code",
  folderPath: ".claude/skills/review",
};
export const locations = [locationA, locationB];
export const skillId = "d4c8d2a7-11c1-4c71-9d13-3b06a4a37e81";

export function revision(): LogicalSkillNode["members"][number]["read"] {
  return {
    status: "complete",
    revision: {
      algorithm: "omni-tree-v1",
      hash: "a".repeat(64),
      files: ["SKILL.md", "guides/only-a.md", "assets/preview.bin", "notes/matching.md"].map((path) => ({
        path,
        hash: path === "notes/matching.md" ? "b".repeat(64) : "a".repeat(64),
        byteLength: 8,
      })),
    },
  };
}

export const node: LogicalSkillNode = {
  kind: "logical-skill",
  id: `logical-skill:${skillId}`,
  skillId,
  label: "review",
  groupId: "individual-skills",
  members: locations.map((location) => ({ ref, location, read: revision() })),
  locations: locations.map((location) => ({ location, read: revision() })),
  attention: { state: "quiet", reasons: [] },
  record: { skillId, label: "review", evidence: "observed-equivalence", locations },
};
export const group: ProjectSkillGroup = {
  id: node.groupId,
  category: "individual",
  label: "Individual skills",
  locations: locations.map((location) => ({ ref, relativePath: `${location.folderPath}/SKILL.md` })),
};

export const fileSummaries = [
  {
    path: "SKILL.md",
    change: "change",
    left: { hash: "a".repeat(64), byteLength: 8 },
    right: { hash: "b".repeat(64), byteLength: 9 },
  },
  {
    path: "assets/preview.bin",
    change: "change",
    left: { hash: "a".repeat(64), byteLength: 8 },
    right: { hash: "b".repeat(64), byteLength: 9 },
  },
  { path: "guides/only-a.md", change: "add", right: { hash: "b".repeat(64), byteLength: 8 } },
  {
    path: "notes/matching.md",
    change: "unchanged",
    left: { hash: "b".repeat(64), byteLength: 8 },
    right: { hash: "b".repeat(64), byteLength: 8 },
  },
] as const;

export function comparisonResponse(filePath?: string): SkillCopyComparisonResponse {
  const base = {
    status: "ready" as const,
    projectId: ref.entry.id,
    skillId,
    a: { location: locationB, read: revision() },
    b: { location: locationA, read: revision() },
    files: fileSummaries,
    evidence: { source: "unknown" as const, base: "unknown" as const, relationship: "observed-equivalence" as const },
  };
  if (filePath === "assets/preview.bin") {
    return {
      ...base,
      selectedPath: filePath,
      presentation: { presentation: "binary", summary: "Binary bytes differ; text preview is unavailable." },
    };
  }
  if (filePath === "notes/matching.md") {
    return { ...base, selectedPath: filePath, presentation: { presentation: "unchanged" } };
  }
  const selectedPath = filePath ?? "SKILL.md";
  return {
    ...base,
    selectedPath,
    presentation: { presentation: "text", diff: "--- A\n+++ B\n@@ -1 +1 @@\n-old\n+new\n", truncated: false },
  };
}

export function canvasCopySnapshot() {
  const template = resourceFixture.projectObservation.inventory.artifacts[0]!;
  const skill = {
    ...template,
    id: "compare-review",
    relativePath: ".agents/skills/review/SKILL.md",
    displayPath: ".agents/skills/review/SKILL.md",
    physicalIdentity: "compare-review",
    projectionPaths: [".agents/skills/review/SKILL.md", ".claude/skills/review/SKILL.md"],
  };
  const support = {
    ...skill,
    id: "compare-review-support",
    kind: "unknown" as const,
    relativePath: ".agents/skills/review/guides/only-a.md",
    displayPath: ".agents/skills/review/guides/only-a.md",
    physicalIdentity: "compare-review-support",
    projectionPaths: [".agents/skills/review/guides/only-a.md"],
  };
  return projectSnapshot([skill, support]);
}

export function observedCopies(request: ObserveSkillCopiesRequest) {
  const read = {
    status: "complete" as const,
    revision: {
      algorithm: "omni-tree-v1" as const,
      hash: "a".repeat(64),
      files: ["SKILL.md", "guides/only-a.md"].map((path) => ({ path, hash: "a".repeat(64), byteLength: 8 })),
    },
  };
  return {
    status: "ready" as const,
    storeRevision: 1,
    retainedSkills: [],
    managedUses: [],
    groups: request.groups.map((group) => {
      const members = group.members.map((member) => ({
        location: {
          projectId: request.projectId,
          harnessId: member.relativePath.startsWith(".claude/") ? ("claude-code" as const) : ("codex" as const),
          folderPath: member.relativePath.replace(/\/SKILL\.md$/u, ""),
        },
        ref: member.ref,
        read,
      }));
      return {
        groupId: group.groupId,
        correlation: correlateSkillCopies({
          projectId: request.projectId,
          members,
          records: [],
          allocateId: () => `logical-${group.groupId}`,
        }),
      };
    }),
  };
}

export function render(element: ReactElement): { container: HTMLDivElement; root: Root } {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container);
  act(() => root.render(<I18nProvider initialLanguage="en">{element}</I18nProvider>));
  return { container, root };
}

export function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void; reject(error: Error): void }> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function readyForRequest(request: SkillCopyComparisonRequest, content: string): SkillCopyComparisonResponse {
  const path = request.filePath ?? "SKILL.md";
  return {
    status: "ready",
    projectId: request.projectId,
    skillId: request.skillId,
    a: { location: request.a, read: revision() },
    b: { location: request.b, read: revision() },
    files: [
      {
        path: "SKILL.md",
        change: "change",
        left: { hash: "a".repeat(64), byteLength: 8 },
        right: { hash: "b".repeat(64), byteLength: 9 },
      },
      { path: "guides/only-a.md", change: "add", right: { hash: "c".repeat(64), byteLength: 7 } },
    ],
    selectedPath: path,
    presentation: {
      presentation: "text",
      diff: `--- A\n+++ B\n@@ -1 +1 @@\n-${content}\n+${content} updated\n`,
      truncated: false,
    },
    evidence: { source: "unknown", base: "unknown", relationship: "observed-equivalence" },
  };
}

export function ReaderToComparison(props: Readonly<{ api: DesktopApi }>): ReactElement {
  const [left, setLeft] = useState<SkillLocationKey | null>(null);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  return (
    <>
      <SkillCopiesSheet
        api={{ readArtifact: props.api.readArtifact ?? vi.fn() }}
        group={group}
        initialTab="metadata"
        node={node}
        onClose={() => undefined}
        onCompare={(selected) => {
          setLeft(selected);
          setComparisonOpen(true);
        }}
        onEnsureGrant={async () => "project-grant"}
        snapshot={snapshot}
      />
      {comparisonOpen && left ? (
        <ChangesWorkbench
          api={props.api}
          initialLeft={left}
          locations={locations}
          mode="comparison"
          onBack={() => setComparisonOpen(false)}
          onClose={() => setComparisonOpen(false)}
          onEnsureGrant={async () => "project-grant"}
          projectId={ref.entry.id}
          skillId={skillId}
        />
      ) : null}
    </>
  );
}
