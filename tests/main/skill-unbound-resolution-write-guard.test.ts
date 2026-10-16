import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SkillJournalAction } from "../../src/application/skill-management-journal";
import { setup } from "../ipc/apply-ipc-helpers";
import { createOwnedDirectory, writeOwnedFile } from "../../src/main/skill-management/unbound-file-effects";

const racing = vi.hoisted(() => ({ target: "", kind: "file", fired: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const occupy = async (path: unknown): Promise<void> => {
    if (path !== racing.target || racing.fired) return;
    racing.fired = true;
    if (racing.kind === "file") await fs.writeFile(racing.target, "Foreign concurrent bytes.\n");
    else await fs.mkdir(racing.target);
  };
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await occupy(args[1]);
      return fs.rename(...args);
    },
    link: async (...args: Parameters<typeof fs.link>) => {
      await occupy(args[1]);
      return fs.link(...args);
    },
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      await occupy(args[0]);
      return fs.mkdir(...args);
    },
  };
});

afterEach(() => {
  racing.target = "";
  racing.fired = false;
});

it("preserves a foreign file that appears at the publication boundary of an absent destination", async () => {
  const fixture = await setup();
  const relativePath = ".agents/skills/demo/new.md";
  await mkdir(join(fixture.projectRoot, ".agents/skills/demo"), { recursive: true });
  racing.target = join(await realpath(fixture.projectRoot), relativePath);
  racing.kind = "file";
  const actions: SkillJournalAction[] = [];
  const outcome = await writeOwnedFile({
    grant: fixture.projectGrant,
    relativePath,
    bytes: Buffer.from("Approved source bytes.\n"),
    actions,
    progress: async () => undefined,
    beforeEffect: async () => undefined,
  }).catch((error: unknown) => error);
  expect(racing.fired).toBe(true);
  expect(outcome).toBeInstanceOf(Error);
  expect(await readFile(racing.target, "utf8")).toBe("Foreign concurrent bytes.\n");
  expect(actions.some((action) => action.status === "applied")).toBe(false);
});

it("preserves a foreign empty directory that appears at the publication boundary", async () => {
  const fixture = await setup();
  const relativePath = ".agents/skills/demo/new";
  await mkdir(join(fixture.projectRoot, ".agents/skills/demo"), { recursive: true });
  racing.target = join(await realpath(fixture.projectRoot), relativePath);
  racing.kind = "directory";
  const actions: SkillJournalAction[] = [];
  const outcome = await createOwnedDirectory({
    grant: fixture.projectGrant,
    relativePath,
    actions,
    progress: async () => undefined,
    beforeEffect: async () => undefined,
  }).catch((error: unknown) => error);
  expect(racing.fired).toBe(true);
  expect(outcome).toBeInstanceOf(Error);
  expect((await stat(racing.target)).isDirectory()).toBe(true);
  expect(actions.some((action) => action.status === "applied")).toBe(false);
});
