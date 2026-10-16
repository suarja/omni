import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Binding } from "../../src/domain/assignment-plan";
import { createBindingsStore } from "../../src/main/bindings-store";

const roots: string[] = [];

const binding: Binding = {
  bindingId: "binding-one",
  sourceId: "source-one",
  packageId: "package-one",
  artifactPath: "skills/review",
  kind: "skill",
  projectId: "project-one",
  harnessId: "claude-code",
  boundHash: "a".repeat(64),
  createdAt: "2026-09-13T10:00:00.000Z",
};

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-bindings-store-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bindings store", () => {
  it("writes an atomic main file and backup and replaces the same unit/project/harness", async () => {
    const root = await createRoot();
    const filePath = join(root, "omni", "bindings.json");
    const store = createBindingsStore(filePath);

    await expect(store.save([binding])).resolves.toMatchObject({ status: "ready", bindings: [binding] });
    const replacement = { ...binding, bindingId: "binding-two", boundHash: "b".repeat(64) };
    await expect(store.save([replacement])).resolves.toMatchObject({ status: "ready", bindings: [replacement] });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ schemaVersion: 1, bindings: [replacement] });
    expect(JSON.parse(await readFile(`${filePath}.bak`, "utf8"))).toEqual({
      schemaVersion: 1,
      bindings: [replacement],
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("returns a typed corrupt result and reports a valid backup", async () => {
    const root = await createRoot();
    const filePath = join(root, "omni", "bindings.json");
    const serialized = `${JSON.stringify({ schemaVersion: 1, bindings: [binding] })}\n`;
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "omni"), { recursive: true }));
    await writeFile(`${filePath}.bak`, serialized, "utf8");
    await writeFile(filePath, "{not-json", "utf8");
    const store = createBindingsStore(filePath);

    await expect(store.read()).resolves.toEqual({
      status: "corrupt",
      diagnostic: "Bindings JSON is invalid.",
      recoveryAvailable: true,
    });
  });

  it("applies exact binding effects without replacing unrelated records or accepting stale before states", async () => {
    const root = await createRoot();
    const store = createBindingsStore(join(root, "omni", "bindings.json"));
    const unrelated = { ...binding, bindingId: "binding-unrelated", projectId: "project-two" };
    await store.save([binding, unrelated]);
    const after = { ...binding, boundHash: "b".repeat(64), ownedHash: "b".repeat(64) };

    await expect(
      store.updateExact([{ bindingId: binding.bindingId, expected: binding, next: after }]),
    ).resolves.toMatchObject({
      status: "ready",
      bindings: expect.arrayContaining([after, unrelated]),
    });
    await expect(
      store.updateExact([{ bindingId: binding.bindingId, expected: binding, next: undefined }]),
    ).rejects.toThrow("A binding changed after the operation was prepared.");
    await expect(
      store.updateExact([{ bindingId: binding.bindingId, expected: after, next: undefined }]),
    ).resolves.toMatchObject({
      status: "ready",
      bindings: [unrelated],
    });
  });
});
