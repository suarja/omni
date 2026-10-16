import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createSkillReconciliationService } from "../../src/application/skill-reconciliation";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import type {
  SkillCopyLocationRead,
  SkillMember,
  SkillRevision,
  SkillTreeRead,
} from "../../src/domain/skill-reconciliation/types";

const revision = (hash: string): SkillRevision => ({
  algorithm: "omni-tree-v1",
  hash: hash.repeat(64),
  files: [{ path: "SKILL.md", hash: hash.repeat(64), byteLength: 1 }],
});

function member(path: string, harnessId: "codex" | "claude-code", hash: string): SkillMember {
  return {
    location: { projectId: "project-one", harnessId, folderPath: path },
    ref: { kind: "artifact", entry: { kind: "project", id: "project-one" }, artifactId: `${harnessId}-skill` },
    read: { status: "complete", revision: revision(hash) },
  };
}

function locationRead(memberValue: SkillMember, read: SkillTreeRead = memberValue.read): SkillCopyLocationRead {
  return { location: memberValue.location, read };
}

test("observed membership keeps its logical ID across a new service and a changed copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-reconciliation-service-"));
  try {
    const path = join(root, "omni", "skill-relationships.json");
    const store = createSkillRelationshipStore(path);
    const firstService = createSkillReconciliationService({
      store,
      allocateId: () => "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18",
    });
    const first = await firstService.observeProject(
      "project-one",
      [
        {
          groupId: "individual-skills",
          members: [
            member(".agents/skills/design-bank", "codex", "a"),
            member(".claude/skills/design-bank", "claude-code", "a"),
          ],
        },
      ],
      [
        locationRead(member(".agents/skills/design-bank", "codex", "a")),
        locationRead(member(".claude/skills/design-bank", "claude-code", "a")),
      ],
    );
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    const skillId = first.groups[0]?.correlation.groups[0]?.skillId;

    const restartedService = createSkillReconciliationService({
      store: createSkillRelationshipStore(path),
      allocateId: () => {
        throw new Error("A persisted identity must be reused.");
      },
    });
    const next = await restartedService.observeProject(
      "project-one",
      [
        {
          groupId: "individual-skills",
          members: [
            member(".agents/skills/design-bank", "codex", "a"),
            member(".claude/skills/design-bank", "claude-code", "b"),
          ],
        },
      ],
      [
        locationRead(member(".agents/skills/design-bank", "codex", "a")),
        locationRead(member(".claude/skills/design-bank", "claude-code", "b")),
      ],
    );
    expect(next.status).toBe("ready");
    if (next.status === "ready") {
      expect(next.groups[0]?.correlation.groups[0]?.skillId).toBe(skillId);
      expect(next.groups[0]?.correlation.groups[0]?.state).toBe("copy-difference");
      expect(next.storeRevision).toBe(first.storeRevision);
    }

    const codex = member(".agents/skills/design-bank", "codex", "a");
    const claude = member(".claude/skills/design-bank", "claude-code", "b");
    const missing = await restartedService.observeProject(
      "project-one",
      [{ groupId: "individual-skills", members: [codex] }],
      [locationRead(codex), locationRead(claude, { status: "unavailable", reason: "missing" })],
    );
    expect(missing.status).toBe("ready");
    if (missing.status === "ready") {
      expect(missing.groups[0]?.correlation.groups[0]?.state).toBe("unavailable");
      expect(missing.groups[0]?.correlation.groups[0]?.locations).toHaveLength(2);
      expect(missing.retainedSkills).toEqual([]);
    }

    const allMissing = await restartedService.observeProject(
      "project-one",
      [],
      [
        locationRead(codex, { status: "unavailable", reason: "missing" }),
        locationRead(claude, { status: "unavailable", reason: "missing" }),
      ],
    );
    expect(allMissing.status).toBe("ready");
    if (allMissing.status === "ready") {
      expect(allMissing.groups).toEqual([]);
      expect(allMissing.retainedSkills).toHaveLength(1);
      expect(allMissing.retainedSkills[0]?.record.skillId).toBe(skillId);
      expect(allMissing.retainedSkills[0]?.locations).toHaveLength(2);
    }

    const empty = await restartedService.observeProject("project-one", [], []);
    expect(empty).toEqual({ status: "unavailable", reason: "observation" });
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(stored.uses).toEqual([]);
    expect(stored).not.toHaveProperty("bindings");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
