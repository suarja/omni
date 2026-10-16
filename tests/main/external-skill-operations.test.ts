import { cp, mkdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { folderHash } from "../helpers/external-library-fixture";
import { write, git, commit } from "../helpers/publication-fixture";
import { createOperationStore } from "../../src/main/operation-store";
import { createExternalLibraryService } from "../../src/main/external-library/service";
import type { SkillIntent } from "../../src/shared/skill-management-ipc";

import { externalOperationFixture, setUpdates } from "../helpers/external-operations-fixture";

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused" },
  dialog: {},
  ipcMain: { handle: vi.fn() },
}));

describe("external skill project operations", () => {
  it.each([false, true])("installs, writes the lock and restores the existing link layout=%s", async (linked) => {
    const f = await externalOperationFixture();
    if (linked) {
      await mkdir(join(f.projectA, ".claude/skills"), { recursive: true });
      await symlink("../../.agents/skills/current", join(f.projectA, ".claude/skills/current"));
    }
    const beforeLock = await readFile(join(f.projectA, "skills-lock.json"), "utf8");
    const p = await f.preview({
      kind: "install-external-skill",
      sourceId: "fixture/tools",
      skillPath: "skills/unused",
      skillName: "unused",
      targets: [{ projectId: "project-a", harnessIds: ["codex", "claude-code"] }],
      conflict: "refuse",
    });
    expect(p.steps.flatMap((step) => step.files).some((file) => file.relativePath === "skills-lock.json")).toBe(true);
    const result = await f.apply(p);
    expect(result.status).toBe("applied");
    const lock = JSON.parse(await readFile(join(f.projectA, "skills-lock.json"), "utf8"));
    expect(lock.skills.unused).toEqual({
      source: "fixture/tools",
      sourceType: "github",
      skillPath: "skills/unused",
      computedHash: await folderHash(f.projectA, ".agents/skills/unused"),
    });
    if (linked) expect(await readlink(join(f.projectA, ".claude/skills/unused"))).toBe("../../.agents/skills/unused");
    else expect(await readFile(join(f.projectA, ".claude/skills/unused/SKILL.md"), "utf8")).toContain("Base unused");
    expect((await f.apply(await f.preview({ kind: "restore", operationId: result.operationId }))).status).toBe(
      "restored",
    );
    expect(await readFile(join(f.projectA, "skills-lock.json"), "utf8")).toBe(beforeLock);
    await expect(readFile(join(f.projectA, ".agents/skills/unused/SKILL.md"))).rejects.toThrow();
  });
  it("refuses a conflict until replace is explicit and restores the original bytes", async () => {
    const f = await externalOperationFixture();
    const request = {
      kind: "install-external-skill",
      sourceId: "fixture/tools",
      skillPath: "skills/unused",
      skillName: "current",
      targets: [{ projectId: "project-a", harnessIds: ["codex"] }],
      conflict: "refuse",
    } satisfies SkillIntent;
    expect((await f.service.preview(request, { kind: "desktop" })).status).toBe("blocked");
    const before = await readFile(join(f.projectA, ".agents/skills/current/SKILL.md"));
    const result = await f.apply(await f.preview({ ...request, conflict: "replace" }));
    expect(result.status).toBe("applied");
    await f.apply(await f.preview({ kind: "restore", operationId: result.operationId }));
    expect(await readFile(join(f.projectA, ".agents/skills/current/SKILL.md"))).toEqual(before);
  });
  it("updates two projects in one operation and refuses a target edited after preview", async () => {
    const f = await externalOperationFixture();
    await cp(join(f.projectA, ".agents/skills/update"), join(f.projectB, ".agents/skills/update"), { recursive: true });
    const lock = JSON.parse(await readFile(join(f.projectB, "skills-lock.json"), "utf8"));
    const sourceLock = JSON.parse(await readFile(join(f.projectA, "skills-lock.json"), "utf8"));
    lock.skills.update = sourceLock.skills.update;
    await write(f.projectB, "skills-lock.json", JSON.stringify(lock));
    await f.library.refreshCopies();
    const uses = (await f.library.readSource("fixture/tools")).uses.filter((use) => use.state === "update");
    const p = await f.preview({
      kind: "update-external-skills",
      sourceId: "fixture/tools",
      useIds: uses.map((use) => use.id),
    });
    await write(f.projectB, ".agents/skills/update/local.txt", "Keep this edit.");
    const result = await f.apply(p);
    expect(result.status, JSON.stringify(result)).toBe("partial");
    expect(await readFile(join(f.projectA, ".agents/skills/update/SKILL.md"), "utf8")).toContain("Next.");
    expect(await readFile(join(f.projectB, ".agents/skills/update/local.txt"), "utf8")).toBe("Keep this edit.");
    await f.apply(await f.preview({ kind: "restore", operationId: result.operationId }));
    expect(await readFile(join(f.projectA, ".agents/skills/update/SKILL.md"), "utf8")).toContain("Base update.");
  });
  it.each(["mine", "source"] as const)(
    "merges taken, kept and conflicting files with the %s choice",
    async (choice) => {
      const f = await externalOperationFixture();
      await write(f.upstream, "skills/modified/taken.txt", "New upstream file.");
      await commit(f.upstream);
      await git(f.upstream, "push", f.origin, "main");
      await write(f.projectB, ".agents/skills/modified/kept.txt", "My local file.");
      await f.library.check();
      const use = (await f.library.readSource("fixture/tools")).uses.find((use) => use.skillKey === "modified")!;
      const before = await readFile(join(f.projectB, ".agents/skills/modified/SKILL.md"), "utf8");
      const p = await f.preview({
        kind: "merge-external-skill",
        sourceId: "fixture/tools",
        useId: use.id,
        choices: [{ path: "SKILL.md", choice }],
      });
      expect(p.steps.flatMap((step) => step.files)).toContainEqual(
        expect.objectContaining({
          relativePath: ".agents/skills/modified/binary.bin",
          change: "unchanged",
        }),
      );
      const result = await f.apply(p);
      expect(result.status).toBe("applied");
      expect(await readFile(join(f.projectB, ".agents/skills/modified/taken.txt"), "utf8")).toBe("New upstream file.");
      expect(await readFile(join(f.projectB, ".agents/skills/modified/kept.txt"), "utf8")).toBe("My local file.");
      expect(await readFile(join(f.projectB, ".agents/skills/modified/SKILL.md"), "utf8")).toBe(
        choice === "mine" ? before : await readFile(join(f.upstream, "skills/modified/SKILL.md"), "utf8"),
      );
      const refreshed = (await f.library.readSource("fixture/tools")).uses.find((item) => item.id === use.id)!;
      expect(refreshed).toMatchObject({ state: "modified", sourceChanged: false, lockHash: use.sourceHash });
      await f.apply(await f.preview({ kind: "restore", operationId: result.operationId }));
      await expect(readFile(join(f.projectB, ".agents/skills/modified/taken.txt"))).rejects.toThrow();
    },
  );
  it.each(["mine", "source"] as const)(
    "requires a whole-copy %s choice when the base cannot be recovered",
    async (wholeCopy) => {
      const f = await externalOperationFixture();
      const use = (await f.library.readSource("fixture/tools")).uses.find((use) => use.skillKey === "not-found")!;
      const request = {
        kind: "merge-external-skill",
        sourceId: "fixture/tools",
        useId: use.id,
        choices: [],
      } satisfies SkillIntent;
      expect((await f.service.preview(request, { kind: "desktop" })).status).toBe("blocked");
      const result = await f.apply(await f.preview({ ...request, wholeCopy }));
      expect(result.status).toBe("applied");
      const lock = JSON.parse(await readFile(join(f.projectB, "skills-lock.json"), "utf8"));
      expect(lock.skills["not-found"].computedHash).toBe(use.sourceHash);
      expect((await f.library.readSource("fixture/tools")).uses.find((item) => item.id === use.id)?.state).toBe(
        wholeCopy === "mine" ? "modified" : "up-to-date",
      );
    },
  );
  it("automatically updates two identical copies in one History row and restores both", async () => {
    const f = await externalOperationFixture();
    await cp(join(f.projectA, ".agents/skills/update"), join(f.projectB, ".agents/skills/update"), { recursive: true });
    const beforeA = await readFile(join(f.projectA, "skills-lock.json"), "utf8");
    const lock = JSON.parse(await readFile(join(f.projectB, "skills-lock.json"), "utf8"));
    lock.skills.update = JSON.parse(beforeA).skills.update;
    await write(f.projectB, "skills-lock.json", JSON.stringify(lock));
    const beforeB = await readFile(join(f.projectB, "skills-lock.json"), "utf8");
    const modifiedBefore = await readFile(join(f.projectB, ".agents/skills/modified/SKILL.md"), "utf8");
    await setUpdates(f.settings, "auto");
    const pass = await f.library.check();
    expect(pass.updates).toEqual([
      { sourceId: "fixture/tools", operationId: expect.any(String), copiesUpdated: 2, failedTargets: 0 },
    ]);
    expect(await readFile(join(f.projectA, ".agents/skills/update/SKILL.md"), "utf8")).toContain("Next.");
    expect(await readFile(join(f.projectB, ".agents/skills/update/SKILL.md"), "utf8")).toContain("Next.");
    expect(await readFile(join(f.projectB, ".agents/skills/modified/SKILL.md"), "utf8")).toBe(modifiedBefore);
    const history = await createOperationStore(join(f.data, "omni/operations.json")).read();
    if (history.status !== "ready") throw new Error("History unavailable.");
    const rows = history.receipts.filter((receipt) => receipt.kind === "skill-management");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provenance).toMatchObject({ approval: "automatic", reason: "automatique" });
    await f.apply(await f.preview({ kind: "restore", operationId: rows[0]!.operationId }));
    expect(await readFile(join(f.projectA, "skills-lock.json"), "utf8")).toBe(beforeA);
    expect(await readFile(join(f.projectB, "skills-lock.json"), "utf8")).toBe(beforeB);
  });
  it("ask performs no project writes and removed acknowledgements survive restart", async () => {
    const f = await externalOperationFixture();
    const before = await readFile(join(f.projectA, "skills-lock.json"), "utf8");
    expect((await f.library.check()).updates ?? []).toEqual([]);
    expect(await readFile(join(f.projectA, "skills-lock.json"), "utf8")).toBe(before);
    const use = (await f.library.readSource("fixture/tools")).uses.find((use) => use.state === "removed")!;
    await f.library.acknowledgeRemoved(use.id);
    expect((await f.library.readSource("fixture/tools")).uses.find((item) => item.id === use.id)?.acknowledged).toBe(
      true,
    );
    const restarted = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
    await restarted.check();
    expect((await restarted.readSource("fixture/tools")).uses.find((item) => item.id === use.id)?.acknowledged).toBe(
      true,
    );
    expect((await restarted.readSource("fixture/tools")).source?.counts.removed).toBe(0);
  });
  it("applies the automatic policy after an owner-triggered source check through Add", async () => {
    const f = await externalOperationFixture();
    await setUpdates(f.settings, "auto");
    const checked = await f.library.add("fixture/tools");
    expect(checked.uses.find((use) => use.skillKey === "update")?.state).toBe("up-to-date");
    expect((await f.library.list()).lastPass?.updates?.[0]).toMatchObject({
      sourceId: "fixture/tools",
      copiesUpdated: 1,
      failedTargets: 0,
    });
  });
});
