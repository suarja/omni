// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCanvasSession } from "../../src/renderer/canvas/spatial/canvas-session";
import { resourceNodeId } from "../../src/renderer/canvas/spatial/spatial-types";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import type { ResourceContext, ResourceSnapshot } from "../../src/domain/resource-catalogue";
import type { Route } from "../../src/renderer/navigation";
import { correlateSkillCopies } from "../../src/domain/skill-reconciliation/correlation";
import type { ObserveSkillCopiesRequest } from "../../src/shared/skill-reconciliation-ipc";
import { I18nProvider } from "../../src/renderer/i18n";
import { projectSnapshot, denseSnapshot } from "../fixtures/spatial-canvas";
import { resourceFixture } from "../fixtures/resource-catalogue";

const projectContext: ResourceContext = { kind: "entry", entry: resourceFixture.projectOneRef };
const baseKey = "entry:project:project-one";
const managedReviewGroupId = JSON.stringify(["managed", "source-one", "pstack"]);
const individualSkillsGroupId = "individual-skills";

function observedCopies(request: ObserveSkillCopiesRequest) {
  const revision = {
    algorithm: "omni-tree-v1" as const,
    hash: "a".repeat(64),
    files: ["SKILL.md", "references/note.md"].map((path) => ({ path, hash: "a".repeat(64), byteLength: 1 })),
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
        read: { status: "complete" as const, revision },
      }));
      const correlation = correlateSkillCopies({
        projectId: request.projectId,
        members,
        records: [],
        allocateId: () => `logical-${group.groupId}`,
      });
      return { groupId: group.groupId, correlation };
    }),
  };
}

function pathSnapshot(): { snapshot: ResourceSnapshot; ref: Extract<ResourceContext, { kind: "artifact" }> } {
  const template = resourceFixture.projectObservation.inventory.artifacts[0]!;
  const skill = {
    ...template,
    id: "path-skill",
    relativePath: ".agents/skills/review/SKILL.md",
    displayPath: ".agents/skills/review/SKILL.md",
    physicalIdentity: "physical-review",
    projectionPaths: [".agents/skills/review/SKILL.md", ".claude/skills/review/SKILL.md"],
  };
  const support = {
    ...skill,
    id: "path-support",
    kind: "unknown" as const,
    relativePath: ".agents/skills/review/references/note.md",
    displayPath: ".agents/skills/review/references/note.md",
    physicalIdentity: "physical-note",
    projectionPaths: [".agents/skills/review/references/note.md"],
  };
  return {
    snapshot: projectSnapshot([skill, support]),
    ref: { kind: "artifact", entry: resourceFixture.projectOneRef, artifactId: skill.id },
  };
}

describe("spatial resource navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onNavigate: ReturnType<typeof vi.fn<(route: Route) => void>>;
  let onBack: ReturnType<typeof vi.fn>;
  let session: ReturnType<typeof createCanvasSession>;
  let snapshot: ResourceSnapshot;
  let readArtifact: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    onNavigate = vi.fn<(route: Route) => void>();
    onBack = vi.fn();
    session = createCanvasSession();
    snapshot = denseSnapshot();
    readArtifact = vi
      .fn()
      .mockResolvedValue({ status: "read", content: "# Actual file", byteLength: 13, truncated: false });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => act(() => root.unmount()));

  function render(context: ResourceContext = projectContext, nextSnapshot = snapshot): void {
    act(() =>
      root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={{ readArtifact }}
            context={context}
            onBack={onBack}
            onEnsureGrant={vi.fn(async () => "grant")}
            onNavigate={onNavigate}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
            session={session}
            snapshot={nextSnapshot}
          />
        </I18nProvider>,
      ),
    );
  }

  it("opens an Individual skills group with 39 exact resource locations", () => {
    render();
    const groupButton = container.querySelector<HTMLButtonElement>('button[data-group-id="individual-skills"]');
    expect(groupButton).not.toBeNull();
    act(() => groupButton?.click());

    expect(container.querySelectorAll(".canvas-node-row")).toHaveLength(40);
    expect(
      [...container.querySelectorAll<HTMLElement>(".canvas-node-row[data-node-id]")].some(
        (row) =>
          row.dataset.nodeId ===
          resourceNodeId(
            { kind: "artifact", entry: resourceFixture.projectOneRef, artifactId: "dense-0" },
            ".agents/skills/skill-00/SKILL.md",
          ),
      ),
    ).toBe(true);
  });

  it("uses the normative 18px entity glyph and 14px information glyph", () => {
    render();
    const row = container.querySelector('.canvas-node-row[data-kind="project"]');

    expect(row?.querySelector(".canvas-node-icon svg")?.getAttribute("width")).toBe("18");
    expect(row?.querySelector(".canvas-node-info svg")?.getAttribute("width")).toBe("14");
  });

  it("marks differing copies on the skill, provenance group, project, exact wires, and accessible label", async () => {
    const fixture = pathSnapshot();
    const observe = vi.fn(async (request: ObserveSkillCopiesRequest) => {
      const response = observedCopies(request);
      return {
        ...response,
        groups: response.groups.map((group) => ({
          ...group,
          correlation: {
            ...group.correlation,
            groups: group.correlation.groups.map((logical) => ({
              ...logical,
              locations: logical.locations.map((copy, index) => ({
                ...copy,
                read:
                  copy.read.status === "complete"
                    ? {
                        ...copy.read,
                        revision: { ...copy.read.revision, hash: index === 0 ? "a".repeat(64) : "b".repeat(64) },
                      }
                    : copy.read,
              })),
              state: "copy-difference" as const,
            })),
          },
        })),
      };
    });
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={{ readArtifact, observeSkillCopies: observe }}
            context={projectContext}
            onEnsureGrant={async () => "grant"}
            onNavigate={onNavigate}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
            session={session}
            snapshot={fixture.snapshot}
          />
        </I18nProvider>,
      ),
    );
    await act(async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    expect(observe).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLElement>('.canvas-node-row[data-kind="project"]')?.dataset.attention).toBe(
      "copy-difference",
    );
    const overviewGroup = container.querySelector<HTMLElement>('.canvas-node-row[data-kind="group"]');
    expect(overviewGroup?.dataset.attention).toBe("copy-difference");
    expect(container.querySelector('.canvas-wire[data-attention="copy-difference"]')).not.toBeNull();
    act(() => overviewGroup?.querySelector<HTMLButtonElement>(".canvas-node")?.click());
    const skill = container.querySelector<HTMLElement>('.canvas-node-row[data-node-id^="logical-skill:"]');
    expect(skill?.dataset.attention).toBe("copy-difference");
    expect(skill?.querySelector(".canvas-node")?.getAttribute("aria-label")).toContain("Copies differ");
    expect(container.querySelector('.canvas-wire[data-attention="copy-difference"]')).not.toBeNull();
    expect(session.readProjectAttention("project-one")).toMatchObject({
      freshness: "fresh",
      state: "copy-difference",
    });
  });

  it.each<[string, ResourceContext]>([
    ["the current project", projectContext],
    ["Workspace", { kind: "workspace" }],
    ["another project", { kind: "entry", entry: resourceFixture.projectTwoRef }],
    ["a marketplace plugin", { kind: "package", entry: resourceFixture.sourceRef, packageId: "pstack" }],
  ])("routes the exact location selected by search from %s", (_name, context) => {
    const fixture = pathSnapshot();
    snapshot = fixture.snapshot;
    render(context);
    act(() => container.querySelector<HTMLButtonElement>(".canvas-search-trigger")?.click());
    const input = container.querySelector<HTMLInputElement>(".canvas-search-input input");
    expect(input).not.toBeNull();
    act(() => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, ".claude/skills/review/SKILL.md");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onNavigate).toHaveBeenCalledWith({
      screen: "resource-canvas",
      context: { kind: "entry", entry: resourceFixture.projectOneRef },
      initialSkillCopy: { ref: fixture.ref, relativePath: ".claude/skills/review/SKILL.md" },
    });
  });

  it("searches to one logical skill, reads the exact copy, and exposes its exact support file", async () => {
    const fixture = pathSnapshot();
    const read = vi
      .fn()
      .mockResolvedValue({ status: "read", content: "# Exact copy", byteLength: 12, truncated: false });
    const observe = vi.fn(async (request: ObserveSkillCopiesRequest) => observedCopies(request));
    const api = { readArtifact: read, observeSkillCopies: observe };
    const onEnsureGrant = vi.fn(async () => "grant");

    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={api}
            context={{ kind: "workspace" }}
            onEnsureGrant={onEnsureGrant}
            onNavigate={onNavigate}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
            snapshot={fixture.snapshot}
          />
        </I18nProvider>,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>(".canvas-search-trigger")?.click());
    const input = container.querySelector<HTMLInputElement>(".canvas-search-input input");
    act(() => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, ".claude/skills/review/SKILL.md");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    const initialSkillCopy = {
      ref: fixture.ref,
      relativePath: ".claude/skills/review/SKILL.md",
    };
    expect(onNavigate).toHaveBeenCalledWith({
      screen: "resource-canvas",
      context: projectContext,
      initialSkillCopy,
    });

    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={api}
            context={projectContext}
            initialSkillCopy={initialSkillCopy}
            onEnsureGrant={onEnsureGrant}
            onNavigate={onNavigate}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
            snapshot={fixture.snapshot}
          />
        </I18nProvider>,
      ),
    );
    await act(async () => {
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });

    expect(observe).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.canvas-node-row[data-node-id^="logical-skill:"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="skill-copies-sheet"]')).not.toBeNull();
    expect(read).toHaveBeenCalledWith({
      kind: "project",
      id: "project-one",
      grantHandle: "grant",
      relativePath: ".claude/skills/review/SKILL.md",
    });
    expect(container.textContent).toContain("Exact copy");

    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Location"]');
    const agentsMember = [...picker!.options].find((option) => option.textContent?.includes(".agents/skills/review"));
    act(() => {
      picker!.value = agentsMember!.value;
      picker!.dispatchEvent(new Event("change", { bubbles: true }));
      [...container.querySelectorAll<HTMLButtonElement>(".canvas-sheet-tabs button")]
        .find((button) => button.textContent === "Files")
        ?.click();
    });
    const support = [...container.querySelectorAll<HTMLButtonElement>(".canvas-file-list button")].find((button) =>
      button.textContent?.includes("references/note.md"),
    );
    expect(support).toBeDefined();
    await act(async () => {
      support?.click();
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
    expect(read).toHaveBeenLastCalledWith({
      kind: "project",
      id: "project-one",
      grantHandle: "grant",
      relativePath: ".agents/skills/review/references/note.md",
    });
    observe.mockImplementation(async (request) => {
      const response = observedCopies(request);
      return {
        ...response,
        groups: response.groups.map((group) => ({
          ...group,
          correlation: {
            ...group.correlation,
            groups: group.correlation.groups.map((logical) => ({
              ...logical,
              members: logical.members.map((member) =>
                member.read.status === "complete"
                  ? {
                      ...member,
                      read: {
                        ...member.read,
                        revision: {
                          ...member.read.revision,
                          files: [
                            ...member.read.revision.files,
                            { path: "references/refreshed.md", hash: "b".repeat(64), byteLength: 4 },
                          ],
                        },
                      },
                    }
                  : member,
              ),
            })),
          },
        })),
      };
    });
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={api}
            context={projectContext}
            initialSkillCopy={initialSkillCopy}
            onEnsureGrant={onEnsureGrant}
            onNavigate={onNavigate}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
            snapshot={{
              ...fixture.snapshot,
              roots: fixture.snapshot.roots.map((entry) =>
                entry.entry.id === projectContext.entry.id && entry.evidence.status === "observed"
                  ? {
                      ...entry,
                      evidence: {
                        ...entry.evidence,
                        observation: { ...entry.evidence.observation, observedAt: "2026-10-08T17:00:00.000Z" },
                      },
                    }
                  : entry,
              ),
            }}
          />
        </I18nProvider>,
      ),
    );
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>(".canvas-sheet-tabs button")]
        .find((button) => button.textContent === "Files")
        ?.click(),
    );
    expect(container.textContent).toContain("references/refreshed.md");
    const nodeInfo = container.querySelector<HTMLButtonElement>(
      '.canvas-node-row[data-node-id^="logical-skill:"] .canvas-node-info',
    );
    act(() => nodeInfo?.click());
    expect(container.querySelector('.canvas-sheet-tabs button[aria-current="page"]')?.textContent).toBe("Overview");
    expect(container.textContent).toContain("Identity evidence");
  });

  it("shows the exact selected projection in the information overview", () => {
    const fixture = pathSnapshot();
    snapshot = fixture.snapshot;
    render();
    act(() => container.querySelector<HTMLButtonElement>(`button[data-group-id='${managedReviewGroupId}']`)?.click());
    const path = ".claude/skills/review/SKILL.md";
    const row = [...container.querySelectorAll<HTMLElement>("[data-node-id]")].find(
      (candidate) => candidate.dataset.nodeId === resourceNodeId(fixture.ref, path),
    );
    act(() => row?.querySelector<HTMLButtonElement>(".canvas-node-info")?.click());

    expect(container.querySelector("[data-testid='resource-sheet']")?.textContent).toContain(path);
  });

  it("consumes Back at the group before parent history", () => {
    render();
    act(() =>
      container.querySelector<HTMLButtonElement>(`button[data-group-id='${individualSkillsGroupId}']`)?.click(),
    );
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", metaKey: true, bubbles: true })));

    expect(container.querySelector(`[data-group-id='${individualSkillsGroupId}']`)).not.toBeNull();
    expect(container.querySelectorAll(".canvas-node-row")).toHaveLength(2);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("retains the selected group while a refresh temporarily clears its inventory", () => {
    render();
    act(() => container.querySelector<HTMLButtonElement>('button[data-group-id="individual-skills"]')?.click());
    expect(session.read(baseKey)?.groupId).toBe(individualSkillsGroupId);
    render(projectContext, {
      ...snapshot,
      roots: snapshot.roots.map((root) =>
        root.entry.id === projectContext.entry.id ? { ...root, evidence: { status: "loading" as const } } : root,
      ),
    });
    expect(session.read(baseKey)?.groupId).toBe(individualSkillsGroupId);
    render();
    expect(container.querySelectorAll(".canvas-node-row")).toHaveLength(40);
  });

  it("retains group camera through a renderer remount and artifact Back", async () => {
    const viewKey = `${baseKey}:group:${individualSkillsGroupId}`;
    const camera = { x: 123, y: 234, scale: 1.2 };
    session.write(baseKey, { groupId: individualSkillsGroupId, cameras: { [viewKey]: camera } });
    render();
    expect(container.querySelector<HTMLElement>(".canvas-world")?.style.transform).toBe(
      "translate(123px, 234px) scale(1.2)",
    );

    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      render({ kind: "artifact", entry: resourceFixture.projectOneRef, artifactId: "dense-0" });
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", metaKey: true, bubbles: true }));
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(session.read(baseKey)?.groupId).toBe(individualSkillsGroupId);
  });
});
