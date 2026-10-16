import { expect, it, vi } from "vitest";
import { startMainWindow, activateMainWindow } from "../../src/main/startup-window";
function window() {
  return { isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
}
it("keeps the login-started window hidden and reveals it on activate", () => {
  const target = window();
  expect(startMainWindow({ wasOpenedAtLogin: true, create: () => target })).toBe(target);
  expect(target.show).not.toHaveBeenCalled();
  expect(target.focus).not.toHaveBeenCalled();
  activateMainWindow(target, () => {
    throw new Error("Should reuse window");
  });
  expect(target.show).toHaveBeenCalledOnce();
  expect(target.focus).toHaveBeenCalledOnce();
});
it("shows a normal launch and recreates a closed window on activate", () => {
  const target = window();
  startMainWindow({ wasOpenedAtLogin: false, create: () => target });
  expect(target.show).toHaveBeenCalledOnce();
  const replacement = window();
  expect(activateMainWindow({ ...target, isDestroyed: () => true }, () => replacement)).toBe(replacement);
  expect(replacement.show).toHaveBeenCalledOnce();
  expect(replacement.focus).toHaveBeenCalledOnce();
});
it("restores a minimized window before showing it", () => {
  const target = { ...window(), isMinimized: () => true };
  activateMainWindow(target, () => target);
  expect(target.restore).toHaveBeenCalledOnce();
});
