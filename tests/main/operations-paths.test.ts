import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { operationPaths } from "../../src/main/operations-paths";
import { parsePathsResponse } from "../../src/shared/operations-import-ipc";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn() };
});

let root: string;
let home: string;
let data: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "omni-operation-paths-")));
  home = join(root, "home");
  data = join(root, "data");
  await mkdir(home);
  await mkdir(join(data, "omni"), { recursive: true });
  vi.mocked(homedir).mockReturnValue(home);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it.each([
  ["home", "~"],
  ["home/Projects/acme-skills", "~/Projects/acme-skills"],
  ["home/..skills", "~/..skills"],
  ["outside/acme-skills", undefined],
  ["home-other/acme-skills", undefined],
])("shows the registered marketplace location at %s without inventing a home prefix", async (folder, display) => {
  const marketplace = join(root, folder);
  await mkdir(marketplace, { recursive: true });
  await writeFile(
    join(data, "omni/project-source-registry.json"),
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      projects: [],
      sources: [
        {
          id: "personal",
          displayName: "Demo skills",
          ownership: "personal",
          createdAt: "2026-10-16T00:00:00.000Z",
          locator: { kind: "local-directory", canonicalPath: marketplace },
        },
      ],
    }),
  );
  const paths = parsePathsResponse(await operationPaths(data, join(home, "operations.json")));
  expect(paths.marketplace?.displayRoot).toBe(display ?? marketplace);
  expect(paths.store.displayRoot).toBe("~/operations.json");
});
