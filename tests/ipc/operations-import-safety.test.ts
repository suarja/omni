import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import claudeMarketplaceFixture from "../fixtures/personal-marketplace/.claude-plugin/marketplace.json";
import codexMarketplaceFixture from "../fixtures/personal-marketplace/.agents/plugins/marketplace.json";
import { detectSourceLayout } from "../../src/adapters/inventory/source-layout";
import { createLocalInventoryPort } from "../../src/adapters/inventory/local-filesystem";
import { OPERATIONS_IPC_CHANNELS } from "../../src/shared/operations-ipc";
import { REGISTRY_IPC_CHANNELS } from "../../src/shared/registry-ipc";
import { parsePathsResponse } from "../../src/shared/operations-import-ipc";
import { invoke, root, setup } from "./operations-import-helpers";

describe("import artifact safety", () => {
  // Real git repositories on temp roots: generous timeout so parallel workers never flake.
  vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });
  it("blocks a symlinked file that escapes the observed root and oversized files", async () => {
    const fixture = await setup();
    const outside = await root("import-outside");
    await writeFile(join(outside, "secret.md"), "secret\n", "utf8");
    await symlink(join(outside, "secret.md"), join(fixture.source, "skills", "review", "outside.md"));
    await expect(
      invoke(OPERATIONS_IPC_CHANNELS.preview, {
        kind: "import-artifact",
        source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
        relativePath: "skills/review/SKILL.md",
        target: { packageId: "tools" },
      }),
    ).resolves.toMatchObject({ status: "blocked", reason: "artifact-unavailable" });
    await writeFile(join(fixture.source, "large.md"), Buffer.alloc(1024 * 1024 + 1));
    await expect(
      invoke(OPERATIONS_IPC_CHANNELS.preview, {
        kind: "import-artifact",
        source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
        relativePath: "large.md",
        target: { packageId: "tools" },
      }),
    ).resolves.toMatchObject({ status: "blocked", reason: "artifact-unavailable" });
  });

  it("adopts a marketplace without changing its existing harness manifest", async () => {
    const fixture = await setup({ adopt: true });
    await mkdir(join(fixture.marketplace, ".claude-plugin"), { recursive: true });
    const existingHarnessMarketplace = { name: "Claude", plugins: [{ name: "tools", source: "./packages/tools" }] };
    await writeFile(
      join(fixture.marketplace, ".claude-plugin", "marketplace.json"),
      JSON.stringify(existingHarnessMarketplace).concat("\n"),
      "utf8",
    );
    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "import-artifact",
      source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
      relativePath: "skills/review/SKILL.md",
      target: { packageId: "packages/tools" },
    })) as { plan: { planId: string } };
    expect(preview).toMatchObject({ status: "ready" });
    await expect(invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId })).resolves.toMatchObject({
      status: "applied",
    });
    expect(JSON.parse(await readFile(join(fixture.marketplace, ".claude-plugin", "marketplace.json"), "utf8"))).toEqual(
      existingHarnessMarketplace,
    );
    expect(JSON.parse(await readFile(join(fixture.marketplace, "omni.marketplace.json"), "utf8"))).toMatchObject({
      format: "omni.marketplace/1",
      packages: [{ path: "packages/tools" }],
    });
  });

  it("preserves real outside-home locations through the operation paths IPC parser", async () => {
    const fixture = await setup();
    const response = await invoke(OPERATIONS_IPC_CHANNELS.paths, {});
    expect(parsePathsResponse(response)).toEqual({
      marketplace: { displayRoot: await realpath(fixture.marketplace) },
      store: { displayRoot: join(fixture.userDataPath, "omni", "operations.json") },
    });
  });

  it("rolls back an injected write failure without leaving temporary files", async () => {
    let writes = 0;
    const fixture = await setup({
      fileWriter: async (path, content, writeOptions) => {
        writes += 1;
        if (writes === 2) throw new Error("injected failure");
        await writeFile(path, content, writeOptions);
      },
    });
    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "import-artifact",
      source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
      relativePath: "skills/review/SKILL.md",
      target: { packageId: "tools" },
    })) as { plan: { planId: string } };
    await expect(invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId })).resolves.toMatchObject({
      status: "failed",
    });
    await expect(stat(join(fixture.marketplace, "packages", "tools", "skills"))).rejects.toThrow();
  });
});
