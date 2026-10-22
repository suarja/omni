// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AppUpdateRestartControl } from "../../src/renderer/settings/AppUpdateRestartControl";
import { I18nProvider } from "../../src/renderer/i18n";
import type { AppUpdateState, AppUpdatesDesktopApi } from "../../src/shared/app-updates-ipc";

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  document.body.replaceChildren();
});
async function render(downloaded = true, language: "en" | "fr" = "en") {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  let changed: ((state: AppUpdateState) => void) | undefined;
  const api: AppUpdatesDesktopApi = {
    getAppUpdates: vi.fn(async () => ({ available: true, enabled: true, downloaded, error: false })),
    setAppUpdates: vi.fn(),
    restartForUpdate: vi.fn(async () => {}),
    onAppUpdatesChanged: (listener) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
  };
  await act(async () =>
    root!.render(
      <I18nProvider initialLanguage={language}>
        <AppUpdateRestartControl api={api} />
      </I18nProvider>,
    ),
  );
  return { node, api, emit: (state: AppUpdateState) => changed?.(state) };
}
it("keeps a primary restart control with a refresh icon and attention dot until the download is withdrawn", async () => {
  const { node, api, emit } = await render();
  const button = node.querySelector("button")!;
  expect(button.textContent).toBe("Restart to update");
  expect(button.classList.contains("is-primary")).toBe(true);
  expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(button.querySelector('.app-update-attention[aria-hidden="true"]')).not.toBeNull();
  expect(api.restartForUpdate).not.toHaveBeenCalled();
  await act(async () => emit({ available: true, enabled: false, downloaded: false, error: false }));
  expect(node.querySelector("button")).toBeNull();
});
it("shows a newly completed download in French", async () => {
  const { node, emit } = await render(false, "fr");
  expect(node.querySelector("button")).toBeNull();
  await act(async () => emit({ available: true, enabled: true, downloaded: true, error: false }));
  expect(node.querySelector("button")?.textContent).toBe("Redémarrer pour mettre à jour");
});
it("prevents duplicate restarts and keeps a failed restart visible for retry", async () => {
  const { node, api } = await render();
  let reject: (error: Error) => void = () => {};
  vi.mocked(api.restartForUpdate).mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const button = node.querySelector("button")!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(api.restartForUpdate).toHaveBeenCalledOnce();
  expect(button.disabled).toBe(true);
  await act(async () => reject(new Error("Restart failed")));
  expect(node.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  expect(button.disabled).toBe(false);
});
