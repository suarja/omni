import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLocalJsonRegistryStore } from "../../src/adapters/registry/local-json";
import { registerSource } from "../../src/domain/project-source-registry";
import { createOperationStore } from "../../src/main/operation-store";
import { systemGitCli } from "../../src/main/git-cli";
import { createPublicationOperations } from "../../src/main/storefronts/operations";
import type { GhCli } from "../../src/main/gh-cli";
const exec = promisify(execFile);
export async function git(root: string, ...args: string[]): Promise<string> {
  return (
    await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
  ).stdout.trim();
}
export async function write(root: string, path: string, text: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
export async function commit(root: string, message = "Fixture"): Promise<string> {
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Fixture", "-c", "user.email=ada@example.com", "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}
export async function publicationFixture(gh?: GhCli) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-publication-")));
  const workshop = join(root, "workspace", "workshop");
  const storefront = join(root, "storefront");
  const data = join(root, "profile");
  const origin = join(root, "origin.git");
  await mkdir(workshop, { recursive: true });
  await mkdir(storefront);
  await git(root, "init", "--bare", origin);
  for (const repo of [workshop, storefront]) await git(repo, "init", "-q", "-b", "main");
  // Remote identity is read only. Tests never fetch or push the workshop.
  await git(workshop, "remote", "add", "origin", "https://github.com/fixture/workshop.git");
  await git(storefront, "remote", "add", "origin", origin);
  await write(
    workshop,
    "packages/demo/omni.plugin.json",
    JSON.stringify({
      format: "omni.plugin/1",
      id: "demo",
      name: "demo",
      version: "1.0.0",
      description: "Use the demo plugin.",
      artifacts: [{ kind: "skill", path: "skills/demo" }],
    }),
  );
  await write(
    workshop,
    "packages/demo/skills/demo/SKILL.md",
    "---\nname: demo\ndescription: Use when testing a demo project.\n---\n\n# Demo\n\nUse the project files to test the application.\n",
  );
  for (const path of ["same.txt", "workshop.txt", "storefront.txt", "conflict-a.txt", "conflict-b.txt", "removed.txt"])
    await write(workshop, `packages/demo/${path}`, "base\n");
  await write(
    workshop,
    "omni.marketplace.json",
    JSON.stringify({
      format: "omni.marketplace/1",
      id: "workshop",
      name: "Workshop",
      packages: [{ path: "packages/demo" }],
      createdAt: "2026-10-12T10:00:00.000Z",
      createdBy: "fixture",
    }),
  );
  const workshopCommit = await commit(workshop);
  await write(storefront, "LICENSE", "MIT License\n");
  await write(
    storefront,
    "README.md",
    "# Fixture\n\nKeep this introduction.\n\n## Plugins\n\nLegacy text.\n\n## Install\n\nKeep this installation.\n",
  );
  for (const path of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"])
    await write(storefront, path, JSON.stringify({ name: "storefront", owner: { name: "fixture" }, plugins: [] }));
  await commit(storefront);
  const registry = createLocalJsonRegistryStore(join(data, "omni/project-source-registry.json"));
  await registry.mutate(
    0,
    (state) =>
      registerSource(state, {
        id: "workshop",
        displayName: "Workshop",
        canonicalPath: workshop,
        ownership: "personal",
        role: "workshop",
        createdAt: "2026-10-12T10:00:00.000Z",
      }).nextState,
  );
  await registry.mutate(
    1,
    (state) =>
      registerSource(state, {
        id: "storefront",
        displayName: "Storefront",
        canonicalPath: storefront,
        ownership: "personal",
        role: "storefront",
        createdAt: "2026-10-12T10:00:00.000Z",
      }).nextState,
  );
  const store = createOperationStore(join(data, "omni/operations.json"));
  const options = {
    userDataPath: data,
    operationStore: store,
    git: systemGitCli,
    gh: gh ?? {
      available: async () => false,
      login: async () => undefined,
      repoCreate: async () => {
        throw new Error("GitHub forbidden in tests");
      },
    },
    now: () => Date.parse("2026-10-12T10:00:00.000Z"),
    homeDirectory: "/fixture/owner-home",
  };
  const operations = createPublicationOperations(options);
  return { root, workshop, storefront, data, origin, registry, store, operations, options, workshopCommit };
}
