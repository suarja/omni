// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoginItemRow } from "../../src/renderer/settings/LoginItemRow";
import { I18nProvider } from "../../src/renderer/i18n";
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
async function render(api: Parameters<typeof LoginItemRow>[0]["api"]): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider>
        <LoginItemRow api={api} />
      </I18nProvider>,
    );
  });
}
it("shows the OS state and uses the returned state after a toggle", async () => {
  const getLoginItem = vi.fn(async () => ({ available: true, openAtLogin: false, status: "not-registered" }));
  const setLoginItem = vi.fn(async () => ({ available: true, openAtLogin: false, status: "requires-approval" }));
  await render({ getLoginItem, setLoginItem });
  const toggle = container.querySelector<HTMLButtonElement>("[role=switch]")!;
  expect(toggle.getAttribute("aria-label")).toBe("Open Omni at login");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await act(async () => toggle.click());
  expect(setLoginItem).toHaveBeenCalledExactlyOnceWith({ openAtLogin: true });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).toContain("System Settings");
});
it("refreshes after returning from System Settings", async () => {
  const getLoginItem = vi
    .fn()
    .mockResolvedValueOnce({ available: true, openAtLogin: true, status: "enabled" })
    .mockResolvedValue({ available: true, openAtLogin: false, status: "not-registered" });
  await render({ getLoginItem });
  expect(container.querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe("true");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe("false");
});
it("disables unsupported runs and reports read failures without claiming a state", async () => {
  await render({ getLoginItem: async () => ({ available: false, openAtLogin: false, status: "unavailable" }) });
  expect(container.querySelector<HTMLButtonElement>("[role=switch]")?.disabled).toBe(true);
  await render({
    getLoginItem: async () => {
      throw new Error("Read failed");
    },
  });
  expect(container.querySelector("[role=alert]")).not.toBeNull();
  expect(container.querySelector<HTMLButtonElement>("[role=switch]")?.disabled).toBe(true);
});
it("keeps the observed state and reports a failed toggle", async () => {
  await render({
    getLoginItem: async () => ({ available: true, openAtLogin: true, status: "enabled" }),
    setLoginItem: async () => {
      throw new Error("OS refused");
    },
  });
  await act(async () => container.querySelector<HTMLButtonElement>("[role=switch]")!.click());
  expect(container.querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector("[role=alert]")).not.toBeNull();
});
