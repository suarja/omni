// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Observation, RegistryView, SourceEntryView } from "../../src/domain/project-source-registry";
import type { ObservedPackage } from "../../src/domain/inventory";
import type { ReadArtifactResponse } from "../../src/shared/artifact-ipc";
import type { DesktopApi } from "../../src/shared/ipc";
import type { OperationReceipt } from "../../src/shared/operations-ipc";
import { I18nProvider, t } from "../../src/renderer/i18n";
import { AgentActivityOverview } from "../../src/renderer/activity/AgentActivityOverview";
import { FeaturesProvider } from "../../src/renderer/features";
import { DEFAULT_FEATURES } from "../../src/shared/settings-ipc";

const activityAgentsFeatures = {
  features: { ...DEFAULT_FEATURES, activityAgents: true },
  setFeatures: () => undefined,
};

function render(element: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() =>
    root.render(
      <I18nProvider initialLanguage="en">
        <FeaturesProvider value={activityAgentsFeatures}>{element}</FeaturesProvider>
      </I18nProvider>,
    ),
  );
  return { container, root };
}

function deferred<Value>(): Readonly<{ promise: Promise<Value>; resolve: (value: Value) => void }> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("loading rows resolve to real content, never to premature empty copy (D2)", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    vi.restoreAllMocks();
  });

  it("Activity overview: a fake getActivitySnapshot resolving later never shows a false zero", async () => {
    const pending = deferred<{ status: "ready"; snapshot: Parameters<typeof Object>[0] }>();
    const api = { getActivitySnapshot: vi.fn(() => pending.promise) } as unknown as DesktopApi;
    rendered = render(<AgentActivityOverview api={api} />);

    const meta = () => rendered?.container.querySelector("[data-testid='activity-tile-agents'] .activity-tile__meta");
    expect(meta()?.textContent).toBe(t("activity.loading"));

    await act(async () => {
      pending.resolve({
        status: "ready",
        snapshot: { sessions: [], processes: [], worktrees: [], platformSupported: true },
      });
      await pending.promise;
    });
    expect(meta()?.textContent).not.toBe(t("activity.loading"));
    expect(meta()?.textContent).toContain("0");
  });
});
