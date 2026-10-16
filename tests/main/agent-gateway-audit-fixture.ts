import { readdir, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import type { AgentRouter } from "../../src/main/agent-gateway/server";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import type { RegistryIpcServices } from "../../src/main/registry-ipc";
import type { MockInstance } from "vitest";
import type { Binding } from "../../src/domain/assignment-plan";

const roots: string[] = [];
// Full-suite filesystem contention needs the same budget as external-library fixtures.
export const FIXTURE_TIMEOUT_MS = 60_000;
export async function skill(root: string, folder: string, name: string, body = name): Promise<void> {
  await mkdir(join(root, folder), { recursive: true });
  await writeFile(
    join(root, folder, "SKILL.md"),
    `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n${body}\n`,
  );
  await writeFile(join(root, folder, "notes.md"), "Supporting evidence\n");
}
export async function fixture(fullScope: boolean | "realistic" = false): Promise<{
  router: AgentRouter;
  projectId: string;
  missingId: string;
  archivedId: string;
  registry: RegistryIpcServices;
  project: string;
  marketplace: string;
  userDataPath: string;
  observe: MockInstance<RegistryIpcServices["observeRegisteredEntry"]>;
  preview: ReturnType<typeof vi.fn>;
  bindings: Binding[];
}> {
  vi.resetModules();
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-audit-")));
  roots.push(root);
  const project = join(root, "acme-app");
  const missing = join(root, "missing-project");
  const archived = join(root, "archived-project");
  const marketplace = join(root, "marketplace");
  const userDataPath = join(root, "profile");
  await Promise.all([project, missing, archived, marketplace].map((path) => mkdir(path)));
  await skill(project, ".agents/skills/review", "review", "Local review");
  await mkdir(join(project, ".claude/skills"), { recursive: true });
  await symlink("../../.agents/skills/review", join(project, ".claude/skills/review"));
  await skill(project, ".agents/skills/handoff", "handoff");
  await skill(project, ".agents/skills/duplicate", "duplicate", "Shared content");
  await writeFile(
    join(marketplace, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "fixture-marketplace",
      skills: "./skills",
    }),
  );
  await skill(marketplace, "skills/review", "review", "Marketplace review");
  await skill(marketplace, "skills/handoff", "handoff", "Marketplace handoff");
  await skill(marketplace, "skills/alias", "duplicate", "Shared content");
  // Identical trees can declare a folder alias without changing SKILL.md.
  await mkdir(join(project, ".agents/skills/alias"), { recursive: true });
  await writeFile(
    join(project, ".agents/skills/alias/SKILL.md"),
    await readFile(join(project, ".agents/skills/duplicate/SKILL.md")),
  );
  await writeFile(join(project, ".agents/skills/alias/notes.md"), "Supporting evidence\n");
  await writeFile(
    join(project, "skills-lock.json"),
    JSON.stringify({
      version: 1,
      skills: {
        handoff: {
          source: "example/skills",
          sourceType: "github",
          computedHash: "a".repeat(64),
          skillPath: "skills/handoff",
        },
      },
    }),
  );
  if (fullScope) {
    for (let index = 0; index < 41; index++) {
      await skill(project, `.agents/skills/project-skill-${index}`, `project-skill-${index}`);
      await symlink(
        `../../.agents/skills/project-skill-${index}`,
        join(project, `.claude/skills/project-skill-${index}`),
      );
    }
    for (let index = 0; index < (fullScope === "realistic" ? 80 : 63); index++)
      await skill(marketplace, `skills/market-skill-${index}`, `market-skill-${index}`);
  }
  if (fullScope === "realistic") {
    for (const directory of [join(project, ".agents/skills"), join(marketplace, "skills")]) {
      for (const folder of await readdir(directory)) {
        const path = join(directory, folder, "SKILL.md");
        const text = await readFile(path, "utf8");
        await writeFile(
          path,
          text.replace(
            /description:.*\n/u,
            `description: ${"Use when auditing overlapping responsibilities and preserving project constraints. ".repeat(4)}\n`,
          ),
        );
      }
    }
  }
  const handlers = new Map<string, (event: unknown, request: unknown) => Promise<any>>();
  let selected = project;
  vi.doMock("electron", () => ({
    app: { getPath: () => userDataPath, getVersion: () => "test", isPackaged: false },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
    ipcMain: { handle: (channel: string, handler: any) => handlers.set(channel, handler) },
  }));
  const { registerRegistryIpcHandlers } = await import("../../src/main/registry-ipc");
  const registry = registerRegistryIpcHandlers(() => undefined, { userDataPath });
  const register = async (path: string): Promise<string> => {
    selected = path;
    return (await handlers.get("omni:registry:register-project")!({}, {})).entry.ref.id;
  };
  const projectId = await register(project);
  const missingId = await register(missing);
  const archivedId = await register(archived);
  const state = await registry.listRegistry();
  if (state.status !== "ready") throw new Error("Fixture registry failed.");
  await handlers.get("omni:registry:archive-entry")!(
    {},
    { kind: "project", id: archivedId, expectedRevision: state.registry.revision },
  );
  const source = await registry.registerSourceByPath(marketplace, "Fixture marketplace");
  if (source.status !== "ready") throw new Error("Fixture marketplace failed.");
  const bindings: Binding[] = [
    {
      bindingId: "stale",
      sourceId: source.entry.ref.id,
      packageId: "implicit-root",
      artifactPath: "skills/gone",
      kind: "skill",
      projectId,
      harnessId: "codex",
      boundHash: "a".repeat(64),
      createdAt: "2026-10-13T00:00:00Z",
    },
    {
      bindingId: "unavailable",
      sourceId: source.entry.ref.id,
      packageId: "implicit-root",
      artifactPath: "skills/review",
      kind: "skill",
      projectId: missingId,
      harnessId: "codex",
      boundHash: "a".repeat(64),
      createdAt: "2026-10-13T00:00:00Z",
    },
  ];
  const store = createBindingsStore(bindingsFilePath(userDataPath));
  await store.save(bindings);
  await rm(missing, { recursive: true });
  const observe = vi.spyOn(registry, "observeRegisteredEntry");
  const preview = vi.fn(async () => ({ status: "ready", plans: [] }));
  const { createAgentRouter } = await import("../../src/main/agent-gateway/router");
  const router = createAgentRouter({
    userDataPath,
    registry,
    appVersion: "test",
    operations: {} as never,
    bindings: { previewBindings: preview } as never,
    requests: createAgentRequestsStore(join(userDataPath, "omni/agent-requests.json")),
  });
  return {
    registry,
    router,
    projectId,
    missingId,
    archivedId,
    project,
    marketplace,
    userDataPath,
    observe,
    preview,
    bindings,
  };
}
afterEach(async () => {
  vi.doUnmock("electron");
  vi.resetModules();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
