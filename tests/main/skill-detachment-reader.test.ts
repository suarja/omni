import { cp, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { createSkillBaseStore } from "../../src/main/skill-reconciliation/bases";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { readSkillDetachmentSnapshot } from "../../src/main/skill-management/detachment-reader";
import type { RegistryIpcServices } from "../../src/main/registry-ipc";
import { managedFixture } from "../integration/skill-resolution-fixture";
import { projectSkill } from "../integration/skill-adoption-fixture";

function request(fixture: Awaited<ReturnType<typeof managedFixture>>) {
  return {
    choice: "detach-managed" as const,
    skillId: fixture.skillId,
    locations: [{ projectId: fixture.project.id, harnessId: "codex" as const, folderPath: projectSkill }] as const,
  };
}

function dependencies(fixture: Awaited<ReturnType<typeof managedFixture>>, registry = fixture.registry) {
  return {
    registry,
    relationships: createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json")),
    bindings: createBindingsStore(bindingsFilePath(fixture.userDataPath)),
    bases: createSkillBaseStore(fixture.userDataPath),
  };
}

it("reads a granted project copy and saved base without contacting an offline source", async () => {
  const fixture = await managedFixture();
  await mkdir(join(fixture.projectRoot, projectSkill, ".git"));
  await mkdir(join(fixture.projectRoot, projectSkill, "empty-directory"));
  let sourceRead = false;
  const registry = new Proxy(fixture.registry, {
    get(target, property, receiver) {
      if (property === "observeEntryWithGrant") {
        return async (ref: { kind: "source" | "project"; id: string }, handle: string) => {
          if (ref.kind === "source") {
            sourceRead = true;
            throw new Error("Source is offline.");
          }
          return target.observeEntryWithGrant(ref, handle);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as RegistryIpcServices;

  const snapshot = await readSkillDetachmentSnapshot(request(fixture), dependencies(fixture, registry));

  expect(snapshot.status).toBe("ready");
  if (snapshot.status !== "ready") return;
  expect(snapshot.localTree.folderPath).toBe(request(fixture).locations[0]!.folderPath);
  expect(snapshot.binding?.bindingId).toBe(snapshot.use?.bindingId);
  expect(snapshot.base?.baseRevisionId).toBe(snapshot.use?.baseRevisionId);
  expect(snapshot.envelope.some(({ path }) => path === ".git")).toBe(true);
  expect(sourceRead).toBe(false);
});

it("records a replaced project root as a different consent identity", async () => {
  const fixture = await managedFixture();
  const before = await readSkillDetachmentSnapshot(request(fixture), dependencies(fixture));
  if (before.status !== "ready") throw new Error("The original project root could not be observed.");
  const parked = `${fixture.projectRoot}-parked`;
  await rename(fixture.projectRoot, parked);
  await cp(parked, fixture.projectRoot, { recursive: true });
  try {
    const snapshot = await readSkillDetachmentSnapshot(request(fixture), dependencies(fixture));
    expect(snapshot.status).toBe("ready");
    if (snapshot.status === "ready") expect(snapshot.rootIdentity).not.toBe(before.rootIdentity);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rename(parked, fixture.projectRoot);
  }
});
