import { mkdtemp, readFile, rm, symlink, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import type { LogicalSkillRecord } from "../../src/domain/skill-reconciliation/types";

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "omni-skill-relationships-"));
}

function record(skillId: string): LogicalSkillRecord {
  return {
    skillId,
    label: "design-bank",
    evidence: "individual",
    locations: [{ projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/design-bank" }],
  };
}

test("relationship records survive a fresh read and compare-and-save rejects stale revisions", async () => {
  const root = await temporaryRoot();
  try {
    const path = join(root, "omni", "skill-relationships.json");
    const store = createSkillRelationshipStore(path);
    const first = await store.read();
    expect(first).toEqual({ status: "ready", state: { schemaVersion: 1, revision: 0, skills: [], uses: [] } });
    if (first.status !== "ready") return;
    const saved = await store.compareAndSave(first.state.revision, [record("e77eb18e-5c7d-4db8-a2fd-1d941a2aef18")]);
    expect(saved.status).toBe("saved");
    const restartedRead = await createSkillRelationshipStore(path).read();
    expect(restartedRead.status).toBe("ready");
    if (restartedRead.status === "ready") {
      expect(restartedRead.state.revision).toBe(1);
      expect(restartedRead.state.skills[0]?.skillId).toBe("e77eb18e-5c7d-4db8-a2fd-1d941a2aef18");
    }
    await expect(store.compareAndSave(0, [])).resolves.toEqual({ status: "revision-conflict", actualRevision: 1 });
    const details = await stat(path);
    expect(details.mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serialized concurrent observations allow only one save for an expected revision", async () => {
  const root = await temporaryRoot();
  try {
    const store = createSkillRelationshipStore(join(root, "omni", "skill-relationships.json"));
    const results = await Promise.all([
      store.compareAndSave(0, [record("e77eb18e-5c7d-4db8-a2fd-1d941a2aef18")]),
      store.compareAndSave(0, [record("f57f360b-57d5-4c55-9c58-332dd6eef1aa")]),
    ]);
    expect(results.filter((result) => result.status === "saved")).toHaveLength(1);
    expect(results.filter((result) => result.status === "revision-conflict")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("logical records and managed uses are saved atomically and exact conflicts leave both unchanged", async () => {
  const root = await temporaryRoot();
  try {
    const store = createSkillRelationshipStore(join(root, "omni", "skill-relationships.json"));
    const skill = record("e77eb18e-5c7d-4db8-a2fd-1d941a2aef18");
    const use = {
      skillId: skill.skillId,
      bindingId: "legacy-one",
      location: skill.locations[0]!,
      source: { sourceId: "source-one", packageId: "packages/tools", artifactPath: "skills/design-bank" },
      baseRevisionId: "f57f360b-57d5-4c55-9c58-332dd6eef1aa",
      baseUnavailable: true as const,
    };
    const result = await store.updateUsesExact(
      0,
      [{ skillId: skill.skillId, location: use.location, after: use }],
      [{ skillId: skill.skillId, after: skill }],
    );
    expect(result).toMatchObject({ status: "saved", state: { skills: [skill], uses: [use], revision: 1 } });
    const conflict = await store.updateUsesExact(
      1,
      [{ skillId: skill.skillId, location: use.location, before: use }],
      [{ skillId: skill.skillId, before: { ...skill, label: "Wrong prior label" } }],
    );
    expect(conflict.status).toBe("revision-conflict");
    expect(await store.read()).toMatchObject({ state: { skills: [skill], uses: [use], revision: 1 } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed and symlinked stores stay corrupt instead of resetting to empty", async () => {
  const root = await temporaryRoot();
  try {
    const directory = join(root, "omni");
    const path = join(directory, "skill-relationships.json");
    const outside = join(root, "outside.json");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(directory));
    await writeFile(path, JSON.stringify({ schemaVersion: 99, revision: 0, skills: [] }));
    const malformed = await createSkillRelationshipStore(path).read();
    expect(malformed.status).toBe("corrupt");
    expect((await createSkillRelationshipStore(path).compareAndSave(0, [])).status).toBe("corrupt");

    await rm(path);
    await writeFile(outside, JSON.stringify({ schemaVersion: 1, revision: 0, skills: [] }));
    await symlink(outside, path);
    const linked = await createSkillRelationshipStore(path).read();
    expect(linked.status).toBe("corrupt");
    expect(JSON.parse(await readFile(outside, "utf8"))).toEqual({ schemaVersion: 1, revision: 0, skills: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a valid backup is surfaced when the primary relationship store is missing", async () => {
  const root = await temporaryRoot();
  try {
    const path = join(root, "omni", "skill-relationships.json");
    const store = createSkillRelationshipStore(path);
    const initial = await store.read();
    if (initial.status !== "ready") throw new Error("Fresh store did not initialize.");
    await store.compareAndSave(0, [record("e77eb18e-5c7d-4db8-a2fd-1d941a2aef18")]);
    await store.compareAndSave(1, [record("f57f360b-57d5-4c55-9c58-332dd6eef1aa")]);
    await rm(path);
    const missing = await store.read();
    expect(missing).toMatchObject({ status: "corrupt", recoveryAvailable: true });
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8")).revision).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observation saves preserve exact uses and touched updates retain unrelated metadata", async () => {
  const root = await temporaryRoot();
  try {
    const store = createSkillRelationshipStore(join(root, "omni", "skill-relationships.json"));
    const skillId = "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18";
    const location = {
      projectId: "project-one",
      harnessId: "codex" as const,
      folderPath: ".agents/skills/design-bank",
    };
    const source = { sourceId: "personal-source", packageId: "owned-package", artifactPath: "skills/demo" };
    const skill = record(skillId);
    const initial = await store.read();
    if (initial.status !== "ready") throw new Error("Fresh store did not initialize.");
    const saved = await store.compareAndSave(initial.state.revision, [skill]);
    if (saved.status !== "saved") throw new Error("Skill record was not saved.");
    const use = {
      skillId,
      bindingId: "binding-one",
      location,
      source,
      baseRevisionId: "f57f360b-57d5-4c55-9c58-332dd6eef1aa",
    };
    const adopted = await store.updateUsesExact(saved.state.revision, [{ skillId, location, after: use }]);
    expect(adopted.status).toBe("saved");
    if (adopted.status !== "saved") return;

    const observed = await store.compareAndSave(adopted.state.revision, [
      { ...skill, label: "renamed by observation" },
    ]);
    expect(observed.status).toBe("saved");
    if (observed.status !== "saved") return;
    expect(observed.state.uses).toEqual([use]);

    const conflict = await store.updateUsesExact(observed.state.revision, [
      { skillId, location, before: { ...use, bindingId: "stale-binding" }, after: undefined },
    ]);
    expect(conflict).toEqual({ status: "revision-conflict", actualRevision: observed.state.revision });
    const afterConflict = await store.read();
    expect(afterConflict.status === "ready" ? afterConflict.state.uses : undefined).toEqual([use]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
