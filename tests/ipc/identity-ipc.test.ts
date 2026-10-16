import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IDENTITY_IPC_CHANNELS,
  parseHashArtifactsRequest,
  parseHashArtifactsResponse,
} from "../../src/shared/identity-ipc";

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
  guard?: (event: unknown) => void,
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
  const identity = await import("../../src/main/identity-ipc");
  identity.registerIdentityIpcHandlers(guard ?? (() => undefined), grants);
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
  return handlerFor(IDENTITY_IPC_CHANNELS.hashArtifacts)({}, request);
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("electron");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact identity hashing IPC boundary", () => {
  it("hashes files and skill folders without exposing absolute paths", async () => {
    const userDataPath = await createRoot("identity-data");
    const root = await createRoot("identity-root");
    await mkdir(join(root, "pstack"), { recursive: true });
    await writeFile(join(root, "pstack/omni.plugin.json"), '{"name":"Pstack"}', "utf8");
    await mkdir(join(root, "pstack/skills/architect"), { recursive: true });
    await writeFile(join(root, "pstack/skills/architect/SKILL.md"), "skill\n", "utf8");
    await writeFile(join(root, "pstack/skills/architect/notes.md"), "notes\n", "utf8");
    const { id, grantHandle } = await loadHandlers(userDataPath, root);
    const request = {
      kind: "project",
      id,
      grantHandle,
      artifacts: [
        { artifactId: "skill-a", relativePath: "pstack/skills/architect/SKILL.md", kind: "skill" },
        { artifactId: "manifest-a", relativePath: "pstack/omni.plugin.json", kind: "plugin-manifest" },
      ],
    } as const;

    const first = await invoke(request);
    const second = await invoke(request);

    expect(first).toEqual(second);
    // A "skill" artifact whose relativePath resolves to a regular file (SKILL.md is enumerated as
    // its own file during a real scan) hashes its own bytes, not the folder that contains it — the
    // whole-folder hash below is reserved for an artifact whose path IS a directory.
    expect(first).toMatchObject({
      status: "hashed",
      identities: [
        expect.objectContaining({
          artifactId: "skill-a",
          logicalId: "pstack/skills/architect",
          byteLength: 6,
          contentHash: createHash("sha256").update("skill\n", "utf8").digest("hex"),
        }),
        expect.objectContaining({
          artifactId: "manifest-a",
          contentHash: createHash("sha256").update('{"name":"Pstack"}', "utf8").digest("hex"),
        }),
      ],
      subject: { kind: "project", id },
    });
    expect(JSON.stringify(first)).not.toContain(
      await import("node:fs/promises").then(({ realpath }) => realpath(root)),
    );
  });

  it("hashes distinct files under a skill's references/ folder to distinct byte hashes, never the folder's hash", async () => {
    const userDataPath = await createRoot("identity-refs-data");
    const root = await createRoot("identity-refs-root");
    await mkdir(join(root, ".claude/skills/x/references"), { recursive: true });
    await writeFile(join(root, ".claude/skills/x/SKILL.md"), "skill\n", "utf8");
    await writeFile(join(root, ".claude/skills/x/references/alpha.md"), "alpha content\n", "utf8");
    await writeFile(join(root, ".claude/skills/x/references/beta.md"), "beta content\n", "utf8");
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    const response = (await invoke({
      kind: "project",
      id,
      grantHandle,
      artifacts: [
        { artifactId: "ref-alpha", relativePath: ".claude/skills/x/references/alpha.md", kind: "skill" },
        { artifactId: "ref-beta", relativePath: ".claude/skills/x/references/beta.md", kind: "skill" },
      ],
    })) as { identities: { artifactId: string; contentHash: string }[] };

    const alpha = response.identities.find((identity) => identity.artifactId === "ref-alpha");
    const beta = response.identities.find((identity) => identity.artifactId === "ref-beta");
    expect(alpha?.contentHash).toBe(createHash("sha256").update("alpha content\n", "utf8").digest("hex"));
    expect(beta?.contentHash).toBe(createHash("sha256").update("beta content\n", "utf8").digest("hex"));
    expect(alpha?.contentHash).not.toBe(beta?.contentHash);
  });

  it("hashes a whole skill-folder artifact deterministically and changes the hash when a child file changes", async () => {
    const userDataPath = await createRoot("identity-folder-data");
    const root = await createRoot("identity-folder-root");
    await mkdir(join(root, ".claude/skills/x/references"), { recursive: true });
    await writeFile(join(root, ".claude/skills/x/SKILL.md"), "skill\n", "utf8");
    await writeFile(join(root, ".claude/skills/x/references/note.md"), "note v1\n", "utf8");
    const { id, grantHandle } = await loadHandlers(userDataPath, root);
    const request = {
      kind: "project" as const,
      id,
      grantHandle,
      artifacts: [{ artifactId: "folder", relativePath: ".claude/skills/x", kind: "skill" as const }],
    };

    const before = (await invoke(request)) as { identities: { contentHash: string }[] };
    await writeFile(join(root, ".claude/skills/x/references/note.md"), "note v2\n", "utf8");
    const after = (await invoke(request)) as { identities: { contentHash: string }[] };
    const repeat = (await invoke(request)) as { identities: { contentHash: string }[] };

    expect(before.identities[0]?.contentHash).toBeTruthy();
    expect(after.identities[0]?.contentHash).not.toBe(before.identities[0]?.contentHash);
    expect(repeat.identities[0]?.contentHash).toBe(after.identities[0]?.contentHash);
  });

  it("hashes a symlinked skill directory inside the root equal to its target directory", async () => {
    const userDataPath = await createRoot("identity-symlink-data");
    const root = await createRoot("identity-symlink-root");
    await mkdir(join(root, ".agents/skills/x/references"), { recursive: true });
    await writeFile(join(root, ".agents/skills/x/SKILL.md"), "skill\n", "utf8");
    await writeFile(join(root, ".agents/skills/x/references/note.md"), "note\n", "utf8");
    await mkdir(join(root, ".claude/skills"), { recursive: true });
    await symlink(join(root, ".agents/skills/x"), join(root, ".claude/skills/x"), "dir");
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    const response = (await invoke({
      kind: "project",
      id,
      grantHandle,
      artifacts: [
        { artifactId: "target", relativePath: ".agents/skills/x", kind: "skill" },
        { artifactId: "symlinked", relativePath: ".claude/skills/x", kind: "skill" },
      ],
    })) as { identities: { artifactId: string; contentHash: string }[] };

    const target = response.identities.find((identity) => identity.artifactId === "target");
    const symlinked = response.identities.find((identity) => identity.artifactId === "symlinked");
    expect(target?.contentHash).toBeTruthy();
    expect(symlinked?.contentHash).toBe(target?.contentHash);
  });

  it("denies a symlinked skill directory that points outside the granted root", async () => {
    const userDataPath = await createRoot("identity-symlink-escape-data");
    const root = await createRoot("identity-symlink-escape-root");
    const outside = await createRoot("identity-symlink-escape-outside");
    await mkdir(join(outside, "x"), { recursive: true });
    await writeFile(join(outside, "x/SKILL.md"), "skill\n", "utf8");
    await mkdir(join(root, ".claude/skills"), { recursive: true });
    await symlink(join(outside, "x"), join(root, ".claude/skills/x"), "dir");
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    await expect(
      invoke({
        kind: "project",
        id,
        grantHandle,
        artifacts: [{ artifactId: "escaped-skill", relativePath: ".claude/skills/x", kind: "skill" }],
      }),
    ).resolves.toEqual({
      status: "hashed",
      identities: [],
      skipped: [{ artifactId: "escaped-skill", reason: "denied" }],
      subject: { kind: "project", id },
    });
  });

  it("skips oversized files and denies containment escapes", async () => {
    const userDataPath = await createRoot("identity-size-data");
    const root = await createRoot("identity-size-root");
    const outside = await createRoot("identity-outside");
    await writeFile(join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 97));
    await symlink(outside, join(root, "escape"), "dir");
    const { id, grantHandle } = await loadHandlers(userDataPath, root);

    await expect(
      invoke({
        kind: "project",
        id,
        grantHandle,
        artifacts: [
          { artifactId: "large", relativePath: "large.txt", kind: "instruction" },
          { artifactId: "escape", relativePath: "escape/secret.txt", kind: "instruction" },
        ],
      }),
    ).resolves.toEqual({
      status: "hashed",
      identities: [],
      skipped: [
        { artifactId: "escape", reason: "denied" },
        { artifactId: "large", reason: "too-large" },
      ],
      subject: { kind: "project", id },
    });
  });

  it("denies a grant used for another root and guards the sender", async () => {
    const userDataPath = await createRoot("identity-mismatch-data");
    const firstRoot = await createRoot("identity-first-root");
    const secondRoot = await createRoot("identity-second-root");
    await writeFile(join(firstRoot, "one.txt"), "one", "utf8");
    await writeFile(join(secondRoot, "two.txt"), "two", "utf8");
    const first = await loadHandlers(userDataPath, firstRoot);
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [secondRoot] });
    const secondResponse = await handlerFor("omni:registry:register-project")({}, {});
    const secondId = (secondResponse as { entry: { ref: { id: string } } }).entry.ref.id;

    await expect(
      invoke({ kind: "project", id: secondId, grantHandle: first.grantHandle, artifacts: [] }),
    ).resolves.toEqual({ status: "denied" });

    const guard = vi.fn(() => {
      throw new Error("untrusted");
    });
    const guarded = await loadHandlers(
      await createRoot("identity-guard-data"),
      await createRoot("identity-guard-root"),
      guard,
    );
    await expect(
      handlerFor(IDENTITY_IPC_CHANNELS.hashArtifacts)(
        {},
        { kind: "project", id: guarded.id, grantHandle: guarded.grantHandle, artifacts: [] },
      ),
    ).rejects.toThrow("untrusted");
    expect(guard).toHaveBeenCalledOnce();
  });

  it("keeps request and response parsers allowlisted", () => {
    expect(
      parseHashArtifactsRequest({ kind: "source", id: "source-one", grantHandle: "grant-1", artifacts: [] }),
    ).toEqual({
      kind: "source",
      id: "source-one",
      grantHandle: "grant-1",
      artifacts: [],
    });
    expect(() =>
      parseHashArtifactsRequest({
        kind: "source",
        id: "source-one",
        grantHandle: "grant-1",
        artifacts: [],
        extra: true,
      }),
    ).toThrow(/unexpected field/i);
    expect(parseHashArtifactsResponse({ status: "denied" })).toEqual({ status: "denied" });
    expect(() =>
      parseHashArtifactsResponse({ status: "hashed", identities: [], skipped: [], absolutePath: "/private/secret" }),
    ).toThrow(/unexpected field/i);
  });
});
