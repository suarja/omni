import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_IPC_CHANNELS,
  parseReadArtifactRequest,
  parseReadArtifactResponse,
} from "../../src/shared/artifact-ipc";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;

const handlers = new Map<string, Handler>();
const temporaryRoots: string[] = [];
let showOpenDialog: ReturnType<typeof vi.fn>;

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `omni-${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

async function loadHandlers(
  userDataPath: string,
  root: string,
  artifactGuard?: (event: unknown) => void,
): Promise<{ id: string; grantHandle: string }> {
  handlers.clear();
  showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [root] }));
  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => userDataPath) },
    dialog: { showOpenDialog },
    ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  }));
  const registry = await import("../../src/main/registry-ipc");
  const grants = registry.registerRegistryIpcHandlers(() => undefined, { userDataPath });
  const artifact = await import("../../src/main/artifact-ipc");
  artifact.registerArtifactIpcHandlers(artifactGuard ?? (() => undefined), grants);
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
  return handlerFor(ARTIFACT_IPC_CHANNELS.readArtifact)({}, request);
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("electron");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact content IPC boundary", () => {
  it("reads a UTF-8 artifact through its matching grant", async () => {
    const userDataPath = await createRoot("artifact-read-data");
    const root = await createRoot("artifact-read-root");
    await writeFile(join(root, "AGENTS.md"), "---\n# Local instructions\nUse the project scope.\n", "utf8");
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    await expect(invoke({ kind: "project", id, grantHandle, relativePath: "AGENTS.md" })).resolves.toEqual({
      status: "read",
      content: "---\n# Local instructions\nUse the project scope.\n",
      byteLength: 48,
      truncated: false,
    });
  });

  it("denies traversal, absolute paths, and symlink escapes", async () => {
    const userDataPath = await createRoot("artifact-denied-data");
    const root = await createRoot("artifact-denied-root");
    const outside = await createRoot("artifact-outside");
    await writeFile(join(outside, "secret.txt"), "private", "utf8");
    await symlink(outside, join(root, "escape"), "dir");
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    const requests = [
      "../artifact-outside/secret.txt",
      join(outside, "secret.txt"),
      "escape/secret.txt",
      "escape/missing.txt",
    ];
    for (const relativePath of requests) {
      await expect(invoke({ kind: "project", id, grantHandle, relativePath })).resolves.toEqual({ status: "denied" });
    }
  });

  it("denies a grant used for another registry entry", async () => {
    const userDataPath = await createRoot("artifact-mismatch-data");
    const firstRoot = await createRoot("artifact-first-root");
    const secondRoot = await createRoot("artifact-second-root");
    await writeFile(join(firstRoot, "one.txt"), "one", "utf8");
    await writeFile(join(secondRoot, "two.txt"), "two", "utf8");
    const first = await loadHandlers(userDataPath, firstRoot);
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [secondRoot] });
    const secondResponse = await handlerFor("omni:registry:register-project")({}, {});
    const secondId = (secondResponse as { entry: { ref: { id: string } } }).entry.ref.id;

    await expect(
      invoke({ kind: "project", id: secondId, grantHandle: first.grantHandle, relativePath: "two.txt" }),
    ).resolves.toEqual({ status: "denied" });
  });

  it("enforces the byte limit and identifies binary or invalid UTF-8 data", async () => {
    const userDataPath = await createRoot("artifact-types-data");
    const root = await createRoot("artifact-types-root");
    await writeFile(join(root, "large.txt"), Buffer.alloc(256 * 1024 + 1, 97));
    await writeFile(join(root, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(join(root, "invalid.bin"), Buffer.from([0xc3, 0x28]));
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    await expect(invoke({ kind: "project", id, grantHandle, relativePath: "large.txt" })).resolves.toEqual({
      status: "too-large",
      byteLength: 256 * 1024 + 1,
      limit: 256 * 1024,
    });
    await expect(invoke({ kind: "project", id, grantHandle, relativePath: "binary.bin" })).resolves.toEqual({
      status: "binary",
      byteLength: 3,
    });
    await expect(invoke({ kind: "project", id, grantHandle, relativePath: "invalid.bin" })).resolves.toEqual({
      status: "binary",
      byteLength: 2,
    });
  });

  it("keeps the parser allowlisted and rejects unsafe response fields", async () => {
    expect(
      parseReadArtifactRequest({
        kind: "project",
        id: "project-one",
        grantHandle: "grant-1",
        relativePath: "../outside",
      }),
    ).toEqual({
      kind: "project",
      id: "project-one",
      grantHandle: "grant-1",
      relativePath: "../outside",
    });
    expect(() =>
      parseReadArtifactRequest({
        kind: "project",
        id: "project-one",
        grantHandle: "grant-1",
        relativePath: "AGENTS.md",
        extra: true,
      }),
    ).toThrow(/unexpected field/i);
    expect(parseReadArtifactResponse({ status: "denied" })).toEqual({ status: "denied" });
    expect(() => parseReadArtifactResponse({ status: "unavailable", diagnostic: "/private/root" })).toThrow(/safe/i);
  });

  it("guards the artifact handler with the trusted sender check", async () => {
    const userDataPath = await createRoot("artifact-guard-data");
    const root = await createRoot("artifact-guard-root");
    const guard = vi.fn(() => {
      throw new Error("untrusted");
    });
    await loadHandlers(userDataPath, root, guard);

    await expect(handlerFor(ARTIFACT_IPC_CHANNELS.readArtifact)({}, {})).rejects.toThrow("untrusted");
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it("does not expose absolute paths in file failures", async () => {
    const userDataPath = await createRoot("artifact-unavailable-data");
    const root = await createRoot("artifact-unavailable-root");
    const { id, grantHandle } = await loadHandlers(userDataPath, root);
    const result = await invoke({ kind: "project", id, grantHandle, relativePath: "missing.txt" });

    expect(result).toEqual({ status: "unavailable", diagnostic: "The artifact is unavailable." });
    expect(JSON.stringify(result)).not.toContain(await realpath(root));
  });
});
