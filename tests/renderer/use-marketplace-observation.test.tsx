// @vitest-environment jsdom
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ObservationResponse, RegistryViewResponse } from "../../src/shared/registry-ipc";
import type { Route } from "../../src/renderer/navigation";
import type { AuditObservation } from "../../src/renderer/audit/audit-report";
import { useMarketplaceObservation } from "../../src/renderer/operations/use-marketplace-observation";
import { resolveCanvasRoute } from "../../src/renderer/canvas-route";

const registry: RegistryViewResponse = {
  status: "ready",
  registry: {
    revision: 1,
    projects: [],
    sources: [
      {
        ref: { kind: "source", id: "personal" },
        displayName: "Personal",
        displayRoot: "/tmp/personal",
        availability: "available",
        ownership: "personal",
        capabilities: { observe: true, write: false },
      },
    ],
  },
};

const observed: ObservationResponse = {
  status: "observed",
  observation: {
    subject: { kind: "source", id: "personal" },
    observedAt: "2026-09-14T00:00:00.000Z",
    inventory: {
      rootHandle: "personal",
      displayRoot: "/tmp/personal",
      observedAt: "2026-09-14T00:00:00.000Z",
      harnesses: [],
      artifacts: [],
      packages: [],
      diagnostics: [],
      gitScopes: [],
    },
  },
};

function Probe({
  api,
  route,
}: {
  api: { openEntry: () => Promise<unknown>; observeSource: () => Promise<ObservationResponse> };
  route: Route;
}): ReactElement {
  const [observations, setObservations] = useState<Readonly<Record<string, ObservationResponse>>>({});
  const [identities, setEntryIdentities] = useState<Readonly<Record<string, AuditObservation>>>({});
  useMarketplaceObservation({
    api: api as never,
    currentAuditReport: null,
    observations,
    registry,
    route,
    setEntryIdentities,
    setObservations,
  });
  return (
    <div data-testid="observed">
      {observations["source:personal"]?.status}
      {identities["source:personal"] ? " with-identities" : ""}
    </div>
  );
}

function routeForScreen(screen: "operation-import" | "operation-import-catalogue" | "add-to-project"): Route {
  if (screen === "add-to-project")
    return {
      screen,
      ownerRepo: "owner/repo",
      skill: "quality",
      projectId: "project-one",
      returnTo: { screen: "projects" },
    };
  if (screen === "operation-import-catalogue")
    return {
      screen,
      ownerRepo: "owner/repo",
      skill: "quality",
      sourceId: "personal",
      grantHandle: "grant",
      relativePath: "skills/quality/SKILL.md",
      name: "quality",
      returnTo: { screen: "library", tab: "catalogue" },
    };
  return {
    screen,
    source: { kind: "source", id: "source" },
    relativePath: "skills/quality/SKILL.md",
    returnTo: { screen: "library", tab: "marketplaces" },
  };
}

describe("useMarketplaceObservation", () => {
  let root: Root | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    vi.restoreAllMocks();
  });

  it.each(
    (["operation-import", "operation-import-catalogue", "add-to-project"] as const).flatMap((screen) => [
      { screen, canvas: false },
      { screen, canvas: true },
    ]),
  )("observes the personal marketplace on $screen (canvas: $canvas)", async ({ screen, canvas }) => {
    const container = document.createElement("div");
    root = createRoot(container);
    document.body.append(container);
    const openEntry = vi.fn(async () => ({
      status: "granted" as const,
      entry: registry.status === "ready" ? registry.registry.sources[0]! : undefined,
      grantHandle: "grant",
    }));
    const observeSource = vi.fn(async () => observed);
    const route = routeForScreen(screen);
    act(() =>
      root?.render(<Probe api={{ openEntry, observeSource }} route={canvas ? resolveCanvasRoute(route)! : route} />),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(openEntry).toHaveBeenCalledWith({ kind: "source", id: "personal" });
    expect(observeSource).toHaveBeenCalledWith({ sourceId: "personal", grantHandle: "grant" });
    expect(container.textContent).toContain("observed");
    // The cached observation carries its identities, as the Library's own path produces them (F12).
    expect(container.textContent).toContain("with-identities");
    container.remove();
  });
});
