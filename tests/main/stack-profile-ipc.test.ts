import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { STACK_PROFILE_IPC_CHANNELS } from "../../src/shared/stack-profile-ipc";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;
type StackTagView = Readonly<{ id: string; label: string; evidence: readonly string[] }>;
type ReadyResponse = Readonly<{
  status: "ready";
  cached: boolean;
  profile: Readonly<{
    tags: readonly StackTagView[];
    languages: readonly Readonly<{ id: string; files: number }>[];
    harnesses: readonly string[];
    computedAt: string;
    treeHash: string;
  }>;
}>;

const handlers = new Map<string, Handler>();
const temporaryRoots: string[] = [];
let showOpenDialog: ReturnType<typeof vi.fn>;

const FIXTURES_ROOT = join(import.meta.dirname, "../fixtures/stack");

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `omni-${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

async function loadHandlers(userDataPath: string, root: string): Promise<{ id: string; grantHandle: string }> {
  handlers.clear();
  showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [root] }));
  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => userDataPath) },
    dialog: { showOpenDialog },
    ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  }));
  const registry = await import("../../src/main/registry-ipc");
  const grants = registry.registerRegistryIpcHandlers(() => undefined, { userDataPath });
  const stackProfile = await import("../../src/main/stack-profile-ipc");
  stackProfile.registerStackProfileIpcHandlers(() => undefined, grants, { userDataPath });
  const registered = await handlerFor("omni:registry:register-project")({}, {});
  const response = registered as { entry: { ref: { id: string } }; grantHandle: string };
  return { id: response.entry.ref.id, grantHandle: response.grantHandle };
}

function handlerFor(channel: string): Handler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}.`);
  return handler;
}

function invoke(request: unknown): Promise<unknown> {
  return handlerFor(STACK_PROFILE_IPC_CHANNELS.get)({}, request);
}

function tagIds(response: ReadyResponse): readonly string[] {
  return response.profile.tags.map((tag) => tag.id);
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("electron");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stack profile IPC boundary", () => {
  it("computes a ready profile for a real project shape (example-web fixture)", async () => {
    const userDataPath = await createRoot("stack-web-data");
    const root = await createRoot("stack-web-root");
    await cp(join(FIXTURES_ROOT, "example-web"), root, { recursive: true });
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    const response = (await invoke({ projectId: id, grantHandle })) as ReadyResponse;
    expect(response.status).toBe("ready");
    expect(response.cached).toBe(false);
    expect(tagIds(response)).toEqual(
      expect.arrayContaining(["next", "convex", "clerk", "typescript", "tailwind", "vitest", "node", "github-actions"]),
    );
    expect(response.profile.harnesses).toEqual(["claude-code"]);
    expect(response.profile.treeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("denies a request without a matching grant", async () => {
    const userDataPath = await createRoot("stack-denied-data");
    const root = await createRoot("stack-denied-root");
    const { id } = await loadHandlers(userDataPath, root);

    await expect(invoke({ projectId: id, grantHandle: "not-a-real-grant" })).resolves.toEqual({ status: "denied" });
  });

  it("denies a grant issued for a different project", async () => {
    const userDataPath = await createRoot("stack-mismatch-data");
    const firstRoot = await createRoot("stack-mismatch-first");
    const secondRoot = await createRoot("stack-mismatch-second");
    const first = await loadHandlers(userDataPath, firstRoot);
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [secondRoot] });
    const secondResponse = await handlerFor("omni:registry:register-project")({}, {});
    const secondId = (secondResponse as { entry: { ref: { id: string } } }).entry.ref.id;

    await expect(invoke({ projectId: secondId, grantHandle: first.grantHandle })).resolves.toEqual({
      status: "denied",
    });
  });

  it("does not read the manifests of a nested repository (submodule or vendored checkout)", async () => {
    const userDataPath = await createRoot("stack-nested-data");
    const root = await createRoot("stack-nested-root");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
    await mkdir(join(root, "vendor-copy"), { recursive: true });
    await writeFile(join(root, "vendor-copy", ".git"), "gitdir: ../.git/modules/vendor-copy\n");
    await writeFile(
      join(root, "vendor-copy", "package.json"),
      JSON.stringify({ dependencies: { electron: "36.0.0" } }),
    );
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    const response = (await invoke({ projectId: id, grantHandle })) as ReadyResponse;
    expect(response.status).toBe("ready");
    expect(tagIds(response)).toContain("next");
    expect(tagIds(response)).not.toContain("electron");
  });

  it("never lists node_modules and never crosses the depth bound", async () => {
    const userDataPath = await createRoot("stack-bounds-data");
    const root = await createRoot("stack-bounds-root");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "1.0.0" } }));
    await mkdir(join(root, "node_modules", "stripe"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "stripe", "package.json"),
      JSON.stringify({ dependencies: { stripe: "1.0.0" } }),
    );
    // "x/y/z" is 3 segments (a listable directory, depth <= 4); its Cargo.toml is a depth-4 file.
    await mkdir(join(root, "x", "y", "z"), { recursive: true });
    await writeFile(join(root, "x", "y", "z", "Cargo.toml"), '[package]\nname = "visible"\n');
    // "a/b/c/d/e" is 5 segments: "a/b/c/d" (4 segments) is listed, but its child "e" is never recursed into.
    await mkdir(join(root, "a", "b", "c", "d", "e"), { recursive: true });
    await writeFile(join(root, "a", "b", "c", "d", "e", "Cargo.toml"), '[package]\nname = "too-deep"\n');
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    const response = (await invoke({ projectId: id, grantHandle })) as ReadyResponse;
    expect(response.status).toBe("ready");
    expect(tagIds(response)).not.toContain("stripe");
    expect(tagIds(response)).toContain("rust");
    const rustEvidence = response.profile.tags.find((tag) => tag.id === "rust")!.evidence;
    expect(rustEvidence).toEqual(["x/y/z/Cargo.toml present"]);
  });

  it("caps manifest content reads at 64 files", async () => {
    const userDataPath = await createRoot("stack-cap-data");
    const root = await createRoot("stack-cap-root");
    for (let index = 0; index < 70; index += 1) {
      const name = `pkg-${String(index).padStart(3, "0")}`;
      await mkdir(join(root, "pkgs", name), { recursive: true });
      await writeFile(join(root, "pkgs", name, "package.json"), JSON.stringify({ dependencies: { react: "1.0.0" } }));
    }
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    const response = (await invoke({ projectId: id, grantHandle })) as ReadyResponse;
    expect(response.status).toBe("ready");
    const reactTag = response.profile.tags.find((tag) => tag.id === "react");
    expect(reactTag?.evidence).toHaveLength(64);
  });

  it("returns a cache hit when the manifest tree hash has not changed", async () => {
    const userDataPath = await createRoot("stack-cache-data");
    const root = await createRoot("stack-cache-root");
    await cp(join(FIXTURES_ROOT, "example-web"), root, { recursive: true });
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    const first = (await invoke({ projectId: id, grantHandle })) as ReadyResponse;
    expect(first.cached).toBe(false);

    const second = (await invoke({ projectId: id, grantHandle })) as ReadyResponse;
    expect(second.cached).toBe(true);
    expect(second.profile).toEqual(first.profile);
  });

  it("recomputes when a manifest file changes", async () => {
    const userDataPath = await createRoot("stack-recompute-data");
    const root = await createRoot("stack-recompute-root");
    await cp(join(FIXTURES_ROOT, "example-web"), root, { recursive: true });
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    const first = (await invoke({ projectId: id, grantHandle })) as ReadyResponse;
    expect(first.cached).toBe(false);

    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies.stripe = "^1.0.0";
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));

    const second = (await invoke({ projectId: id, grantHandle })) as ReadyResponse;
    expect(second.cached).toBe(false);
    expect(tagIds(second)).toContain("stripe");
    expect(second.profile.treeHash).not.toBe(first.profile.treeHash);
  });

  it("recomputes when refresh is requested even though nothing changed", async () => {
    const userDataPath = await createRoot("stack-refresh-data");
    const root = await createRoot("stack-refresh-root");
    await cp(join(FIXTURES_ROOT, "example-web"), root, { recursive: true });
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    const first = (await invoke({ projectId: id, grantHandle })) as ReadyResponse;
    expect(first.cached).toBe(false);

    const second = (await invoke({ projectId: id, grantHandle, refresh: true })) as ReadyResponse;
    expect(second.cached).toBe(false);
    expect(second.profile.treeHash).toBe(first.profile.treeHash);
  });

  it("persists the cache atomically under <userData>/omni/stack-profiles.json", async () => {
    const userDataPath = await createRoot("stack-persist-data");
    const root = await createRoot("stack-persist-root");
    await cp(join(FIXTURES_ROOT, "example-python"), root, { recursive: true });
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    await invoke({ projectId: id, grantHandle });
    const stored = JSON.parse(await readFile(join(userDataPath, "omni", "stack-profiles.json"), "utf8")) as Record<
      string,
      { tags: StackTagView[] }
    >;
    expect(stored[id]?.tags.map((tag) => tag.id)).toContain("fastapi");
  });

  it("tolerates a corrupt cache file and still computes a fresh profile", async () => {
    const userDataPath = await createRoot("stack-corrupt-data");
    const root = await createRoot("stack-corrupt-root");
    await cp(join(FIXTURES_ROOT, "empty"), root, { recursive: true });
    await mkdir(join(userDataPath, "omni"), { recursive: true });
    await writeFile(join(userDataPath, "omni", "stack-profiles.json"), "{not json");
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    const response = (await invoke({ projectId: id, grantHandle })) as ReadyResponse;
    expect(response.status).toBe("ready");
    expect(response.profile.tags).toEqual([]);
  });

  it("guards the handler with the trusted sender check", async () => {
    const userDataPath = await createRoot("stack-guard-data");
    const root = await createRoot("stack-guard-root");
    await cp(join(FIXTURES_ROOT, "empty"), root, { recursive: true });
    handlers.clear();
    showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [root] }));
    vi.doMock("electron", () => ({
      app: { getPath: vi.fn(() => userDataPath) },
      dialog: { showOpenDialog },
      ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
    }));
    const registry = await import("../../src/main/registry-ipc");
    const grants = registry.registerRegistryIpcHandlers(() => undefined, { userDataPath });
    const guard = vi.fn(() => {
      throw new Error("untrusted");
    });
    const stackProfile = await import("../../src/main/stack-profile-ipc");
    stackProfile.registerStackProfileIpcHandlers(guard, grants, { userDataPath });

    await expect(handlerFor(STACK_PROFILE_IPC_CHANNELS.get)({}, {})).rejects.toThrow("untrusted");
    expect(guard).toHaveBeenCalledTimes(1);
  });
});
