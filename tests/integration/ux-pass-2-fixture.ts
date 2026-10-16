import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import { root, run } from "../ipc/apply-ipc-helpers";
import { parseRegisterProjectResponse } from "../../src/shared/registry-ipc";
import type { RegistryIpcServices } from "../../src/main/registry-ipc";
import type { SkillManagementService } from "../../src/application/skill-management";
import type { ProjectSkills } from "../../src/shared/project-skills-ipc";
import { projectMarketplaceEntry, projectPluginManifest } from "../../src/domain/harness-projection";
import { createPackageManifest } from "../../src/domain/marketplace-format";

export type UxPass2Fixture = Readonly<{
  fixtureRoot: string;
  userDataPath: string;
  agentHomePath: string;
  sourceRoot: string;
  sourceId: string;
  unregisteredProjectRoot: string;
  projects: readonly Readonly<{ id: string; name: "alpha" | "beta"; root: string; skills: ProjectSkills }>[];
}>;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

async function writeSkill(path: string, name: string, description: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\n${description}\n`,
  );
  await writeFile(join(path, "notes.md"), "Reception support file.\n");
}

type RegisteredProject = Readonly<{ id: string; name: "alpha" | "beta"; root: string; grantHandle: string }>;

async function createMarketplace(sourceRoot: string): Promise<void> {
  const plugins = [
    { name: "workbench", description: "Tools for reviewing and improving project code.", skills: ["review"] },
    { name: "design", description: "Skills for polishing product interfaces.", skills: ["polish", "audit"] },
    { name: "build-to-show", skills: ["share"] },
  ];
  await writeJson(join(sourceRoot, "omni.marketplace.json"), {
    format: "omni.marketplace/1",
    id: "ux2-marketplace",
    name: "ux2-marketplace",
    visibility: "private",
    createdAt: "2026-10-12T00:00:00.000Z",
    createdBy: "omni-desktop/test",
    packages: plugins.map(({ name }) => ({ path: `packages/${name}` })),
  });
  for (const plugin of plugins) {
    const path = join(sourceRoot, "packages", plugin.name);
    const manifest = createPackageManifest({
      id: plugin.name,
      name: plugin.name,
      version: "0.1.0",
      artifacts: plugin.skills.map((name) => ({ kind: "skill", path: `skills/${name}` })),
      ...(plugin.description ? { description: plugin.description } : {}),
    });
    await writeJson(join(path, "omni.plugin.json"), manifest);
    await writeJson(join(path, ".claude-plugin/plugin.json"), projectPluginManifest(manifest, "claude-code"));
    await writeJson(join(path, ".codex-plugin/plugin.json"), projectPluginManifest(manifest, "codex"));
    for (const skill of plugin.skills)
      await writeSkill(join(path, "skills", skill), skill, `Use ${skill} in a project.`);
  }
  for (const [harness, path] of [
    ["claude-code", ".claude-plugin/marketplace.json"],
    ["codex", ".agents/plugins/marketplace.json"],
  ] as const) {
    await writeJson(join(sourceRoot, path), {
      name: "ux2-marketplace",
      description: "An isolated personal plugin registry.",
      ...(harness === "claude-code"
        ? { metadata: { description: "An isolated personal plugin registry." } }
        : { interface: { displayName: "UX2 Agent Plugins" } }),
      owner: { name: "Omni Fixture" },
      plugins: plugins.map((plugin) =>
        projectMarketplaceEntry(
          createPackageManifest({
            id: plugin.name,
            name: plugin.name,
            description: plugin.description,
            artifacts: plugin.skills.map((name) => ({ kind: "skill", path: `skills/${name}` })),
          }),
          `packages/${plugin.name}`,
          harness,
        ),
      ),
    });
  }
  await run("git", ["init", "-q", sourceRoot]);
  await run("git", ["-C", sourceRoot, "config", "user.name", "Omni Fixture"]);
  await run("git", ["-C", sourceRoot, "config", "user.email", "ada@example.com"]);
  await run("git", ["-C", sourceRoot, "-c", "core.hooksPath=/dev/null", "add", "."]);
  await run("git", [
    "-C",
    sourceRoot,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "user.name=Omni Fixture",
    "-c",
    "user.email=ada@example.com",
    "commit",
    "-qm",
    "Seed UX pass 2 marketplace",
  ]);
}

async function writeProjectCopies(name: "alpha" | "beta", projectRoot: string, sourceRoot: string): Promise<void> {
  const harnesses = name === "alpha" ? [".claude", ".agents"] : [".claude"];
  for (const harness of harnesses) {
    const target = join(projectRoot, harness, "skills", "review");
    await mkdir(join(target, ".."), { recursive: true });
    await cp(join(sourceRoot, "packages/workbench/skills/review"), target, { recursive: true });
  }
  if (name === "alpha") {
    await writeSkill(
      join(projectRoot, ".claude/skills/local-tool"),
      "local-tool",
      "A skill kept only in this project.",
    );
    for (const harness of [".claude", ".agents"])
      await writeSkill(
        join(projectRoot, harness, "skills/grill-me"),
        "grill-me",
        "Ask focused questions about an implementation plan.",
      );
    await writeJson(join(projectRoot, "skills-lock.json"), {
      version: 1,
      skills: {
        "grill-me": {
          source: "mattpocock/skills",
          sourceType: "github",
          ref: "main",
          skillPath: "skills/grill-me",
          computedHash: "a".repeat(64),
        },
      },
    });
  }
}

async function registerRoots(
  userDataPath: string,
  fixtureRoot: string,
  sourceRoot: string,
): Promise<
  Readonly<{
    registry: RegistryIpcServices;
    sourceId: string;
    registrations: readonly RegisteredProject[];
  }>
> {
  let selectedRoot = "";
  const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
  vi.resetModules();
  vi.doMock("electron", () => ({
    app: { getPath: () => userDataPath, isPackaged: false },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selectedRoot] }) },
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
        handlers.set(channel, handler),
    },
  }));
  const { registerRegistryIpcHandlers } = await import("../../src/main/registry-ipc");
  const registry = registerRegistryIpcHandlers(() => undefined, {
    userDataPath,
    directoryPicker: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [selectedRoot] }),
    },
  });
  const source = await registry.registerSourceByPath(sourceRoot, "ux2-marketplace");
  if (source.status !== "ready") throw new Error("The UX2 marketplace could not be registered.");
  const registrations = [];
  for (const name of ["alpha", "beta"] as const) {
    selectedRoot = join(fixtureRoot, name);
    await mkdir(selectedRoot);
    const response = parseRegisterProjectResponse(await handlers.get("omni:registry:register-project")!({}, {}));
    if (response.status !== "ready") throw new Error("The UX2 project could not be registered.");
    await writeProjectCopies(name, selectedRoot, sourceRoot);
    registrations.push({ id: response.entry.ref.id, name, root: selectedRoot, grantHandle: response.grantHandle });
  }
  return { registry, sourceId: source.entry.ref.id, registrations };
}

async function observeReview(project: RegisteredProject, registry: RegistryIpcServices, userDataPath: string) {
  const { observeProjectCopies } = await import("../../src/main/skill-reconciliation/ipc");
  const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
  const { createSkillBaseStore } = await import("../../src/main/skill-reconciliation/bases");
  const store = createSkillRelationshipStore(join(userDataPath, "omni/skill-relationships.json"));
  const observed = await registry.observeEntryWithGrant({ kind: "project", id: project.id }, project.grantHandle);
  if (observed.status !== "observed") throw new Error("The UX2 project inventory could not be observed.");
  const members = observed.observation.inventory.artifacts
    .filter((artifact) => artifact.kind === "skill" && artifact.relativePath.endsWith("/review/SKILL.md"))
    .map((artifact) => ({
      ref: {
        kind: "artifact" as const,
        entry: { kind: "project" as const, id: project.id },
        artifactId: artifact.id,
      },
      relativePath: artifact.relativePath,
    }));
  const correlated = await observeProjectCopies(
    { projectId: project.id, grantHandle: project.grantHandle, groups: [{ groupId: "review", members }] },
    registry,
    store,
    createSkillBaseStore(userDataPath),
    Date.now,
  );
  const skillId = correlated.status === "ready" ? correlated.groups[0]?.correlation.groups[0]?.skillId : undefined;
  if (!skillId) throw new Error("The UX2 owned skill could not be correlated.");
  return { skillId, members };
}

async function adoptOwnedSkill(
  project: RegisteredProject,
  registry: RegistryIpcServices,
  service: SkillManagementService,
  sourceId: string,
  userDataPath: string,
): Promise<void> {
  const { skillId, members } = await observeReview(project, registry, userDataPath);
  const preview = await service.preview(
    {
      kind: "reconcile",
      request: {
        choice: "adopt-exact",
        skillId,
        source: { sourceId: sourceId, packageId: "packages/workbench", artifactPath: "skills/review" },
        locations: members.map(({ relativePath }) => ({
          projectId: project.id,
          harnessId: relativePath.startsWith(".claude") ? ("claude-code" as const) : ("codex" as const),
          folderPath: relativePath.slice(0, -"/SKILL.md".length),
        })),
      },
    },
    { kind: "desktop" },
  );
  if (preview.status !== "ready") throw new Error(`The UX2 adoption preview was blocked: ${preview.reason}`);
  const applied = await service.apply(preview.intentId, {
    kind: "desktop",
    effectFingerprint: preview.effectFingerprint,
    approvedAt: new Date().toISOString(),
  });
  if (applied.status !== "applied") throw new Error("The UX2 owned skill could not be adopted.");
}

async function createUnregisteredProject(fixtureRoot: string): Promise<string> {
  const projectRoot = join(fixtureRoot, "contenu");
  await writeSkill(join(projectRoot, ".claude/skills/draft-posts"), "draft-posts", "Use when drafting a post.");
  await writeSkill(join(projectRoot, ".claude/skills/check-copy"), "check-copy", "Use when checking a draft.");
  await writeFile(join(projectRoot, "CLAUDE.md"), "# Project instructions\n\nKeep changes small and reviewable.\n");
  await symlink("CLAUDE.md", join(projectRoot, "AGENTS.md"));
  await run("git", ["init", "-q", "-b", "main", projectRoot]);
  await run("git", ["-C", projectRoot, "-c", "core.hooksPath=/dev/null", "add", "."]);
  await run("git", [
    "-C",
    projectRoot,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "user.name=Omni Fixture",
    "-c",
    "user.email=ada@example.com",
    "commit",
    "-qm",
    "Seed unregistered reception project",
  ]);
  return projectRoot;
}

export async function seedUxPass2Fixture(): Promise<UxPass2Fixture> {
  const fixtureRoot = await root("ux2");
  const userDataPath = join(fixtureRoot, "user-data");
  const agentHomePath = join(fixtureRoot, "agent-home");
  const sourceRoot = join(fixtureRoot, "ux2-marketplace");
  await Promise.all([userDataPath, agentHomePath, sourceRoot].map((path) => mkdir(path, { recursive: true })));
  await createMarketplace(sourceRoot);
  const { registry, sourceId, registrations } = await registerRoots(userDataPath, fixtureRoot, sourceRoot);
  const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
  const service = registerOperationsIpcHandlers(() => undefined, registry, {
    userDataPath,
    homeDir: agentHomePath,
  }).skillManagement;
  await service.initialize();
  const projects = [];
  for (const project of registrations) {
    await adoptOwnedSkill(project, registry, service, sourceId, userDataPath);
    projects.push({
      id: project.id,
      name: project.name,
      root: project.root,
      skills: await service.readProjectSkills!(project.id),
    });
  }
  const unregisteredProjectRoot = await createUnregisteredProject(fixtureRoot);
  return { fixtureRoot, userDataPath, agentHomePath, sourceRoot, sourceId, unregisteredProjectRoot, projects };
}
