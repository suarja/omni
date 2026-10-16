// Shared fixtures for the destination views (Home, Library, Review): one registry, one audit
// report, one render helper — imported by every test file that exercises these views.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { Observation } from "../../../src/domain/project-source-registry";
import type { ObservedArtifact } from "../../../src/domain/inventory";
import type { RegistryView } from "../../../src/domain/project-source-registry";
import type { AuditSessionState } from "../../../src/renderer/audit/use-audit-session";
import type { AuditReport } from "../../../src/renderer/audit/audit-report";
import { I18nProvider } from "../../../src/renderer/i18n";

export const project = {
  ref: { kind: "project" as const, id: "project-one" },
  displayName: "Omni Project",
  displayRoot: "omni-project",
  availability: "available" as const,
};

export const personal = {
  ref: { kind: "source" as const, id: "personal-source" },
  displayName: "My Skills",
  displayRoot: "my-skills",
  availability: "available" as const,
  ownership: "personal" as const,
  capabilities: { observe: true as const, write: false as const },
};

export const external = {
  ref: { kind: "source" as const, id: "cursor-source" },
  displayName: "Cursor Plugins",
  displayRoot: "cursor-plugins",
  availability: "available" as const,
  ownership: "external" as const,
  capabilities: { observe: true as const, write: false as const },
};

export const archivedSource = {
  ...external,
  ref: { kind: "source" as const, id: "archived-source" },
  displayName: "Archived Skills",
  archivedAt: "2026-09-10T10:00:00.000Z",
};

export const inaccessibleSource = {
  ...external,
  ref: { kind: "source" as const, id: "inaccessible-source" },
  displayName: "Unavailable Source",
  availability: "inaccessible" as const,
};

export const artifact: ObservedArtifact = {
  id: "artifact-skill",
  physicalIdentity: "skills/review/SKILL.md",
  projectionPaths: ["skills/review/SKILL.md"],
  kind: "skill",
  relativePath: "skills/review/SKILL.md",
  displayPath: "skills/review/SKILL.md",
  providerIds: ["codex"],
  scope: "source",
  confidence: "exact",
  symlinkState: "none",
};

export function registry(overrides: Partial<RegistryView> = {}): RegistryView {
  return {
    revision: 8,
    projects: [project],
    sources: [personal, external, archivedSource],
    ...overrides,
  };
}

export function observation(
  subject: Observation["subject"],
  overrides: Partial<Observation["inventory"]> = {},
): Observation {
  return {
    subject,
    observedAt: "2026-09-11T10:00:00.000Z",
    inventory: {
      rootHandle: "opaque-grant",
      displayRoot: subject.id,
      observedAt: "2026-09-11T10:00:00.000Z",
      harnesses: subject.kind === "source" ? ["codex"] : ["claude-code"],
      artifacts: [],
      diagnostics: [],
      gitScopes: [],
      ...overrides,
    },
  };
}

export function report(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    observations: [observation(personal.ref, { artifacts: [artifact] })],
    findings: [],
    unavailable: [],
    ...overrides,
  };
}

export function audit(overrides: Partial<AuditSessionState> = {}): AuditSessionState {
  return {
    status: "completed",
    progress: { completed: 3, total: 3 },
    report: report(),
    error: null,
    ...overrides,
  };
}

export type Rendered = Readonly<{ container: HTMLDivElement; root: Root }>;

export function render(element: React.ReactElement, language: "en" | "fr" = "en"): Rendered {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => {
    root.render(<I18nProvider initialLanguage={language}>{element}</I18nProvider>);
  });
  return { container, root };
}
