import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  desktopManifestPath,
  ensureOmniMcpRuntime,
  userMcpRuntimePath,
  writeDesktopManifest,
} from "../../src/main/omni-mcp-runtime";
import type { BuildIdentity } from "../../src/main/runtime-identity";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Omni MCP runtime", () => {
  it("materializes the bundled runtime at a stable user-data path", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-mcp-runtime-"));
    roots.push(root);
    const sourcePath = join(root, "source", "omni-mcp.mjs");
    const userDataPath = join(root, "user-data");
    await mkdir(join(root, "source"), { recursive: true });
    await writeFile(sourcePath, "portable-runtime-v1\n");

    const materialized = await ensureOmniMcpRuntime({ userDataPath, sourcePath });

    expect(materialized).toBe(userMcpRuntimePath(userDataPath));
    await expect(readFile(materialized!, "utf8")).resolves.toBe("portable-runtime-v1\n");
  });

  it("does not claim a runtime when the Desktop resource is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-mcp-runtime-"));
    roots.push(root);

    await expect(
      ensureOmniMcpRuntime({ userDataPath: join(root, "user-data"), sourcePath: join(root, "missing.mjs") }),
    ).resolves.toBeUndefined();
  });

  it("writes a non-secret installation marker for read-only bootstrap detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-mcp-runtime-"));
    roots.push(root);
    const userDataPath = join(root, "user-data");

    await expect(
      writeDesktopManifest({ userDataPath, version: "1.2.3", runtimePath: "/tmp/omni-mcp.mjs" }),
    ).resolves.toBe(desktopManifestPath(userDataPath));
    const manifest = JSON.parse(await readFile(desktopManifestPath(userDataPath), "utf8")) as Record<string, unknown>;
    expect(manifest).toEqual({
      name: "Omni Desktop",
      version: "1.2.3",
      runtimePath: "/tmp/omni-mcp.mjs",
      startedAt: expect.any(String),
    });
  });

  it("includes build identity and executable/profile paths when supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-mcp-runtime-"));
    roots.push(root);
    const build: BuildIdentity = {
      version: "1.2.3",
      commit: "abc123",
      channel: "release",
      builtAt: "2026-09-30T12:00:00.000Z",
      platform: "darwin",
      arch: "arm64",
      protocolVersion: "1",
      agentBundleHash: "sha256:bundle",
    };

    await writeDesktopManifest({
      userDataPath: root,
      version: build.version,
      build,
      profilePath: "/Users/example/Library/Application Support/omni-desktop",
      appPath: "/Applications/Omni Desktop.app/Contents/Resources/app",
      startedAt: build.builtAt,
    });

    expect(JSON.parse(await readFile(desktopManifestPath(root), "utf8"))).toMatchObject({
      name: "Omni Desktop",
      version: "1.2.3",
      build,
      profilePath: "/Users/example/Library/Application Support/omni-desktop",
      appPath: "/Applications/Omni Desktop.app/Contents/Resources/app",
    });
  });
});
