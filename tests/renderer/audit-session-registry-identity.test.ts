// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { Observation, RegistryView } from "../../src/domain/project-source-registry";
import { useAuditSession, type AuditSession } from "../../src/renderer/audit/use-audit-session";
import type { DesktopApi } from "../../src/shared/ipc";
import { I18nProvider } from "../../src/renderer/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = {
  ref: { kind: "project" as const, id: "project-one" },
  displayName: "Project",
  displayRoot: "project",
  availability: "available" as const,
};
const registry: RegistryView = { revision: 4, projects: [project], sources: [] };

function observation(subject: Observation["subject"]): Observation {
  return {
    subject,
    observedAt: "2026-09-11T10:00:00.000Z",
    inventory: {
      rootHandle: "opaque-grant",
      displayRoot: subject.id,
      observedAt: "2026-09-11T10:00:00.000Z",
      harnesses: [],
      artifacts: [],
      diagnostics: [],
      gitScopes: [],
    },
  };
}

function apiFor(): DesktopApi {
  return {
    listRegistry: vi.fn(),
    registerProject: vi.fn(),
    registerSource: vi.fn(),
    openEntry: vi.fn(),
    observeProject: vi.fn().mockResolvedValue({ status: "observed", observation: observation(project.ref) }),
    observeSource: vi.fn(),
    archiveEntry: vi.fn(),
    reactivateEntry: vi.fn(),
  };
}

function InnerHarness({
  api,
  registryResponse,
  onSession,
}: Readonly<{
  api: DesktopApi;
  registryResponse: { status: "ready"; registry: RegistryView };
  onSession: (session: AuditSession) => void;
}>): null {
  onSession(useAuditSession({ api, registry: registryResponse }));
  return null;
}

function Harness(
  props: Readonly<{
    api: DesktopApi;
    registryResponse: { status: "ready"; registry: RegistryView };
    onSession: (session: AuditSession) => void;
  }>,
): ReactElement {
  return createElement(I18nProvider, { initialLanguage: "en", children: createElement(InnerHarness, props) });
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("audit session registry identity", () => {
  it("invalidates the raw hook on an equivalent new registry object", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = apiFor();
    const openEntry = vi.fn().mockImplementation(async () => {
      await pending;
      return { status: "granted" as const, entry: project, grantHandle: "stale-grant" };
    });
    api.openEntry = openEntry;
    const firstRegistry = { status: "ready" as const, registry };
    const equivalentRegistry = {
      status: "ready" as const,
      registry: {
        ...firstRegistry.registry,
        projects: firstRegistry.registry.projects.map((entry) => ({ ...entry, ref: { ...entry.ref } })),
        sources: [],
      },
    };
    const container = document.createElement("div");
    const root: Root = createRoot(container);
    let latestSession: AuditSession | undefined;
    const onSession = (session: AuditSession): void => {
      latestSession = session;
    };
    act(() => root.render(createElement(Harness, { api, registryResponse: firstRegistry, onSession })));
    act(() => latestSession?.start());
    await flushEffects();

    act(() => root.render(createElement(Harness, { api, registryResponse: equivalentRegistry, onSession })));
    expect(equivalentRegistry).not.toBe(firstRegistry);
    expect(equivalentRegistry.registry).not.toBe(firstRegistry.registry);
    expect(equivalentRegistry.registry.projects).not.toBe(firstRegistry.registry.projects);
    expect(equivalentRegistry.registry.projects[0]).not.toBe(firstRegistry.registry.projects[0]);
    expect(latestSession?.status).toBe("cancelled");
    release();
    await flushEffects();
    expect(latestSession?.report).toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});
