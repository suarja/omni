import { expect, it, vi } from "vitest";
import { showAgentRequestWindow } from "../../src/main/agent-gateway/request-window";

function window(loading = false) {
  return {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { isLoading: () => loading, once: vi.fn() },
  };
}
it("restores, shows and focuses the window before opening the request", () => {
  const target = window();
  const create = vi.fn();
  const open = vi.fn();
  expect(showAgentRequestWindow(target, create, open)).toBe(target);
  expect(target.restore).toHaveBeenCalledOnce();
  expect(target.show).toHaveBeenCalledOnce();
  expect(target.focus).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(target);
  expect(create).not.toHaveBeenCalled();
});
it("recreates a closed window and waits for the renderer before sending the request", () => {
  const target = window(true);
  const open = vi.fn();
  const create = vi.fn(() => target);
  showAgentRequestWindow(undefined, create, open);
  expect(create).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  expect(target.webContents.once).toHaveBeenCalledWith("did-finish-load", expect.any(Function));
  target.webContents.once.mock.calls[0]![1]();
  expect(open).toHaveBeenCalledWith(target);
});

it("waits for the first load of a newly created window even before loading starts", () => {
  const target = window(false);
  const open = vi.fn();
  showAgentRequestWindow(undefined, () => target, open);
  expect(open).not.toHaveBeenCalled();
  target.webContents.once.mock.calls[0]![1]();
  expect(open).toHaveBeenCalledWith(target);
});
