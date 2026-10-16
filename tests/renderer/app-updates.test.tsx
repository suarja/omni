// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppUpdateRow, AppUpdateNotification } from "../../src/renderer/settings/AppUpdateRow";
import { CanvasToastProvider, useCanvasToast } from "../../src/renderer/canvas/CanvasToast";
import { I18nProvider } from "../../src/renderer/i18n";
import type { AppUpdatesDesktopApi, AppUpdateState } from "../../src/shared/app-updates-ipc";

const initial = { available: true, enabled: true, downloaded: false, error: false };
let clean: (() => void) | undefined;
let storageDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  storageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      clear: () => values.clear(),
    },
  });
});
afterEach(() => {
  clean?.();
  document.body.replaceChildren();
  window.localStorage.clear();
  if (storageDescriptor) Object.defineProperty(window, "localStorage", storageDescriptor);
  vi.restoreAllMocks();
});
async function render(language = "en", downloaded = false) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.setItem("omni.language", language);
  const listeners = new Set<(state: AppUpdateState) => void>();
  const api: AppUpdatesDesktopApi = {
    getAppUpdates: vi.fn(async () => ({ ...initial, downloaded })),
    setAppUpdates: vi.fn(async ({ enabled }) => {
      const next = { ...initial, enabled };
      for (const listener of listeners) listener(next);
      return next;
    }),
    restartForUpdate: vi.fn(async () => {}),
    onAppUpdatesChanged: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <I18nProvider>
        <CanvasToastProvider>
          <div className="resource-canvas">
            <OtherToastButton />
            <AppUpdateRow api={api} />
            <AppUpdateNotification api={api} />
          </div>
        </CanvasToastProvider>
      </I18nProvider>,
    ),
  );
  clean = () => act(() => root.unmount());
  return {
    node,
    api,
    emit: (state: AppUpdateState) => {
      for (const listener of listeners) listener(state);
    },
  };
}
it("defaults automatic installation on and saves an explicit opt-out", async () => {
  const { node, api } = await render();
  const button = node.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(button.getAttribute("aria-label")).toBe("Install updates automatically");
  expect(button.getAttribute("aria-checked")).toBe("true");
  await act(async () => button.click());
  expect(api.setAppUpdates).toHaveBeenCalledWith({ enabled: false });
  expect(button.getAttribute("aria-checked")).toBe("false");
});
it("shows the existing quiet toast and restarts only after its action is clicked", async () => {
  const { node, api, emit } = await render();
  await act(async () => emit({ ...initial, downloaded: true }));
  const button = [...node.querySelectorAll("button")].find((item) => item.textContent === "Restart to update")!;
  expect(button).toBeDefined();
  expect(api.restartForUpdate).not.toHaveBeenCalled();
  await act(async () => button.click());
  expect(api.restartForUpdate).toHaveBeenCalledOnce();
});
it("replays a completed download after mounting and translates its controls into French", async () => {
  const { node } = await render("fr", true);
  expect(node.textContent).toContain("Installer les mises à jour automatiquement");
  expect(node.textContent).toContain("Redémarrer pour mettre à jour");
});
it("dismisses a withdrawn update without leaving a restart action behind", async () => {
  const { node, emit } = await render("en", true);
  expect(node.textContent).toContain("An Omni update is ready.");
  await act(async () => emit({ ...initial, enabled: false, downloaded: false }));
  expect(node.textContent).not.toContain("An Omni update is ready.");
});

function OtherToastButton() {
  const toast = useCanvasToast();
  return (
    <button type="button" onClick={() => toast.show({ message: "Another operation completed." })}>
      Other result
    </button>
  );
}
it("preserves another operation's notification when app updates are turned off", async () => {
  const { node, emit } = await render("en", true);
  await act(async () =>
    [...node.querySelectorAll("button")].find((button) => button.textContent === "Other result")!.click(),
  );
  await act(async () => emit({ ...initial, enabled: false, downloaded: false }));
  expect(node.textContent).toContain("Another operation completed.");
});
