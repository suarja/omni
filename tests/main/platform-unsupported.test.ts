import { describe, expect, it } from "vitest";

import { createUnsupportedPlatform } from "../../src/main/platform/unsupported";
import { PlatformUnsupportedError } from "../../src/main/platform/platform";

describe("unsupported platform: honest reads", () => {
  it("reports the requested id and that it is not supported", () => {
    expect(createUnsupportedPlatform("linux").id).toBe("linux");
    expect(createUnsupportedPlatform("linux").supported).toBe(false);
    expect(createUnsupportedPlatform("win32").id).toBe("win32");
  });

  it("lists no processes and finds no working directories, without throwing", async () => {
    const platform = createUnsupportedPlatform("linux");
    await expect(platform.processes.list()).resolves.toEqual([]);
    await expect(platform.processes.workingDirectories([1, 2, 3])).resolves.toEqual(new Map());
  });

  it("reports every pid as not alive", () => {
    const platform = createUnsupportedPlatform("linux");
    expect(platform.processes.isAlive(1)).toBe(false);
    expect(platform.processes.isAlive(999_999)).toBe(false);
  });
});

describe("unsupported platform: honest errors", () => {
  it("throws PlatformUnsupportedError instead of silently no-opping a stop", async () => {
    const platform = createUnsupportedPlatform("linux");
    await expect(platform.processes.signal(1, "stop")).rejects.toBeInstanceOf(PlatformUnsupportedError);
    await expect(platform.processes.signal(1, "stop")).rejects.toMatchObject({
      code: "platform-unsupported",
      message: expect.stringContaining("not available on this platform"),
    });
  });

  it("throws PlatformUnsupportedError instead of silently no-opping opening a terminal", async () => {
    const platform = createUnsupportedPlatform("win32");
    await expect(platform.terminal.open("/tmp")).rejects.toBeInstanceOf(PlatformUnsupportedError);
  });
});

describe("unsupported platform: gateway", () => {
  it("computes a file-path endpoint for linux, matching the darwin rule", () => {
    const platform = createUnsupportedPlatform("linux");
    expect(platform.gateway.endpoint("/home/example/.config/omni-desktop")).toBe(
      "/home/example/.config/omni-desktop/omni/agent.sock",
    );
  });

  it("computes a named-pipe endpoint for win32 instead of a file path", () => {
    const platform = createUnsupportedPlatform("win32");
    const endpoint = platform.gateway.endpoint("C:\\Users\\example\\AppData\\Roaming\\omni-desktop");
    expect(endpoint.startsWith("\\\\.\\pipe\\omni-")).toBe(true);
    // Deterministic: the same user data path always names the same pipe.
    expect(platform.gateway.endpoint("C:\\Users\\example\\AppData\\Roaming\\omni-desktop")).toBe(endpoint);
  });

  it("secures without touching the filesystem, since nothing is ever bound", async () => {
    const platform = createUnsupportedPlatform("linux");
    await expect(platform.gateway.secure("/does/not/exist")).resolves.toBeUndefined();
  });
});
