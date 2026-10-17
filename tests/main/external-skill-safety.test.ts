import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { externalOperationFixture, setUpdates } from "../helpers/external-operations-fixture";
import { write, git, commit } from "../helpers/publication-fixture";
import { createOperationStore } from "../../src/main/operation-store";
import { folderHash } from "../helpers/external-library-fixture";
import { createExternalLibraryService } from "../../src/main/external-library/service";
vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused" },
  dialog: {},
  ipcMain: { handle: vi.fn() },
}));
// Real Git repositories and pushes, like the other operation integration suites.
vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

it.each(["__proto__", "constructor", "prototype"])(
  "installs and updates the %s skill without unsafe name-keyed records",
  async (skillName) => {
    const f = await externalOperationFixture();
    await write(
      f.upstream,
      `skills/${skillName}/SKILL.md`,
      `---\nname: ${skillName}\ndescription: Name fixture.\n---\nBase.\n`,
    );
    await commit(f.upstream);
    await git(f.upstream, "push", f.origin, "main");
    await f.library.check();
    const install = await f.apply(
      await f.preview({
        kind: "install-external-skill",
        sourceId: "fixture/tools",
        skillPath: `skills/${skillName}`,
        skillName,
        targets: [{ projectId: "project-a", harnessIds: ["codex"] }],
        conflict: "refuse",
      }),
    );
    expect(install.status).toBe("applied");
    const beforeLock = await readFile(join(f.projectA, "skills-lock.json"), "utf8");
    await write(
      f.upstream,
      `skills/${skillName}/SKILL.md`,
      `---\nname: ${skillName}\ndescription: Name fixture.\n---\nNext.\n`,
    );
    await commit(f.upstream);
    await git(f.upstream, "push", f.origin, "main");
    await f.library.check();
    const use = (await f.library.readSource("fixture/tools")).uses.find((use) => use.skillKey === skillName)!;
    expect(use.state).toBe("update");
    const updated = await f.apply(
      await f.preview({ kind: "update-external-skills", sourceId: "fixture/tools", useIds: [use.id] }),
    );
    expect(updated.status).toBe("applied");
    expect(
      Object.entries(JSON.parse(await readFile(join(f.projectA, "skills-lock.json"), "utf8")).skills).find(
        ([key]) => key === skillName,
      )?.[1],
    ).toMatchObject({ computedHash: await folderHash(f.projectA, `.agents/skills/${skillName}`) });
    await f.apply(await f.preview({ kind: "restore", operationId: updated.operationId }));
    expect(await readFile(join(f.projectA, "skills-lock.json"), "utf8")).toBe(beforeLock);
  },
);

it("restores from durable backup after restarting the operation service and keeps another source's later lock edit", async () => {
  const f = await externalOperationFixture();
  const result = await f.apply(
    await f.preview({
      kind: "install-external-skill",
      sourceId: "fixture/tools",
      skillPath: "skills/unused",
      skillName: "unused",
      targets: [{ projectId: "project-a", harnessIds: ["codex"] }],
      conflict: "refuse",
    }),
  );
  const lock = JSON.parse(await readFile(join(f.projectA, "skills-lock.json"), "utf8"));
  lock.skills.other = { source: "fixture/other", sourceType: "github", computedHash: "c".repeat(64) };
  await write(f.projectA, "skills-lock.json", JSON.stringify(lock));
  const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
  const restarted = registerOperationsIpcHandlers(() => undefined, f.registry, {
    userDataPath: f.data,
    homeDir: f.home,
    externalLibrary: f.library,
  }).skillManagement;
  await restarted.initialize();
  const p = await restarted.preview({ kind: "restore", operationId: result.operationId }, { kind: "desktop" });
  expect(p.status).toBe("ready");
  if (p.status !== "ready") throw new Error("Restore unavailable.");
  expect(
    (
      await restarted.apply(p.intentId, {
        kind: "desktop",
        effectFingerprint: p.effectFingerprint,
        approvedAt: new Date().toISOString(),
      })
    ).status,
  ).toBe("restored");
  const restored = JSON.parse(await readFile(join(f.projectA, "skills-lock.json"), "utf8"));
  expect(Object.hasOwn(restored.skills, "unused")).toBe(false);
  expect(restored.skills.other).toEqual(lock.skills.other);
});

it("refuses undo after local edits and refuses apply after a lock edit", async () => {
  const f = await externalOperationFixture();
  const request = {
    kind: "install-external-skill" as const,
    sourceId: "fixture/tools",
    skillPath: "skills/unused",
    skillName: "unused",
    targets: [{ projectId: "project-a", harnessIds: ["codex" as const] }],
    conflict: "refuse" as const,
  };
  const p = await f.preview(request);
  const before = await readFile(join(f.projectA, "skills-lock.json"), "utf8");
  await write(f.projectA, "skills-lock.json", before + "\n");
  expect((await f.apply(p)).status).toBe("failed");
  await expect(readFile(join(f.projectA, ".agents/skills/unused/SKILL.md"))).rejects.toThrow();
  const result = await f.apply(await f.preview(request));
  expect(result.status).toBe("applied");
  await write(f.projectA, ".agents/skills/unused/mine.txt", "Never overwrite this.");
  expect(
    (await f.service.preview({ kind: "restore", operationId: result.operationId }, { kind: "desktop" })).status,
  ).toBe("blocked");
  expect(await readFile(join(f.projectA, ".agents/skills/unused/mine.txt"), "utf8")).toBe("Never overwrite this.");
});

it("rolls back a failed automatic target and still updates another project from the same source", async () => {
  const f = await externalOperationFixture({
    fileWriter: async (path, value, options) => {
      if (path.includes("/project-a/skills-lock.json.")) throw new Error("Injected lock write failure.");
      await writeFile(path, value, options);
    },
  });
  await cp(join(f.projectA, ".agents/skills/update"), join(f.projectB, ".agents/skills/update"), { recursive: true });
  const lock = JSON.parse(await readFile(join(f.projectB, "skills-lock.json"), "utf8"));
  lock.skills.update = JSON.parse(await readFile(join(f.projectA, "skills-lock.json"), "utf8")).skills.update;
  await write(f.projectB, "skills-lock.json", JSON.stringify(lock));
  await setUpdates(f.settings, "auto");
  const result = await f.library.check();
  expect(result.result).toBe("partial");
  expect(result.updates?.[0]).toMatchObject({ copiesUpdated: 1, failedTargets: 1 });
  expect(await readFile(join(f.projectA, ".agents/skills/update/SKILL.md"), "utf8")).toContain("Base update.");
  expect(await readFile(join(f.projectB, ".agents/skills/update/SKILL.md"), "utf8")).toContain("Next.");
});
it("keeps a newly changed target visible without blocking the other target at preview", async () => {
  const f = await externalOperationFixture();
  await cp(join(f.projectA, ".agents/skills/update"), join(f.projectB, ".agents/skills/update"), { recursive: true });
  const lock = JSON.parse(await readFile(join(f.projectB, "skills-lock.json"), "utf8"));
  lock.skills.update = JSON.parse(await readFile(join(f.projectA, "skills-lock.json"), "utf8")).skills.update;
  await write(f.projectB, "skills-lock.json", JSON.stringify(lock));
  await f.library.refreshCopies();
  const useIds = (await f.library.readSource("fixture/tools")).uses
    .filter((use) => use.state === "update")
    .map((use) => use.id);
  await write(f.projectA, ".agents/skills/update/mine.txt", "Keep the new edit.");
  const p = await f.preview({ kind: "update-external-skills", sourceId: "fixture/tools", useIds });
  expect(p.steps.some((step) => step.plan.notes?.some((note) => note.includes("refused")))).toBe(true);
  expect((await f.apply(p)).status).toBe("partial");
  expect(await readFile(join(f.projectA, ".agents/skills/update/mine.txt"), "utf8")).toBe("Keep the new edit.");
  expect(await readFile(join(f.projectB, ".agents/skills/update/SKILL.md"), "utf8")).toContain("Next.");
});
it("keeps owner deletions of prototype-sensitive support files during a per-file merge", async () => {
  const f = await externalOperationFixture();
  const names = ["__proto__", "constructor", "prototype"];
  await write(
    f.upstream,
    "skills/safe-files/SKILL.md",
    "---\nname: safe-files\ndescription: Support file fixture.\n---\nBase.\n",
  );
  for (const name of names) await write(f.upstream, `skills/safe-files/${name}`, "Base support.");
  await commit(f.upstream);
  await git(f.upstream, "push", f.origin, "main");
  await f.library.check();
  await f.apply(
    await f.preview({
      kind: "install-external-skill",
      sourceId: "fixture/tools",
      skillPath: "skills/safe-files",
      skillName: "safe-files",
      targets: [{ projectId: "project-a", harnessIds: ["codex"] }],
      conflict: "refuse",
    }),
  );
  for (const name of names) {
    await rm(join(f.projectA, `.agents/skills/safe-files/${name}`));
    await write(f.upstream, `skills/safe-files/${name}`, "Changed support.");
  }
  await commit(f.upstream);
  await git(f.upstream, "push", f.origin, "main");
  await f.library.check();
  const use = (await f.library.readSource("fixture/tools")).uses.find((use) => use.skillKey === "safe-files")!;
  const result = await f.apply(
    await f.preview({
      kind: "merge-external-skill",
      sourceId: "fixture/tools",
      useId: use.id,
      choices: names.map((path) => ({ path, choice: "mine" })),
    }),
  );
  expect(result.status).toBe("applied");
  for (const name of names)
    await expect(readFile(join(f.projectA, `.agents/skills/safe-files/${name}`))).rejects.toThrow();
});

it("reuses marketplace import and reversible project deletion for a removed external skill", async () => {
  const f = await externalOperationFixture();
  const personal = join(f.root, "personal");
  await mkdir(personal);
  expect((await f.registry.registerSourceByPath(personal, "Personal")).status).toBe("ready");
  const handle = await f.registry.getGrantForEntry({ kind: "project", id: "project-a" });
  const imported = await f.operations.previewOperation({
    kind: "import-artifact",
    source: { kind: "project", id: "project-a", grantHandle: handle },
    relativePath: ".agents/skills/removed",
    target: { newPackageName: "My tools", description: "My retained external skill." },
  });
  expect(imported.status, JSON.stringify(imported)).toBe("ready");
  if (imported.status !== "ready") throw new Error("Import unavailable.");
  expect((await f.operations.applyOperation({ planId: imported.plan.planId }))?.status).toBe("applied");
  const rows = await f.service.readProjectSkills!("project-a");
  const row = rows.skills.find((row) => row.name === "removed")!;
  const deletion = await f.apply(
    await f.preview({ kind: "project-skill", projectId: "project-a", rowId: row.id, action: "delete" }),
  );
  expect(deletion.status).toBe("applied");
  await expect(readFile(join(f.projectA, ".agents/skills/removed/SKILL.md"))).rejects.toThrow();
  expect((await f.apply(await f.preview({ kind: "restore", operationId: deletion.operationId }))).status).toBe(
    "restored",
  );
  expect(await readFile(join(f.projectA, ".agents/skills/removed/SKILL.md"), "utf8")).toContain("Base removed.");
  const history = await createOperationStore(join(f.data, "omni/operations.json")).read();
  expect(history.status).toBe("ready");
});
it("retains a merged copy matching an older published version and recovers HEAD as the next base", async () => {
  const f = await externalOperationFixture();
  const initialUpdate = await readFile(join(f.projectA, ".agents/skills/update/SKILL.md"));
  const initialEntry = JSON.parse(await readFile(join(f.projectA, "skills-lock.json"), "utf8")).skills.update;
  const skill = "skills/retained",
    copy = ".agents/skills/retained";
  const body = (version: string) => `---\nname: retained\ndescription: Retention fixture.\n---\n${version}.\n`;
  await write(f.upstream, `${skill}/SKILL.md`, body("Base"));
  await write(f.upstream, `${skill}/support.txt`, "Base support.");
  await commit(f.upstream);
  await git(f.upstream, "push", f.origin, "main");
  await f.library.check();
  await f.apply(
    await f.preview({
      kind: "install-external-skill",
      sourceId: "fixture/tools",
      skillPath: skill,
      skillName: "retained",
      targets: [{ projectId: "project-a", harnessIds: ["codex"] }],
      conflict: "refuse",
    }),
  );
  await write(f.upstream, `${skill}/SKILL.md`, body("Older"));
  await write(f.upstream, `${skill}/support.txt`, "Published support.");
  await commit(f.upstream);
  await write(f.upstream, `${skill}/SKILL.md`, body("Head"));
  const head = await commit(f.upstream);
  await git(f.upstream, "push", f.origin, "main");
  await write(f.projectA, `${copy}/SKILL.md`, body("Older"));
  await write(f.projectA, `${copy}/support.txt`, "Unpublished support.");
  await f.library.check();
  const use = (await f.library.readSource("fixture/tools")).uses.find((use) => use.skillKey === "retained")!;
  expect(use.state).toBe("modified");
  const merged = await f.apply(
    await f.preview({
      kind: "merge-external-skill",
      sourceId: "fixture/tools",
      useId: use.id,
      choices: [
        { path: "SKILL.md", choice: "mine" },
        { path: "support.txt", choice: "source" },
      ],
    }),
  );
  expect(merged.status).toBe("applied");
  expect((await f.library.readSource("fixture/tools")).uses.find((item) => item.id === use.id)).toMatchObject({
    state: "modified",
    sourceChanged: false,
  });
  const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
  const restart = () => {
    const library = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
    const operations = registerOperationsIpcHandlers(() => undefined, f.registry, {
      userDataPath: f.data,
      homeDir: f.home,
      externalLibrary: library,
    });
    return { library, operations };
  };
  const restarted = restart();
  await restarted.library.check();
  expect((await restarted.library.readSource("fixture/tools")).uses.find((item) => item.id === use.id)?.state).toBe(
    "modified",
  );
  await write(f.upstream, `${skill}/SKILL.md`, body("Next"));
  await commit(f.upstream);
  await git(f.upstream, "push", f.origin, "main");
  await setUpdates(f.settings, "auto");
  await restarted.library.check();
  expect(await readFile(join(f.projectA, `${copy}/SKILL.md`), "utf8")).toBe(body("Older"));
  expect((await restarted.library.compare(use.id)).base).toMatchObject({ status: "found", commit: head });
  const evidence = merged.receipts![0]!.externalSkill!;
  const backupPath = join(f.data, evidence.backupPath),
    backup = await readFile(backupPath);
  await writeFile(backupPath, "corrupt");
  await cp(join(f.projectA, ".agents/skills/update"), join(f.projectB, ".agents/skills/update"), { recursive: true });
  await writeFile(join(f.projectB, ".agents/skills/update/SKILL.md"), initialUpdate);
  const lock = JSON.parse(await readFile(join(f.projectB, "skills-lock.json"), "utf8"));
  lock.skills.update = initialEntry;
  await write(f.projectB, "skills-lock.json", JSON.stringify(lock));
  const unavailable = restart();
  expect((await unavailable.library.check()).result).toBe("partial");
  expect((await unavailable.library.readSource("fixture/tools")).uses.find((item) => item.id === use.id)?.state).toBe(
    "unknown",
  );
  expect(
    (await unavailable.operations.skillManagement.readProjectSkills!("project-a")).skills.find(
      (row) => row.name === "retained",
    )?.state,
  ).toBe("unknown");
  expect(await readFile(join(f.projectA, `${copy}/SKILL.md`), "utf8")).toBe(body("Older"));
  expect(await readFile(join(f.projectB, ".agents/skills/update/SKILL.md"), "utf8")).toContain("Next.");
  await writeFile(backupPath, backup);
  await unavailable.library.check();
  expect((await unavailable.library.readSource("fixture/tools")).uses.find((item) => item.id === use.id)?.state).toBe(
    "modified",
  );
}, 20000);
