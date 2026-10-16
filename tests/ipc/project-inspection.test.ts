import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { InventoryScanRequest } from "../../src/application/inventory";

const roots: string[] = [],
  handlers = new Map<string, (event: unknown, request: unknown) => Promise<any>>();
const inspect = "omni:registry:inspect-project",
  register = "omni:registry:register-inspected-project";
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "omni-t4-inspect-"));
  roots.push(root);
  const project = join(root, "project"),
    data = join(root, "data");
  await mkdir(project);
  await mkdir(data);
  await writeFile(join(project, "CLAUDE.md"), "# Keep this file\n");
  const picker = vi.fn(async () => ({ canceled: false, filePaths: [project] }));
  vi.doMock("electron", () => ({
    app: { getPath: () => data },
    dialog: { showOpenDialog: picker },
    ipcMain: { handle: (channel: string, handler: any) => handlers.set(channel, handler) },
  }));
  const scanInventory = vi.fn(async (request: InventoryScanRequest) => ({
    rootHandle: request.rootHandle,
    displayRoot: request.displayRoot,
    observedAt: "2026-10-12T00:00:00.000Z",
    harnesses: ["claude-code"],
    artifacts: [],
    gitScopes: [],
    diagnostics: [],
  }));
  const { registerRegistryIpcHandlers } = await import("../../src/main/registry-ipc");
  registerRegistryIpcHandlers(() => undefined, { userDataPath: data, runtime: { scanInventory } as any });
  const call = (channel: string, request: unknown = {}) => {
    const handler = handlers.get(channel);
    expect(handler, `Registered handler for ${channel}`).toBeDefined();
    return handler!({}, request);
  };
  return { project, data, picker, scanInventory, call };
}
afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("electron");
  handlers.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("inspects a picker-granted project without registration or project writes, then registers the same grant", async () => {
  const { project, data, picker, scanInventory, call } = await setup();
  const result = await call(inspect);
  expect(result).toMatchObject({
    status: "inspected",
    displayName: "project",
    displayRoot: "project",
    grantHandle: expect.any(String),
    inventory: { harnesses: ["claude-code"] },
  });
  expect(scanInventory).toHaveBeenCalledWith(
    expect.objectContaining({
      approvedRoot: await realpath(project),
      rootHandle: result.grantHandle,
      scope: "project",
    }),
  );
  expect(await call("omni:registry:list")).toMatchObject({ registry: { revision: 0, projects: [] } });
  await expect(readFile(join(data, "omni/project-source-registry.json"))).rejects.toThrow();
  expect(await readFile(join(project, "CLAUDE.md"), "utf8")).toBe("# Keep this file\n");
  expect(JSON.stringify(result)).not.toContain(project);
  const added = await call(register, { grantHandle: result.grantHandle });
  expect(added).toMatchObject({ status: "ready", outcome: "created" });
  expect(picker).toHaveBeenCalledTimes(1);
  expect(await call("omni:registry:list")).toMatchObject({
    registry: { projects: [expect.objectContaining({ displayName: "project" })] },
  });
  expect(
    await call("omni:registry:observe-project", { projectId: added.entry.ref.id, grantHandle: added.grantHandle }),
  ).toMatchObject({ status: "observed" });
});
it("refuses invented grants and replaced directories before registration", async () => {
  const { project, call } = await setup();
  await expect(call(register, { grantHandle: "invented" })).rejects.toThrow(/grant/i);
  const inspected = await call(inspect);
  await rename(project, project + "-old");
  await mkdir(project);
  await expect(call(register, { grantHandle: inspected.grantHandle })).rejects.toThrow(/changed/i);
  expect(await call("omni:registry:list")).toMatchObject({ registry: { projects: [] } });
});
it("rejects renderer paths at the inspected-project registration boundary", async () => {
  const { call } = await setup();
  await expect(call(register, { grantHandle: "invented", root: "/private" })).rejects.toThrow();
});
it("rejects inspection inventory belonging to a different grant", async () => {
  const { parseProjectInspectionResponse } = await import("../../src/shared/project-inspection-ipc");
  expect(() =>
    parseProjectInspectionResponse({
      status: "inspected",
      grantHandle: "picked-grant",
      displayName: "project",
      displayRoot: "project",
      inventory: {
        rootHandle: "another-grant",
        displayRoot: "project",
        observedAt: "2026-10-12T00:00:00.000Z",
        harnesses: [],
        artifacts: [],
        diagnostics: [],
        gitScopes: [],
      },
    }),
  ).toThrow(/grant/i);
});
