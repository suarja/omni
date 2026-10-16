// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resourceFixture, snapshot as baseSnapshot } from "../fixtures/resource-catalogue";
import type { ResourceSnapshot } from "../../src/domain/resource-catalogue";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { displayGroupLabel } from "../../src/renderer/canvas/spatial/canvas-labels";
import { resourceNodeId } from "../../src/renderer/canvas/spatial/spatial-types";
import type { Route } from "../../src/renderer/navigation";
import { I18nProvider } from "../../src/renderer/i18n";

const originPath = ".agents/skills/origin-check/SKILL.md";
const alternateOriginPath = ".claude/skills/origin-check/SKILL.md";
const individualPath = ".cursor/skills/local-only/SKILL.md";
const ambiguousPath = ".agents/skills/review/SKILL.md";
const originEvidence = {
  artifactId: "project-origin",
  relativePath: originPath,
  source: { kind: "github" as const, locator: "vercel-labs/skills" },
  sourceSkillPath: "skills/convex/SKILL.md",
  reference: "v1.2.3",
  lockPath: "skills-lock.json" as const,
  recordedHash: "a".repeat(64),
  verification: "modified" as const,
};
const assignedOriginEvidence = {
  ...originEvidence,
  artifactId: "project-skill",
  relativePath: ".claude/skills/review/SKILL.md",
};

function groupingSnapshot(): ResourceSnapshot {
  const template = resourceFixture.projectObservation.inventory.artifacts[0]!;
  const originSkill = {
    ...template,
    id: "project-origin",
    relativePath: originPath,
    displayPath: originPath,
    physicalIdentity: "project-origin",
    projectionPaths: [originPath, alternateOriginPath],
  };
  const individualSkill = {
    ...template,
    id: "project-individual",
    relativePath: individualPath,
    displayPath: individualPath,
    physicalIdentity: "project-individual",
    projectionPaths: [individualPath],
  };
  const ambiguousSkill = {
    ...template,
    id: "project-ambiguous",
    relativePath: ambiguousPath,
    displayPath: ambiguousPath,
    physicalIdentity: "project-ambiguous",
    projectionPaths: [ambiguousPath],
  };
  const projectArtifacts = [
    ...resourceFixture.projectObservation.inventory.artifacts,
    originSkill,
    individualSkill,
    ambiguousSkill,
  ];
  const conflictingBinding = {
    ...resourceFixture.bindings[0]!,
    bindingId: "binding-other-package",
    packageId: "other",
  };
  return {
    ...baseSnapshot,
    uses: { status: "ready", bindings: [...resourceFixture.bindings, conflictingBinding] },
    roots: baseSnapshot.roots.map((root) =>
      root.entry.kind === "project" && root.entry.id === resourceFixture.projectOneRef.id
        ? {
            ...root,
            evidence: {
              status: "observed" as const,
              observation: {
                ...resourceFixture.projectObservation,
                inventory: {
                  ...resourceFixture.projectObservation.inventory,
                  artifacts: projectArtifacts,
                  skillOrigins: [originEvidence, assignedOriginEvidence],
                },
              },
            },
          }
        : root,
    ),
  };
}

function nodeById(id: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(".canvas-node-row[data-node-id]")].find(
    (node) => node.dataset.nodeId === id,
  );
}

describe("canvas provenance groups", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onNavigate: ReturnType<typeof vi.fn<(route: Route) => void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    onNavigate = vi.fn<(route: Route) => void>();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => act(() => root.unmount()));

  function render(snapshot: ResourceSnapshot = groupingSnapshot(), withBack = true): void {
    act(() =>
      root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={null}
            context={{ kind: "entry", entry: resourceFixture.projectOneRef }}
            onBack={withBack ? vi.fn() : undefined}
            onEnsureGrant={vi.fn(async () => null)}
            onNavigate={onNavigate}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
            snapshot={snapshot}
          />
        </I18nProvider>,
      ),
    );
  }

  it("keeps repository labels literal while translated groups use their message key", () => {
    const translate = (key: string): string => `translated:${key}`;

    expect(displayGroupLabel({ label: "vercel-labs/skills", labelKind: "literal" }, translate)).toBe(
      "vercel-labs/skills",
    );
    expect(displayGroupLabel({ label: "canvas.groupIndividualSkills" }, translate)).toBe(
      "translated:canvas.groupIndividualSkills",
    );
  });

  it("shows semantic groups and drills into only their exact observed locations", () => {
    render();

    const originButton = container.querySelector<HTMLButtonElement>('button[data-group-category="origin"]');
    const individualButton = container.querySelector<HTMLButtonElement>('button[data-group-id="individual-skills"]');
    const managedButton = container.querySelector<HTMLButtonElement>('button[data-group-category="managed-plugin"]');
    expect(originButton?.textContent).toContain("vercel-labs/skills");
    expect(originButton?.dataset.kind).toBe("group");
    expect(originButton?.dataset.labelKind).toBe("literal");
    expect(individualButton?.textContent).toContain("Individual skills");
    expect(managedButton?.textContent).toContain("pstack");
    expect(originButton?.dataset.nodeKey).toBeUndefined();

    act(() => originButton?.click());
    expect(
      container.querySelector<HTMLElement>(
        '.canvas-node-row.is-center[data-group-category="origin"] .canvas-node-label',
      )?.textContent,
    ).toBe("vercel-labs/skills");
    const originNodeId = resourceNodeId(
      { kind: "artifact", entry: resourceFixture.projectOneRef, artifactId: "project-origin" },
      originPath,
    );
    const individualNodeId = resourceNodeId(
      { kind: "artifact", entry: resourceFixture.projectOneRef, artifactId: "project-individual" },
      individualPath,
    );
    const drilledNodeIds = [...container.querySelectorAll<HTMLElement>(".canvas-node-row[data-node-id]")].map(
      (node) => node.dataset.nodeId,
    );
    expect(drilledNodeIds).toContain(originNodeId);
    expect(drilledNodeIds).not.toContain(individualNodeId);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", metaKey: true, bubbles: true })));
    act(() => container.querySelector<HTMLButtonElement>('button[data-group-id="individual-skills"]')?.click());
    const individualNodeIds = [...container.querySelectorAll<HTMLElement>(".canvas-node-row[data-node-id]")].map(
      (node) => node.dataset.nodeId,
    );
    expect(individualNodeIds).toEqual(
      expect.arrayContaining([
        JSON.stringify([
          { kind: "artifact", entry: resourceFixture.projectOneRef, artifactId: "project-individual" },
          individualPath,
        ]),
        JSON.stringify([
          { kind: "artifact", entry: resourceFixture.projectOneRef, artifactId: "project-ambiguous" },
          ambiguousPath,
        ]),
        JSON.stringify([
          { kind: "artifact", entry: resourceFixture.projectOneRef, artifactId: "project-origin" },
          alternateOriginPath,
        ]),
      ]),
    );
    expect(individualNodeIds).toHaveLength(4);
  });

  it("shows origin evidence only for the exact selected projection", () => {
    render();
    act(() => container.querySelector<HTMLButtonElement>('button[data-group-category="origin"]')?.click());
    const originNode = nodeById(
      resourceNodeId(
        { kind: "artifact", entry: resourceFixture.projectOneRef, artifactId: "project-origin" },
        originPath,
      ),
    );
    act(() => originNode?.querySelector<HTMLButtonElement>(".canvas-node-info")?.click());
    expect(container.querySelector('[data-testid="resource-origin-details"]')?.textContent).toContain(
      "vercel-labs/skills",
    );
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="resource-sheet"] .canvas-icon-button')?.click(),
    );

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", metaKey: true, bubbles: true })));
    act(() => container.querySelector<HTMLButtonElement>('button[data-group-id="individual-skills"]')?.click());
    const alternateNode = nodeById(
      resourceNodeId(
        { kind: "artifact", entry: resourceFixture.projectOneRef, artifactId: "project-origin" },
        alternateOriginPath,
      ),
    );
    act(() => alternateNode?.querySelector<HTMLButtonElement>(".canvas-node-info")?.click());
    expect(container.querySelector('[data-testid="resource-origin-details"]')).toBeNull();
    expect(container.querySelector('[data-testid="resource-sheet"]')?.textContent).not.toContain("vercel-labs/skills");
  });

  it("opens read-only origin information without changing the current group", () => {
    render();
    const originButton = container.querySelector<HTMLButtonElement>('button[data-group-category="origin"]');
    act(() => originButton?.click());
    const info = container.querySelector<HTMLButtonElement>(
      '.canvas-node-row[data-group-category="origin"] .canvas-node-info',
    );
    act(() => info?.click());

    const sheet = container.querySelector<HTMLElement>('[data-testid="canvas-group-sheet"]');
    expect(sheet?.textContent).toContain("Declared source");
    expect(sheet?.textContent).toContain("vercel-labs/skills");
    expect(sheet?.textContent).toContain("skills/convex/SKILL.md");
    expect(sheet?.textContent).toContain(originPath);
    expect(sheet?.textContent).toContain("Locally modified");
    expect(
      container.querySelector<HTMLElement>(
        '.canvas-node-row.is-center[data-group-category="origin"] .canvas-node-label',
      )?.textContent,
    ).toBe("vercel-labs/skills");

    act(() => sheet?.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click());
    expect(
      container.querySelector<HTMLElement>(
        '.canvas-node-row.is-center[data-group-category="origin"] .canvas-node-label',
      )?.textContent,
    ).toBe("vercel-labs/skills");
  });

  it("closes group information with Back or Escape from the project overview", () => {
    render(groupingSnapshot(), false);
    const originInfo = container.querySelector<HTMLButtonElement>(
      '.canvas-node-row[data-group-category="origin"] .canvas-node-info',
    );
    act(() => originInfo?.click());

    expect(container.querySelector('[data-testid="canvas-back"]')).toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", metaKey: true, bubbles: true })));
    expect(container.querySelector('[data-testid="canvas-group-sheet"]')).toBeNull();
    expect(container.querySelector('.canvas-node-row[data-group-category="origin"]')).not.toBeNull();

    const nextOriginInfo = container.querySelector<HTMLButtonElement>(
      '.canvas-node-row[data-group-category="origin"] .canvas-node-info',
    );
    act(() => nextOriginInfo?.click());
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[data-testid="canvas-group-sheet"]')).toBeNull();
    expect(container.querySelector('.canvas-node-row[data-group-category="origin"]')).not.toBeNull();
  });

  it("exposes the real managed source package without inventing plugin refs", () => {
    render();
    const managedButton = container.querySelector<HTMLButtonElement>('button[data-group-category="managed-plugin"]');
    act(() => managedButton?.click());
    const info = container.querySelector<HTMLButtonElement>(
      '.canvas-node-row[data-group-category="managed-plugin"] .canvas-node-info',
    );
    act(() => info?.click());

    const sheet = container.querySelector<HTMLElement>('[data-testid="canvas-group-sheet"]');
    const inspectSource = sheet?.querySelector<HTMLButtonElement>('[data-testid="canvas-inspect-source"]');
    expect(sheet?.textContent).toContain("Managed plugin");
    expect(sheet?.textContent).toContain("pstack");
    expect(sheet?.textContent).toContain("Locally modified");
    expect(sheet?.textContent).toContain("The package assignment and this lockfile origin disagree.");
    expect(inspectSource?.textContent).toContain("Inspect source plugin");
    act(() => inspectSource?.click());
    expect(onNavigate).toHaveBeenCalledWith({
      screen: "resource-canvas",
      context: { kind: "package", entry: resourceFixture.sourceRef, packageId: "pstack" },
    });
  });
});
