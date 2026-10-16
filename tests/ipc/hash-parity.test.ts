import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BINDINGS_IPC_CHANNELS, parseBindingsPreviewResponse } from "../../src/shared/bindings-ipc";
import { IDENTITY_IPC_CHANNELS } from "../../src/shared/identity-ipc";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const roots: string[] = [];

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `omni-${prefix}-`));
  roots.push(root);
  return root;
}

function invoke(channel: string, request: unknown = {}): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}.`);
  return handler({}, request);
}

async function loadChannels(sourceRoot: string): Promise<{ id: string; grantHandle: string }> {
  const userDataPath = await createRoot("hash-parity-data");
  handlers.clear();
  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => userDataPath) },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [sourceRoot] })) },
    ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  }));
  const registry = await import("../../src/main/registry-ipc");
  const grants = registry.registerRegistryIpcHandlers(() => undefined, { userDataPath });
  const source = await grants.registerSourceByPath(sourceRoot, "Personal");
  if (source.status !== "ready") throw new Error("Source fixture could not be registered.");
  const identity = await import("../../src/main/identity-ipc");
  identity.registerIdentityIpcHandlers(() => undefined, grants);
  const bindings = await import("../../src/main/bindings-ipc");
  bindings.registerBindingsIpcHandlers(() => undefined, grants, { userDataPath });
  return { id: source.entry.ref.id, grantHandle: source.grantHandle };
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("electron");
  handlers.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("identity and bindings hashing parity", () => {
  it("uses the same hash for a skill folder and a command file", async () => {
    const sourceRoot = await createRoot("hash-parity-source");
    const skillRoot = join(sourceRoot, "packages/tools/skills/review");
    await mkdir(join(skillRoot, "references"), { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "review skill\n", "utf8");
    await writeFile(join(skillRoot, "references/note.md"), "nested note\n", "utf8");
    await symlink("note.md", join(skillRoot, "references/linked.md"));
    await mkdir(join(sourceRoot, "packages/tools/commands"), { recursive: true });
    await writeFile(join(sourceRoot, "packages/tools/commands/review.md"), "review command\n", "utf8");
    const source = await loadChannels(sourceRoot);

    const identityResponse = (await invoke(IDENTITY_IPC_CHANNELS.hashArtifacts, {
      kind: "source",
      id: source.id,
      grantHandle: source.grantHandle,
      artifacts: [
        { artifactId: "skill-folder", relativePath: "packages/tools/skills/review", kind: "skill" },
        { artifactId: "command-file", relativePath: "packages/tools/commands/review.md", kind: "command" },
      ],
    })) as { identities: readonly { artifactId: string; contentHash: string }[] };
    const preview = parseBindingsPreviewResponse(
      await invoke(BINDINGS_IPC_CHANNELS.preview, {
        source,
        packageId: "packages/tools",
        artifactPath: "skills/review",
        projects: [],
      }),
    );
    const commandPreview = parseBindingsPreviewResponse(
      await invoke(BINDINGS_IPC_CHANNELS.preview, {
        source,
        packageId: "packages/tools",
        artifactPath: "commands/review.md",
        projects: [],
      }),
    );

    if (preview.status !== "ready" || commandPreview.status !== "ready")
      throw new Error("Bindings preview fixture was denied.");

    expect(preview).toMatchObject({ status: "ready", units: [{ kind: "skill", id: "review" }] });
    expect(commandPreview).toMatchObject({ status: "ready", units: [{ kind: "command", id: "review" }] });
    expect(preview.units[0]?.contentHash).toBe(
      identityResponse.identities.find((identity) => identity.artifactId === "skill-folder")?.contentHash,
    );
    expect(commandPreview.units[0]?.contentHash).toBe(
      identityResponse.identities.find((identity) => identity.artifactId === "command-file")?.contentHash,
    );
  });
});
