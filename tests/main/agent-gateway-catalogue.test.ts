import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentClient, AgentRouter } from "../../src/main/agent-gateway/server";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;

const roots: string[] = [];
const FIXTURES_ROOT = join(import.meta.dirname, "../fixtures/stack");
const SNAPSHOT_FIXTURE = join(import.meta.dirname, "../fixtures/catalogue/agent-gateway-snapshot.json");
const CLIENT: AgentClient = { name: "test", version: "1" };

async function createRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `omni-${prefix}-`));
  roots.push(path);
  return path;
}

/**
 * Builds the real agent router (`createAgentRouter`, with the real registry underneath) against
 * a temp app root that carries the Claude-only `example-web` fixture as a registered project and
 * a fixture catalogue snapshot at `packages/omni-catalogue/catalogue.json` — no network, no
 * scraping, exactly the shape `pnpm --filter @omni/catalogue build` would have produced.
 */
async function buildRouter(): Promise<{ router: AgentRouter; projectId: string; userDataPath: string }> {
  vi.resetModules();
  const userDataPath = await createRoot("catalogue-data");
  const appRoot = await createRoot("catalogue-app");
  const projectRoot = await createRoot("catalogue-project");
  await cp(join(FIXTURES_ROOT, "example-web"), projectRoot, { recursive: true });
  await mkdir(join(appRoot, "packages", "omni-catalogue"), { recursive: true });
  await cp(SNAPSHOT_FIXTURE, join(appRoot, "packages", "omni-catalogue", "catalogue.json"));

  const handlers = new Map<string, Handler>();
  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => userDataPath), getVersion: vi.fn(() => "0.0.0"), isPackaged: false },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [projectRoot] })) },
    ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  }));

  const { registerRegistryIpcHandlers } = await import("../../src/main/registry-ipc");
  const registry = registerRegistryIpcHandlers(() => undefined, { userDataPath });
  const registered = (await handlers.get("omni:registry:register-project")?.({}, {})) as {
    entry: { ref: { id: string } };
  };
  const projectId = registered.entry.ref.id;

  const { createAgentRouter } = await import("../../src/main/agent-gateway/router");
  const requests = createAgentRequestsStore(join(userDataPath, "omni", "agent-requests.json"));
  const router = createAgentRouter({
    userDataPath,
    appVersion: "1.0.0",
    registry,
    operations: {} as never,
    bindings: {} as never,
    requests,
    catalogue: { resourceOptions: { appPath: appRoot, isPackaged: false } },
  });
  return { router, projectId, userDataPath };
}

afterEach(async () => {
  vi.doUnmock("electron");
  vi.resetModules();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("agent gateway catalogue methods", () => {
  it("stack_profile reads the real, cached stack profile for a registered project", async () => {
    const { router, projectId } = await buildRouter();

    const response = (await router.handle("stack_profile", { projectId }, CLIENT)) as {
      status: string;
      profile?: { tags: readonly { id: string }[]; harnesses: readonly string[] };
    };

    expect(response.status).toBe("ready");
    expect(response.profile?.tags.map((tag) => tag.id)).toEqual(expect.arrayContaining(["next", "convex", "clerk"]));
    expect(response.profile?.harnesses).toEqual(["claude-code"]);
  });

  it("catalog_search ranks the fixture snapshot by the project's profile and respects the limit bound", async () => {
    const { router, projectId } = await buildRouter();
    // Compute the profile once so it is cached for catalog_search to read.
    await router.handle("stack_profile", { projectId }, CLIENT);

    const response = (await router.handle("catalog_search", { projectId, limit: 1 }, CLIENT)) as {
      status: string;
      results: readonly { name: string; tags: readonly string[] }[];
    };
    expect(response.status).toBe("ready");
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.name).toBe("next-helper");

    await expect(router.handle("catalog_search", { limit: 51 }, CLIENT)).rejects.toThrow();
  });

  it("suggest returns the ranked list with why and alreadyInProject", async () => {
    const { router, projectId } = await buildRouter();
    await router.handle("stack_profile", { projectId }, CLIENT);

    const response = (await router.handle("suggest", { projectId }, CLIENT)) as {
      status: string;
      results: readonly { name: string; why: readonly string[]; alreadyInProject: boolean }[];
    };
    expect(response.status).toBe("ready");
    // "next-helper" matches the fixture's stack tags; "django-admin" matches none — the ranker
    // (installs and tag evidence) puts the matched skill first, unlike the plain query below.
    expect(response.results[0]?.name).toBe("next-helper");
    expect(response.results[0]?.why).toEqual(expect.arrayContaining(["next"]));
    expect(response.results[0]?.alreadyInProject).toBe(false);
    const djangoAdmin = response.results.find((result) => result.name === "django-admin");
    expect(djangoAdmin?.why).toEqual([]);

    await expect(router.handle("suggest", { projectId, limit: 21 }, CLIENT)).rejects.toThrow();
  });

  it("session returns missing for an id no activity evidence carries", async () => {
    const { router } = await buildRouter();

    await expect(router.handle("session", { sessionId: "claude-code:none-such" }, CLIENT)).resolves.toEqual({
      status: "missing",
    });
  });

  it("rejects an unknown project with an error", async () => {
    const { router } = await buildRouter();

    await expect(router.handle("stack_profile", { projectId: "no-such-project" }, CLIENT)).rejects.toMatchObject({
      code: "request-failed",
    });
    await expect(router.handle("suggest", { projectId: "no-such-project" }, CLIENT)).rejects.toMatchObject({
      code: "request-failed",
    });
  });
});
