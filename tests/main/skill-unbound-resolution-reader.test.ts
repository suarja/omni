import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { afterEach, vi } from "vitest";

import { readSkillUnboundResolutionSnapshot } from "../../src/main/skill-management/unbound-reader";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import {
  observedSkillId,
  projectSkill,
  registerOperations,
  seedFixture,
  sourcePackage,
  sourceSkill,
} from "../integration/skill-adoption-fixture";

afterEach(() => vi.resetModules());

it("captures the exact selected source, unbound copy, raw bytes, roots, and directory envelope", async () => {
  const fixture = await seedFixture();
  const skillId = await observedSkillId(fixture);
  await registerOperations(fixture);
  await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Local only\r\n");
  await mkdir(join(fixture.projectRoot, projectSkill, ".git"));
  const request = {
    choice: "link-canonical" as const,
    skillId,
    source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
    locations: [{ projectId: fixture.project.id, harnessId: "codex" as const, folderPath: projectSkill }] as const,
  };
  const result = await readSkillUnboundResolutionSnapshot(request, {
    registry: fixture.registry,
    relationships: createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json")),
    bindings: createBindingsStore(bindingsFilePath(fixture.userDataPath)),
  });
  expect(result.status).toBe("ready");
  if (result.status !== "ready") return;
  expect(result.sourceTree.revision.hash).not.toBe(result.localTree.revision.hash);
  expect(Buffer.from(result.localTree.files.get("notes.md")!).toString("utf8")).toBe("Local only\r\n");
  expect(Array.from(result.sourceTree.files.get("support/payload.bin")!)).toEqual([0, 1, 255, 3]);
  expect(result.localEnvelope.some((entry) => entry.path === "support" && entry.kind === "directory")).toBe(true);
  expect(result.localEnvelope.some((entry) => entry.path === ".git" && entry.kind === "directory")).toBe(true);
  expect(result.rootIdentities.source).toMatch(/^[a-f0-9]{64}$/u);
  expect(result.rootIdentities.project).toMatch(/^[a-f0-9]{64}$/u);
});
