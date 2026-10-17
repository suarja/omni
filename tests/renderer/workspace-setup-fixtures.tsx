import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

import type { ResourceSnapshot } from "../../src/domain/resource-catalogue";
import type {
  EntryRef,
  RegistryEntryView,
  RegistryView,
  SourceEntryView,
  SourceOwnership,
} from "../../src/domain/project-source-registry";
import { createResourceSnapshot } from "../../src/renderer/canvas/resource-snapshot";
import type { WorkspaceSetupInputs } from "../../src/renderer/canvas/setup/workspace-setup-types";
import { ThemeProvider } from "../../src/renderer/theme/theme-provider";
import { I18nProvider } from "../../src/renderer/i18n";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";

export function project(id: string, displayName = "Workspace project"): RegistryEntryView<"project"> {
  return {
    ref: { kind: "project", id },
    displayName,
    displayRoot: id,
    availability: "available",
  };
}

export function source(id: string, displayName: string, ownership: SourceOwnership = "personal"): SourceEntryView {
  return {
    ref: { kind: "source", id },
    displayName,
    displayRoot: id,
    availability: "available",
    ownership,
    capabilities: { observe: true, write: false },
  };
}

export function registryView(
  projects: readonly RegistryEntryView<"project">[] = [],
  sources: readonly SourceEntryView[] = [],
): RegistryView {
  return { revision: 1, projects, sources };
}

export function resourceSnapshot(
  registry: RegistryView,
  observed: readonly EntryRef[] = [],
  loading: readonly EntryRef[] = [],
): ResourceSnapshot {
  const observations = Object.fromEntries(
    observed.map((entry) => [
      key(entry),
      {
        status: "observed" as const,
        observation: {
          subject: entry,
          observedAt: "2026-10-04T12:00:00.000Z",
          inventory: {
            rootHandle: "read-grant",
            displayRoot: entry.id,
            observedAt: "2026-10-04T12:00:00.000Z",
            harnesses: [],
            artifacts: [],
            packages: [],
            diagnostics: [],
            gitScopes: [],
          },
        },
      },
    ]),
  );
  const pendingObservations = Object.fromEntries(loading.map((entry) => [key(entry), true]));
  return createResourceSnapshot({
    registry,
    observations,
    auditObservations: [],
    pendingObservations,
    uses: { status: "ready", bindings: [] },
  });
}

function key(entry: EntryRef): string {
  return `${entry.kind}:${entry.id}`;
}

export function setupInputs(overrides: Partial<WorkspaceSetupInputs> = {}): WorkspaceSetupInputs {
  const commands: WorkspaceSetupInputs["commands"] = {
    registerProject: vi.fn().mockResolvedValue({ status: "cancelled" }),
    registerSource: vi.fn().mockResolvedValue({ status: "cancelled" }),
    refreshRegistry: vi.fn().mockResolvedValue({ status: "ready", registry: registryView() }),
    observeEntry: vi.fn().mockResolvedValue(undefined),
  };
  const api = {
    inspectProject: vi.fn().mockResolvedValue({
      status: "inspected",
      grantHandle: "inspection-grant",
      displayName: "Selected project",
      displayRoot: "selected-project",
      inventory: {
        rootHandle: "inspection-grant",
        displayRoot: "selected-project",
        observedAt: "2026-10-12T00:00:00.000Z",
        harnesses: [],
        artifacts: [],
        gitScopes: [],
        diagnostics: [],
      },
    }),
    pickOperationParent: vi.fn(),
    previewOperation: vi.fn(),
    applyOperation: vi.fn(),
    getAgentStatus: vi.fn().mockResolvedValue({
      socketPath: "socket",
      tokenCreatedAt: "now",
      counts: { pending: 0, today: 0, total: 0 },
      harnesses: [],
    }),
  } as unknown as WorkspaceSetupInputs["api"];
  return {
    snapshot: resourceSnapshot(registryView()),
    api,
    commands,
    registryBusy: false,
    diagnostic: null,
    ...overrides,
  };
}

export function renderResourceCanvas(root: Root, setup: WorkspaceSetupInputs, language: "en" | "fr" = "en"): void {
  root.render(
    <ThemeProvider>
      <I18nProvider initialLanguage={language}>
        <ResourceCanvas
          api={{ ...setup.api, readArtifact: vi.fn() }}
          context={{ kind: "workspace" }}
          onEnsureGrant={vi.fn(async () => "read-grant")}
          onNavigate={vi.fn()}
          onNavigateDestination={vi.fn()}
          onRefresh={vi.fn()}
          setup={setup}
          snapshot={setup.snapshot}
        />
      </I18nProvider>
    </ThemeProvider>,
  );
}

export function createCanvasRoot(): Readonly<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  return { container, root: createRoot(container) };
}
