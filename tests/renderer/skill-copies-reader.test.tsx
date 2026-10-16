// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { SkillCopiesSheet } from "../../src/renderer/canvas/SkillCopiesSheet";
import { I18nProvider } from "../../src/renderer/i18n";
import type { LogicalSkillNode } from "../../src/renderer/canvas/spatial/spatial-types";
import type { ProjectSkillGroup } from "../../src/domain/resource-catalogue";
import { resourceFixture, snapshot } from "../fixtures/resource-catalogue";

test("the compact reader selects an exact copy and files omitted by inventory", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container);
  const ref = { kind: "artifact" as const, entry: resourceFixture.projectOneRef, artifactId: "copy" };
  const members: LogicalSkillNode["members"] = [".agents", ".claude"].map((tool) => ({
    ref,
    location: {
      projectId: ref.entry.id,
      harnessId: tool === ".agents" ? "codex" : "claude-code",
      folderPath: `${tool}/skills/review`,
    },
    read: {
      status: "complete",
      revision: {
        algorithm: "omni-tree-v1",
        hash: "a".repeat(64),
        files: ["SKILL.md", "resources/undetected.txt"].map((path) => ({ path, hash: "a".repeat(64), byteLength: 8 })),
      },
    },
  }));
  const node: LogicalSkillNode = {
    kind: "logical-skill",
    id: "logical-skill:one",
    skillId: "one",
    label: "review",
    groupId: "individual-skills",
    members,
    locations: members.map(({ location, read }) => ({ location, read })),
    attention: { state: "quiet", reasons: [] },
    record: {
      skillId: "one",
      label: "review",
      evidence: "observed-equivalence",
      locations: members.map((m) => m.location),
    },
  };
  const group: ProjectSkillGroup = {
    id: node.groupId,
    category: "individual",
    label: "Individual skills",
    locations: members.map((m) => ({ ref, relativePath: `${m.location.folderPath}/SKILL.md` })),
  };
  const readArtifact = vi.fn(async () => ({
    status: "read" as const,
    content: "# Actual content",
    byteLength: 16,
    truncated: false,
  }));
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <SkillCopiesSheet
            node={node}
            group={group}
            snapshot={snapshot}
            api={{ readArtifact }}
            onEnsureGrant={async () => "grant"}
            onClose={() => undefined}
            initialTab="document"
          />
        </I18nProvider>,
      ),
    );
    const location = container.querySelector<HTMLSelectElement>('select[aria-label="Location"]');
    expect(location).not.toBeNull();
    expect(container.querySelector(".canvas-location-list")).toBeNull();
    await act(async () => {
      location!.value = location!.options[1]!.value;
      location!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(readArtifact).toHaveBeenLastCalledWith({
      ...ref.entry,
      grantHandle: "grant",
      relativePath: ".claude/skills/review/SKILL.md",
    });
    const files = [...container.querySelectorAll<HTMLButtonElement>(".canvas-sheet-tabs button")].find(
      (b) => b.textContent === "Files",
    );
    act(() => files!.click());
    const support = [...container.querySelectorAll<HTMLButtonElement>(".canvas-file-list button")].find((b) =>
      b.textContent?.includes("resources/undetected.txt"),
    );
    expect(support).toBeDefined();
    await act(async () => support!.click());
    expect(readArtifact).toHaveBeenLastCalledWith({
      ...ref.entry,
      grantHandle: "grant",
      relativePath: ".claude/skills/review/resources/undetected.txt",
    });
    expect(container.textContent).toContain("Actual content");
  } finally {
    act(() => root.unmount());
  }
});

test("a retained skill with no observed members opens metadata without fabricating a file read", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container);
  const location = {
    projectId: resourceFixture.projectOneRef.id,
    harnessId: "codex" as const,
    folderPath: ".agents/skills/retained",
  };
  const node: LogicalSkillNode = {
    kind: "logical-skill",
    id: "logical-skill:retained",
    skillId: "retained",
    label: "retained",
    groupId: "individual-skills",
    members: [],
    locations: [{ location, read: { status: "unavailable", reason: "missing" } }],
    attention: { state: "unavailable", reasons: ["unavailable"] },
    record: { skillId: "retained", label: "retained", evidence: "individual", locations: [location] },
  };
  const group: ProjectSkillGroup = {
    id: "individual-skills",
    category: "individual",
    label: "Individual skills",
    locations: [],
  };
  const readArtifact = vi.fn();
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <SkillCopiesSheet
            node={node}
            group={group}
            snapshot={snapshot}
            api={{ readArtifact }}
            onEnsureGrant={async () => "grant"}
            onClose={() => undefined}
            initialTab="document"
          />
        </I18nProvider>,
      ),
    );
    expect(container.querySelector('select[aria-label="Location"]')).toBeNull();
    expect(container.querySelector(".canvas-sheet-tabs")).toBeNull();
    expect(container.textContent).toContain(".agents/skills/retained");
    expect(container.textContent).toContain("Skill tree unavailable");
    expect(readArtifact).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
