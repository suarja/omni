import { afterEach, expect, it, vi } from "vitest";
import { isDefaultWakeProfile, probeDesktopSocket } from "../../packages/omni-mcp/src/desktop-wake-adapter";
afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:child_process");
});
it("allows the standard profile named by normal MCP registration but rejects every alternate target", () => {
  expect(isDefaultWakeProfile({ target: "/home/example", standard: "/home/example" })).toBe(true);
  expect(
    isDefaultWakeProfile({ target: "/home/example", standard: "/home/example", environment: "/home/example" }),
  ).toBe(true);
  expect(isDefaultWakeProfile({ target: "/tmp/smoke", standard: "/home/example" })).toBe(false);
  expect(isDefaultWakeProfile({ target: "/home/example", standard: "/home/example", environment: "/tmp/smoke" })).toBe(
    false,
  );
});
it("uses macOS open with background argv and never invokes a shell", async () => {
  const execFile = vi.fn((_command, _args, _options, callback) => {
    callback(null);
  });
  vi.doMock("node:child_process", () => ({ execFile }));
  const { launchDesktopInBackground: launch } = await import("../../packages/omni-mcp/src/desktop-wake-adapter");
  const signal = new AbortController().signal;
  await launch("/Applications/Omni.app", signal);
  expect(execFile).toHaveBeenCalledExactlyOnceWith(
    "open",
    ["-g", "-a", "/Applications/Omni.app"],
    { signal, timeout: 20_000 },
    expect.any(Function),
  );
});
it("reports a missing socket without launching anything", async () => {
  expect(await probeDesktopSocket("/private/tmp/omni-f2-missing-socket", new AbortController().signal)).toBe(false);
});
