import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createSkillRevision } from "../../src/domain/skill-reconciliation/revisions";
import type { SkillRevision } from "../../src/domain/skill-reconciliation/types";
import { createSkillBaseStore } from "../../src/main/skill-reconciliation/bases";

const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const baseId = "f57f360b-57d5-4c55-9c58-332dd6eef1aa";

function snapshot(): Readonly<{ revision: SkillRevision; files: ReadonlyMap<string, Uint8Array> }> {
  const files = new Map([
    ["SKILL.md", new TextEncoder().encode("# Demo\n")],
    ["payload.bin", new Uint8Array([0, 255, 13, 10])],
    ["references/notes.md", new TextEncoder().encode("Support\n")],
  ]);
  const revision = createSkillRevision(
    [...files].map(([path, bytes]) => ({ path, hash: digest(bytes), byteLength: bytes.byteLength })),
    (manifest) => digest(manifest),
  );
  return { revision, files };
}

async function userDataRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "omni-skill-bases-"));
}

test("immutable bases preserve exact binary/support bytes across a fresh store instance", async () => {
  const root = await userDataRoot();
  try {
    const { revision, files } = snapshot();
    const created = await createSkillBaseStore(root).publish(baseId, revision, files);
    expect(created).toBe("created");
    const loaded = await createSkillBaseStore(root).read(baseId);
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") return;
    expect(loaded.revision).toEqual(revision);
    expect([...loaded.files]).toEqual([...files]);
    const directory = await stat(join(root, "omni/skill-bases", baseId));
    const manifest = await stat(join(root, "omni/skill-bases", baseId, "manifest.json"));
    const payload = await stat(join(root, "omni/skill-bases", baseId, "files/payload.bin"));
    expect(directory.mode & 0o777).toBe(0o700);
    expect(manifest.mode & 0o777).toBe(0o600);
    expect(payload.mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bounded base read rejects a declared revision before loading its file bytes", async () => {
  const root = await userDataRoot();
  try {
    const { revision, files } = snapshot();
    const store = createSkillBaseStore(root);
    await store.publish(baseId, revision, files);
    expect(await store.read(baseId, 0)).toMatchObject({
      status: "corrupt",
      reason: "Skill base exceeds the requested read budget.",
    });
    expect(
      (
        await store.read(
          baseId,
          [...files.values()].reduce((total, bytes) => total + bytes.byteLength, 0),
        )
      ).status,
    ).toBe("ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing base IDs are reused only for the same verified snapshot", async () => {
  const root = await userDataRoot();
  try {
    const store = createSkillBaseStore(root);
    const first = snapshot();
    await store.publish(baseId, first.revision, first.files);
    await expect(store.publish(baseId, first.revision, first.files)).resolves.toBe("existing");
    const otherFiles = new Map(first.files).set("payload.bin", new Uint8Array([1, 2, 3]));
    const otherRevision = createSkillRevision(
      [...otherFiles].map(([path, bytes]) => ({ path, hash: digest(bytes), byteLength: bytes.byteLength })),
      (manifest) => digest(manifest),
    );
    await expect(store.publish(baseId, otherRevision, otherFiles)).rejects.toThrow(/conflicting/u);
    await expect(store.publish("../escape", first.revision, first.files)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("base store refuses symlinked IDs instead of following them", async () => {
  const root = await userDataRoot();
  try {
    const baseRoot = join(root, "omni/skill-bases");
    const outside = join(root, "outside");
    await mkdir(baseRoot, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(baseRoot, baseId));
    const store = createSkillBaseStore(root);
    expect((await store.read(baseId)).status).toBe("corrupt");
    const { revision, files } = snapshot();
    await expect(store.publish(baseId, revision, files)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("base reads reject changed bytes and malformed manifests", async () => {
  const root = await userDataRoot();
  try {
    const { revision, files } = snapshot();
    const store = createSkillBaseStore(root);
    await store.publish(baseId, revision, files);
    const payloadPath = join(root, "omni/skill-bases", baseId, "files/payload.bin");
    await writeFile(payloadPath, Buffer.from([0, 255, 13, 11]));
    expect((await store.read(baseId)).status).toBe("corrupt");
    await writeFile(join(root, "omni/skill-bases", baseId, "manifest.json"), JSON.stringify({ version: 9 }));
    expect((await store.read(baseId)).status).toBe("corrupt");
    expect(JSON.parse(await readFile(join(root, "omni/skill-bases", baseId, "manifest.json"), "utf8"))).toEqual({
      version: 9,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
