import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { externalRichSkillFixture } from "../helpers/external-rich-skill-fixture";
import { setUpdates } from "../helpers/external-operations-fixture";
import { write, commit, git } from "../helpers/publication-fixture";
import { captureExactSkillTree } from "../../src/main/skill-management/project-skill-files";
import { planExternalSkillTargets } from "../../src/main/external-library/operation-planning";
import { createOperationStore } from "../../src/main/operation-store";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused" },
  dialog: {},
  ipcMain: { handle: vi.fn() },
}));

it("plans nested application entries in capture order with identical paths, kinds, modes and bytes", async () => {
  const f = await externalRichSkillFixture();
  const observation = await f.library.operationObservation();
  const root = observation.roots.get("fixture/tools")!;
  const plans = await planExternalSkillTargets(
    {
      userDataPath: f.data,
      registry: f.registry,
      library: f.library,
      operationStore: createOperationStore(join(f.data, "omni/operations.json")),
      journal: createSkillOperationJournal(f.data),
    },
    {
      kind: "install-external-skill",
      sourceId: "fixture/tools",
      skillPath: "skills/screenshots",
      skillName: "screenshots",
      targets: [{ projectId: "project-b", harnessIds: ["codex"] }],
      conflict: "refuse",
    },
    "review-tree",
  );
  const expected = await captureExactSkillTree(root, "skills/screenshots");
  const planned = plans[0]!.backup.layouts[0]!.after!;
  expect(planned.length).toBeGreaterThan(100);
  expect(new Map(planned.map((entry) => [entry.path, entry]))).toEqual(
    new Map(expected!.map((entry) => [entry.path, entry])),
  );
  expect(planned).toEqual(expected);
}, 60000);

it("automatically updates and restores a nested application skill byte-for-byte", async () => {
  const f = await externalRichSkillFixture();
  const before = await captureExactSkillTree(f.projectA, ".agents/skills/screenshots");
  const lock = await readFile(join(f.projectA, "skills-lock.json"));
  await setUpdates(f.settings, "auto");
  const pass = await f.library.check();
  expect(pass.updates?.[0]).toMatchObject({ copiesUpdated: 2, failedTargets: 0 });
  const use = (await f.library.readSource("fixture/tools")).uses.find((use) => use.skillKey === "screenshots");
  expect(use).toMatchObject({ state: "up-to-date", copyHash: use?.lockHash });
  await f.apply(await f.preview({ kind: "restore", operationId: pass.updates![0]!.operationId! }));
  expect(await captureExactSkillTree(f.projectA, ".agents/skills/screenshots")).toEqual(before);
  expect(await readFile(join(f.projectA, "skills-lock.json"))).toEqual(lock);
}, 60000);

it("installs the nested application skill and restores the original lock and absent folder", async () => {
  const f = await externalRichSkillFixture();
  const before = await readFile(join(f.projectB, "skills-lock.json"));
  const installed = await f.apply(
    await f.preview({
      kind: "install-external-skill",
      sourceId: "fixture/tools",
      skillPath: "skills/screenshots",
      skillName: "screenshots",
      targets: [{ projectId: "project-b", harnessIds: ["codex"] }],
      conflict: "refuse",
    }),
  );
  expect(installed.status).toBe("applied");
  const observation = await f.library.operationObservation();
  expect(await captureExactSkillTree(f.projectB, ".agents/skills/screenshots")).toEqual(
    await captureExactSkillTree(observation.roots.get("fixture/tools")!, "skills/screenshots"),
  );
  await f.apply(await f.preview({ kind: "restore", operationId: installed.operationId }));
  expect(await captureExactSkillTree(f.projectB, ".agents/skills/screenshots")).toBeUndefined();
  expect(await readFile(join(f.projectB, "skills-lock.json"))).toEqual(before);
}, 60000);

it("merges upstream and local changes in the nested application skill with exact restoration", async () => {
  const f = await externalRichSkillFixture();
  const installed = await f.apply(
    await f.preview({
      kind: "install-external-skill",
      sourceId: "fixture/tools",
      skillPath: "skills/screenshots",
      skillName: "screenshots",
      targets: [{ projectId: "project-b", harnessIds: ["codex"] }],
      conflict: "refuse",
    }),
  );
  expect(installed.status).toBe("applied");
  await write(f.projectB, ".agents/skills/screenshots/mine.txt", "Keep my file\n");
  await write(f.upstream, "skills/screenshots/template/files/source-only.txt", "Take upstream\n");
  await commit(f.upstream, "Merge nested application change");
  await git(f.upstream, "push", f.origin, "main");
  await f.library.check();
  const before = await captureExactSkillTree(f.projectB, ".agents/skills/screenshots");
  const lock = await readFile(join(f.projectB, "skills-lock.json"));
  const use = (await f.library.readSource("fixture/tools")).uses.find(
    (use) => use.projectId === "project-b" && use.skillKey === "screenshots",
  )!;
  const merged = await f.apply(
    await f.preview({ kind: "merge-external-skill", sourceId: "fixture/tools", useId: use.id, choices: [] }),
  );
  expect(merged.status).toBe("applied");
  const after = await captureExactSkillTree(f.projectB, ".agents/skills/screenshots");
  expect(after!.filter((entry) => entry.path !== "template/files/source-only.txt")).toEqual(before);
  expect(await readFile(join(f.projectB, ".agents/skills/screenshots/template/files/source-only.txt"), "utf8")).toBe(
    "Take upstream\n",
  );
  await f.apply(await f.preview({ kind: "restore", operationId: merged.operationId }));
  expect(await captureExactSkillTree(f.projectB, ".agents/skills/screenshots")).toEqual(before);
  expect(await readFile(join(f.projectB, "skills-lock.json"))).toEqual(lock);
}, 60000);
