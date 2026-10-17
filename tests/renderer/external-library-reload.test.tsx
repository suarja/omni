// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanvasRailProvider, useCanvasRail } from "../../src/renderer/canvas/rail/rail-context";
import { I18nProvider } from "../../src/renderer/i18n";
import { createFixture, click } from "./external-library-fixture";
import { projectSnapshot } from "./project-view-fixture";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));
function Controls(): ReactElement {
  const rail = useCanvasRail()!;
  return (
    <>
      <button onClick={() => void rail.externalLibrary.reload()}>Reload</button>
      <button onClick={() => void rail.externalLibrary.check()}>Check</button>
      <span>{rail.externalLibrary.list?.diagnostics.map((item) => item.message).join(",")}</span>
    </>
  );
}

it("serializes an unfinished library read and coalesces later revisions into one fresh read", async () => {
  const fixture = createFixture();
  const initial = await fixture.api.listExternalSources();
  fixture.api.listExternalSources.mockClear();
  const pending: Array<(value: typeof initial) => void> = [];
  fixture.api.listExternalSources.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const listeners = new Set<() => void>();
  const api = {
    ...fixture.api,
    onReviewChanged: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage="en">
        <CanvasRailProvider
          canvas={{
            api,
            snapshot: projectSnapshot,
            context: { kind: "workspace" },
            onEnsureGrant: vi.fn(async () => "grant"),
            onRefresh: vi.fn(),
            onNavigate: vi.fn(),
            onNavigateDestination: vi.fn(),
          }}
        >
          <Controls />
        </CanvasRailProvider>
      </I18nProvider>,
    ),
  );
  expect(api.listExternalSources).toHaveBeenCalledTimes(1);
  await click(container, "Reload");
  await act(async () => {
    listeners.forEach((listener) => listener());
  });
  await click(container, "Reload");
  await act(async () => {
    listeners.forEach((listener) => listener());
  });
  expect(api.listExternalSources).toHaveBeenCalledTimes(1);
  await act(async () => pending.shift()!(initial));
  expect(api.listExternalSources).toHaveBeenCalledTimes(2);
  await act(async () =>
    pending.shift()!({ ...initial, diagnostics: [{ type: "offline", message: "Latest revision" }] }),
  );
  expect(container.textContent).toContain("Latest revision");
  expect(api.readExternalSource).toHaveBeenCalledTimes(4);
  expect(api.listExternalSourcesOnMac).toHaveBeenCalledTimes(2);
  expect(api.getSettings).toHaveBeenCalledTimes(3);
});

it("refreshes after a finished check and after a review event", async () => {
  const fixture = createFixture();
  const listeners = new Set<() => void>();
  const api = {
    ...fixture.api,
    onReviewChanged: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage="en">
        <CanvasRailProvider
          canvas={{
            api,
            snapshot: projectSnapshot,
            context: { kind: "workspace" },
            onEnsureGrant: vi.fn(async () => "grant"),
            onRefresh: vi.fn(),
            onNavigate: vi.fn(),
            onNavigateDestination: vi.fn(),
          }}
        >
          <Controls />
        </CanvasRailProvider>
      </I18nProvider>,
    ),
  );
  expect(api.listExternalSources).toHaveBeenCalledTimes(1);
  await click(container, "Check");
  expect(api.checkExternalLibrary).toHaveBeenCalledTimes(1);
  expect(api.listExternalSources).toHaveBeenCalledTimes(2);
  await act(async () => listeners.forEach((listener) => listener()));
  expect(api.listExternalSources).toHaveBeenCalledTimes(3);
});
