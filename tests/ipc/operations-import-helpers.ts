import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import claudeMarketplaceFixture from "../fixtures/personal-marketplace/.claude-plugin/marketplace.json";
import codexMarketplaceFixture from "../fixtures/personal-marketplace/.agents/plugins/marketplace.json";
import { detectSourceLayout } from "../../src/adapters/inventory/source-layout";
import { createLocalInventoryPort } from "../../src/adapters/inventory/local-filesystem";
import { OPERATIONS_IPC_CHANNELS } from "../../src/shared/operations-ipc";
import { REGISTRY_IPC_CHANNELS } from "../../src/shared/registry-ipc";

// Real git repositories on temp roots: generous timeout so parallel workers never flake.
vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;
export const handlers = new Map<string, Handler>();
const roots: string[] = [];
let showOpenDialog: ReturnType<typeof vi.fn>;

export async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `omni-${prefix}-`));
  roots.push(path);
  return path;
}

export async function setup(
  options: {
    adopt?: boolean;
    singleFile?: boolean;
    fileWriter?: (
      path: string,
      content: string | Uint8Array,
      options: { encoding: "utf8"; mode: number },
    ) => Promise<void>;
  } = {},
): Promise<{ source: string; marketplace: string; userDataPath: string; sourceId: string; grantHandle: string }> {
  const userDataPath = await root("import-data");
  const source = await root("import-source");
  const marketplace = await root("import-marketplace");
  await mkdir(join(source, "skills", "review", ...(options.singleFile ? [] : ["references"])), { recursive: true });
  await writeFile(join(source, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
  if (!options.singleFile)
    await writeFile(join(source, "skills", "review", "references", "notes.md"), "Notes\n", "utf8");
  await mkdir(join(marketplace, "packages", "tools"), { recursive: true });
  if (!options.adopt)
    await writeFile(
      join(marketplace, "omni.marketplace.json"),
      `${JSON.stringify({ format: "omni.marketplace/1", id: "personal", name: "Personal", createdAt: "2026-09-13T00:00:00.000Z", packages: [{ path: "packages/tools" }], createdBy: "test" }, null, 2)}\n`,
      "utf8",
    );
  await writeFile(
    join(marketplace, "packages", "tools", "omni.plugin.json"),
    `${JSON.stringify({ format: "omni.plugin/1", id: "tools", name: "Tools", version: "0.1.0", artifacts: [] }, null, 2)}\n`,
    "utf8",
  );
  execFileSync("git", ["init", "-q", marketplace]);
  execFileSync("git", ["-C", marketplace, "add", "--", "."]);
  execFileSync("git", [
    "-C",
    marketplace,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@local",
    "commit",
    "-q",
    "-m",
    "Initial marketplace",
  ]);

  showOpenDialog = vi
    .fn()
    .mockResolvedValueOnce({ canceled: false, filePaths: [source] })
    .mockResolvedValueOnce({ canceled: false, filePaths: [marketplace] });
  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => userDataPath) },
    dialog: { showOpenDialog },
    ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  }));
  const registry = await import("../../src/main/registry-ipc");
  const services = registry.registerRegistryIpcHandlers(() => undefined, { userDataPath });
  const external = (await handlers.get(REGISTRY_IPC_CHANNELS.registerSource)!({}, { ownership: "external" })) as {
    entry: { ref: { id: string } };
    grantHandle: string;
  };
  const personal = await handlers.get(REGISTRY_IPC_CHANNELS.registerSource)!({}, { ownership: "personal" });
  expect(personal).toMatchObject({ status: "ready" });
  const operations = await import("../../src/main/operations-ipc");
  operations.registerOperationsIpcHandlers(() => undefined, services, {
    userDataPath,
    ...(options.fileWriter ? { fileWriter: options.fileWriter } : {}),
  });
  return { source, marketplace, userDataPath, sourceId: external.entry.ref.id, grantHandle: external.grantHandle };
}

export function invoke(channel: string, request: unknown = {}): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}.`);
  return handler({}, request);
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("electron");
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
