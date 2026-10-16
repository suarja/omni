import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { OperationStore } from "../../src/main/operation-store";
import type { FileWriter } from "../../src/main/operation-files";
import type { RegistryIpcServices } from "../../src/main/registry-ipc";
import { root, retainFixture, setup, handlers } from "../ipc/apply-ipc-helpers";

export const sourcePackage = "packages/tools";
export const sourceSkill = "skills/demo";
export const projectSkill = ".agents/skills/demo";
export const claudeSkill = ".claude/skills/demo";
const bytesHash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

export async function treeDigest(root: string): Promise<string> {
  const files: Array<readonly [string, string]> = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      const details = await lstat(path);
      if (details.isSymbolicLink()) files.push([relative, "symlink:" + (await readlink(path))]);
      else if (details.isDirectory()) await visit(path, relative);
      else if (details.isFile()) files.push([relative, bytesHash(await readFile(path))]);
      else files.push([relative, "special"]);
    }
  };
  await visit(root, "");
  return JSON.stringify(files.sort(([left], [right]) => left.localeCompare(right)));
}

async function copySkill(sourceRoot: string, projectRoot: string, destination: string): Promise<void> {
  const files = [
    ["SKILL.md", await readFile(join(sourceRoot, sourcePackage, sourceSkill, "SKILL.md"))],
    ["notes.md", await readFile(join(sourceRoot, sourcePackage, sourceSkill, "notes.md"))],
    ["support/payload.bin", await readFile(join(sourceRoot, sourcePackage, sourceSkill, "support/payload.bin"))],
  ] as const;
  for (const [relativePath, bytes] of files) {
    const target = join(projectRoot, destination, relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, bytes);
  }
}

export async function seedFixture(): Promise<Awaited<ReturnType<typeof setup>>> {
  const fixture = await setup({ commitChanges: false });
  const skillRoot = join(fixture.sourceRoot, sourcePackage, sourceSkill);
  await mkdir(join(skillRoot, "support"), { recursive: true });
  await writeFile(
    join(fixture.sourceRoot, "omni.marketplace.json"),
    JSON.stringify({
      format: "omni.marketplace/1",
      id: "personal",
      name: "Personal",
      createdAt: "2026-10-09T00:00:00.000Z",
      packages: [{ path: sourcePackage }],
      createdBy: "omni-desktop/test",
    }),
  );
  await writeFile(
    join(fixture.sourceRoot, sourcePackage, "omni.plugin.json"),
    JSON.stringify({
      format: "omni.plugin/1",
      id: "tools",
      name: "Tools",
      version: "0.1.0",
      artifacts: [],
    }),
  );
  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: demo\n---\n# Demo\n");
  await writeFile(join(skillRoot, "notes.md"), "Support note.\n");
  await writeFile(join(skillRoot, "support/payload.bin"), Buffer.from([0, 1, 255, 3]));
  await copySkill(fixture.sourceRoot, fixture.projectRoot, projectSkill);
  await copySkill(fixture.sourceRoot, fixture.projectRoot, claudeSkill);
  return fixture;
}

type ReceptionProject = Readonly<{
  id: string;
  name: "alpha" | "beta" | "gamma" | "delta";
  root: string;
  codexCopy: string;
  claudeCopy: string;
}>;

export async function seedReceptionFixture(currentSource = false): Promise<
  Readonly<{
    userDataPath: string;
    sourceRoot: string;
    skillId: string;
    projects: readonly ReceptionProject[];
    deltaMovedRoot: string;
  }>
> {
  const fixture = await seedFixture();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pZkAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "support/pixel.png"), png);
  const names = ["alpha", "beta", "gamma", "delta"] as const;
  const projectRoots = [fixture.projectRoot, ...(await Promise.all(names.slice(1).map(() => root("project"))))];
  const projects = [] as ReceptionProject[];
  const projectGrants = new Map<string, string>();
  for (const [index, name] of names.entries()) {
    const projectRoot = projectRoots[index];
    if (!projectRoot) throw new Error("Project fixture root is missing.");
    if (index > 0) await mkdir(projectRoot, { recursive: true });
    const registered = index === 0 ? fixture.project : await fixture.registerProjectRoot(projectRoot);
    projectGrants.set(registered.id, registered.grantHandle);
    await copySkill(fixture.sourceRoot, projectRoot, projectSkill);
    await copySkill(fixture.sourceRoot, projectRoot, claudeSkill);
    await writeFile(join(projectRoot, projectSkill, "support/pixel.png"), png);
    await writeFile(join(projectRoot, claudeSkill, "support/pixel.png"), png);
    projects.push({
      id: registered.id,
      name,
      root: projectRoot,
      codexCopy: join(projectRoot, projectSkill),
      claudeCopy: join(projectRoot, claudeSkill),
    });
  }

  const skillId = await observedSkillId(fixture);
  await registerOperations(fixture);
  const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
  const source = { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill };
  for (const { id } of projects) {
    const grantHandle = projectGrants.get(id);
    if (!grantHandle) throw new Error("The registered project grant is unavailable.");
    const projectSkillId = await observedSkillId(fixture, { id, grantHandle });
    const locations = [
      { projectId: id, harnessId: "codex" as const, folderPath: projectSkill },
      { projectId: id, harnessId: "claude-code" as const, folderPath: claudeSkill },
    ];
    const preview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      {
        intent: { kind: "reconcile", request: { choice: "adopt-exact", skillId: projectSkillId, source, locations } },
      },
    )) as { status: string; intentId?: string; effectFingerprint?: string };
    if (preview.status !== "ready" || !preview.intentId || !preview.effectFingerprint)
      throw new Error("The exact adoption preview for a project copy pair was not ready: " + JSON.stringify(preview));
    const adopted = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      {
        intentId: preview.intentId,
        effectFingerprint: preview.effectFingerprint,
      },
    )) as { status: string };
    if (adopted.status !== "applied") throw new Error("The exact adoption did not complete.");
  }

  const gamma = projects.find(({ name }) => name === "gamma");
  const delta = projects.find(({ name }) => name === "delta");
  if (!gamma || !delta) throw new Error("Retained and unavailable project fixtures are missing.");
  await writeFile(join(gamma.claudeCopy, "SKILL.md"), "---\nname: demo\n---\n# Local gamma edit\n");
  const deltaMovedRoot = delta.root + "-moved-away";
  await rename(delta.root, deltaMovedRoot);

  if (currentSource) {
    const updatedSkill = "---\nname: demo\ndescription: Current source revision.\n---\n# Demo v2\n";
    await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"), updatedSkill);
    const alpha = projects.find(({ name }) => name === "alpha");
    if (!alpha) throw new Error("The alpha project fixture is missing.");
    for (const copy of [alpha.codexCopy, alpha.claudeCopy]) await writeFile(join(copy, "SKILL.md"), updatedSkill);
  }

  const retained = { ...fixture, extraRoots: projectRoots.slice(1) };
  await writeFile(
    "/private/tmp/omni-s05-fixture.json",
    JSON.stringify(
      {
        userDataPath: fixture.userDataPath,
        sourceRoot: fixture.sourceRoot,
        skillId,
        projects,
        deltaMovedRoot,
      },
      null,
      2,
    ) + "\n",
  );
  retainFixture(retained);
  return { userDataPath: fixture.userDataPath, sourceRoot: fixture.sourceRoot, skillId, projects, deltaMovedRoot };
}

export async function observedSkillId(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  project: Readonly<{ id: string; grantHandle: string }> = fixture.project,
): Promise<string> {
  const { registerSkillReconciliationIpcHandlers } = await import("../../src/main/skill-reconciliation/ipc");
  const { SKILL_RECONCILIATION_IPC_CHANNELS } = await import("../../src/shared/skill-reconciliation-ipc");
  registerSkillReconciliationIpcHandlers(() => undefined, fixture.registry, { userDataPath: fixture.userDataPath });
  const inventory = await fixture.registry.observeEntryWithGrant(
    { kind: "project", id: project.id },
    project.grantHandle,
  );
  if (inventory.status !== "observed") throw new Error("The project inventory could not be read.");
  const members = inventory.observation.inventory.artifacts
    .filter(
      (artifact) =>
        artifact.kind === "skill" &&
        [projectSkill, claudeSkill].some((folder) => artifact.relativePath === folder + "/SKILL.md"),
    )
    .map((artifact) => ({
      ref: {
        kind: "artifact" as const,
        entry: { kind: "project" as const, id: project.id },
        artifactId: artifact.id,
      },
      relativePath: artifact.relativePath,
    }));
  if (members.length !== 2) throw new Error("Expected two observed project copies.");
  const response = (await handlers.get(SKILL_RECONCILIATION_IPC_CHANNELS.observe)!(
    {},
    {
      projectId: project.id,
      grantHandle: project.grantHandle,
      groups: [{ groupId: "observed-copies", members }],
    },
  )) as { status: string; groups?: readonly { correlation: { groups: readonly { skillId: string }[] } }[] };
  if (response.status !== "ready") throw new Error("The exact project copies could not be observed.");
  const id = response.groups?.[0]?.correlation.groups[0]?.skillId;
  if (!id) throw new Error("The observed logical skill id is unavailable.");
  return id;
}

export async function registerOperations(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  operationStore?: OperationStore,
  fileWriter?: FileWriter,
  registry: RegistryIpcServices = fixture.registry,
): Promise<import("../../src/main/operations-ipc").OperationsIpcServices> {
  const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
  const operations = registerOperationsIpcHandlers(() => undefined, registry, {
    userDataPath: fixture.userDataPath,
    ...(operationStore ? { operationStore } : {}),
    ...(fileWriter ? { fileWriter } : {}),
    applyRestore: fixture.applyRestore,
    bindings: fixture.bindings,
    now: Date.now,
  });
  await operations.skillManagement.initialize();
  return operations;
}
