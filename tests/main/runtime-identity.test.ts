import { describe, expect, it } from "vitest";

import { loadBuildIdentity, resolveProfilePolicy, type BuildIdentity } from "../../src/main/runtime-identity";

describe("runtime identity", () => {
  it("uses an isolated development profile by default", () => {
    expect(
      resolveProfilePolicy({
        isPackaged: false,
        homePath: "/Users/example",
        argv: [],
        env: {},
      }),
    ).toEqual({
      channel: "development",
      profilePath: "/Users/example/Library/Application Support/omni-desktop-dev",
      source: "default",
    });
  });

  it("honors the command-line profile and keeps explicit development identities visible", () => {
    expect(
      resolveProfilePolicy({
        isPackaged: false,
        homePath: "/Users/example",
        argv: ["electron", ".", "--user-data-dir", "/tmp/omni-dev"],
        env: { OMNI_USER_DATA: "/tmp/from-env" },
      }),
    ).toEqual({ channel: "development", profilePath: "/tmp/omni-dev", source: "argument" });
  });

  it("rejects explicit profiles that collide with the other build channel", () => {
    expect(() =>
      resolveProfilePolicy({
        isPackaged: false,
        homePath: "/Users/example",
        argv: ["--user-data-dir", "/Users/example/Library/Application Support/omni-desktop"],
        env: {},
      }),
    ).toThrow("reserved for the release profile");
    expect(() =>
      resolveProfilePolicy({
        isPackaged: true,
        homePath: "/Users/example",
        argv: ["--user-data-dir=/Users/example/Library/Application Support/omni-desktop-dev"],
        env: {},
      }),
    ).toThrow("reserved for the development profile");
  });

  it("requires explicit profiles to be absolute while allowing scratch paths", () => {
    expect(() =>
      resolveProfilePolicy({ isPackaged: false, argv: ["--user-data-dir", "relative/profile"], env: {} }),
    ).toThrow("must be an absolute path");
    expect(
      resolveProfilePolicy({ isPackaged: false, argv: ["--user-data-dir", "/tmp/omni-scratch"], env: {} }),
    ).toMatchObject({ profilePath: "/tmp/omni-scratch", source: "argument" });
  });

  it("does not consult process environment when an environment map is supplied", () => {
    const original = process.env.OMNI_USER_DATA;
    process.env.OMNI_USER_DATA = "/tmp/unexpected-process-profile";
    try {
      expect(resolveProfilePolicy({ isPackaged: false, homePath: "/Users/example", argv: [], env: {} }).source).toBe(
        "default",
      );
    } finally {
      if (original === undefined) delete process.env.OMNI_USER_DATA;
      else process.env.OMNI_USER_DATA = original;
    }
  });

  it("loads complete packaged metadata", async () => {
    const identity = await loadBuildIdentity({
      appRoot: "/Applications/Omni.app/Contents/Resources/app",
      isPackaged: true,
      fallbackVersion: "0.1.0",
      platform: "darwin",
      arch: "arm64",
      readBuildInfo: async () =>
        JSON.stringify({
          version: "1.2.3",
          commit: "abc123",
          channel: "release",
          builtAt: "2026-09-30T12:00:00.000Z",
          platform: "darwin",
          arch: "arm64",
          protocolVersion: "1",
          agentBundleHash: "sha256:bundle",
        }),
    });

    expect(identity).toEqual({
      version: "1.2.3",
      commit: "abc123",
      channel: "release",
      builtAt: "2026-09-30T12:00:00.000Z",
      platform: "darwin",
      arch: "arm64",
      protocolVersion: "1",
      agentBundleHash: "sha256:bundle",
    } satisfies BuildIdentity);
  });

  it("falls back to the dev version when unpackaged metadata is absent", async () => {
    await expect(
      loadBuildIdentity({
        appRoot: "/workspace",
        isPackaged: false,
        fallbackVersion: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        readBuildInfo: async () => undefined,
      }),
    ).resolves.toMatchObject({ version: "0.1.0", channel: "development", platform: "darwin", arch: "arm64" });
  });

  it("fails clearly when a packaged build has no build metadata", async () => {
    await expect(
      loadBuildIdentity({
        appRoot: "/Applications/Omni.app/Contents/Resources/app",
        isPackaged: true,
        fallbackVersion: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        readBuildInfo: async () => undefined,
      }),
    ).rejects.toThrow("Packaged Omni Desktop build is missing build-info.json");
  });
});
