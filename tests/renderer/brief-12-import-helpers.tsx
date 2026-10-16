// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ObservedArtifact } from "../../src/domain/inventory";
import type { EntryRef, Observation, RegistryView } from "../../src/domain/project-source-registry";
import { I18nProvider } from "../../src/renderer/i18n";
import { rootDestination, type Route } from "../../src/renderer/navigation";
import { ImportWorkbench } from "../../src/renderer/canvas/changes/ImportWorkbench";
import { RestoreWorkbench } from "../../src/renderer/canvas/changes/RestoreWorkbench";
import { SettingsSections } from "../../src/renderer/settings/SettingsSections";
import type { DesktopApi } from "../../src/shared/ipc";
import type { OperationReceipt } from "../../src/shared/operations-ipc";

export const project = {
  ref: { kind: "project" as const, id: "project-one" },
  displayName: "Omni Project",
  displayRoot: "omni-project",
  availability: "available" as const,
};
export const personal = {
  ref: { kind: "source" as const, id: "personal-source" },
  displayName: "My marketplace",
  displayRoot: "my-marketplace",
  availability: "available" as const,
  ownership: "personal" as const,
  capabilities: { observe: true as const, write: false as const },
};
export const external = {
  ref: { kind: "source" as const, id: "external-source" },
  displayName: "Community source",
  displayRoot: "community",
  availability: "available" as const,
  ownership: "external" as const,
  capabilities: { observe: true as const, write: false as const },
};
export const source: EntryRef = external.ref;
export const artifact: ObservedArtifact = {
  id: "skill-review",
  physicalIdentity: ".agents/skills/review/SKILL.md",
  projectionPaths: [".agents/skills/review/SKILL.md", ".claude/skills/review/SKILL.md"],
  kind: "skill",
  relativePath: ".agents/skills/review/SKILL.md",
  displayPath: ".agents/skills/review/SKILL.md",
  providerIds: ["codex"],
  scope: "source",
  confidence: "exact",
  symlinkState: "none",
  summary: "Review reusable changes",
};
export const personalObservation: Observation = {
  subject: personal.ref,
  observedAt: "2026-09-13T10:00:00.000Z",
  inventory: {
    rootHandle: "personal-grant",
    displayRoot: "my-marketplace",
    observedAt: "2026-09-13T10:00:00.000Z",
    harnesses: ["codex"],
    artifacts: [
      {
        id: "claude-marketplace",
        physicalIdentity: ".claude-plugin/marketplace.json",
        projectionPaths: [".claude-plugin/marketplace.json"],
        kind: "marketplace-manifest",
        relativePath: ".claude-plugin/marketplace.json",
        displayPath: ".claude-plugin/marketplace.json",
        providerIds: ["claude-code"],
        scope: "source",
        confidence: "exact",
        symlinkState: "none",
      },
      {
        id: "codex-marketplace",
        physicalIdentity: ".agents/plugins/marketplace.json",
        projectionPaths: [".agents/plugins/marketplace.json"],
        kind: "marketplace-manifest",
        relativePath: ".agents/plugins/marketplace.json",
        displayPath: ".agents/plugins/marketplace.json",
        providerIds: ["codex"],
        scope: "source",
        confidence: "exact",
        symlinkState: "none",
      },
      {
        id: "existing",
        physicalIdentity: "packages/pstack/skills/existing/SKILL.md",
        projectionPaths: ["packages/pstack/skills/existing/SKILL.md"],
        kind: "skill",
        relativePath: "packages/pstack/skills/existing/SKILL.md",
        displayPath: "packages/pstack/skills/existing/SKILL.md",
        providerIds: ["omni"],
        scope: "source",
        confidence: "exact",
        symlinkState: "none",
        packageId: "pstack",
      },
      {
        id: "package-manifest",
        physicalIdentity: "packages/pstack/omni.plugin.json",
        projectionPaths: ["packages/pstack/omni.plugin.json"],
        kind: "plugin-manifest",
        relativePath: "packages/pstack/omni.plugin.json",
        displayPath: "packages/pstack/omni.plugin.json",
        providerIds: ["omni"],
        scope: "source",
        confidence: "exact",
        symlinkState: "none",
        packageId: "pstack",
      },
    ],
    packages: [
      {
        id: "pstack",
        relativeRoot: "packages/pstack",
        displayName: "pstack",
        format: "omni",
        manifestPaths: ["packages/pstack/omni.plugin.json"],
        artifactIds: ["existing", "package-manifest"],
      },
    ],
    marketplace: { name: "My marketplace", manifestPath: "omni.marketplace.json" },
    diagnostics: [],
    gitScopes: [],
  },
};
export const registry: RegistryView = { revision: 1, projects: [project], sources: [personal, external] };
export const returnTo: Route = {
  screen: "asset",
  artifactId: artifact.id,
  from: { kind: "library", sourceId: external.ref.id },
};

export function render(element: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => root.render(<I18nProvider>{element}</I18nProvider>));
  return { container, root };
}

export function readyPlan(overrides: Record<string, unknown> = {}) {
  return {
    status: "ready" as const,
    plan: {
      planId: "plan-import",
      kind: "import-artifact" as const,
      displayTarget: "packages/pstack",
      actions: [
        { kind: "create-directory" as const, relativePath: "packages/pstack/skills/review/references" },
        { kind: "write-file" as const, relativePath: "packages/pstack/skills/review/SKILL.md", byteLength: 42 },
        {
          kind: "write-file" as const,
          relativePath: "packages/pstack/skills/review/references/migration-patterns.md",
          byteLength: 2048,
        },
        {
          kind: "write-file" as const,
          relativePath: "packages/pstack/omni.plugin.json",
          byteLength: 210,
          manifest: true,
        },
        { kind: "write-file" as const, relativePath: "omni.marketplace.json", byteLength: 128, manifest: true },
      ],
      git: { mode: "commit" as const, warnings: [] },
      visibleIn: ["omni" as const, "claude-code" as const, "codex" as const],
      ...overrides,
    },
  };
}
