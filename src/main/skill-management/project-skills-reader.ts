import { isWorkshopSource } from "../../domain/source-roles";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { parseFrontmatter } from "../../adapters/inventory/frontmatter";
import { parseSkillLocationKey } from "../../domain/skill-reconciliation/validation";
import type { ManagedSkillUse } from "../../domain/skill-reconciliation/types";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import { buildProjectSkillsView, type ProjectSkillCopy } from "../../application/project-skills";
import { compareProjectSkillUse } from "./project-skill-revisions";
import { createProjectSkillSourceReader } from "./project-skill-sources";
import { createExternalProjectStateReader } from "../external-library/project-state";
import type { InventorySnapshot, ObservedArtifact, InventoryDiagnostic } from "../../domain/inventory";
import {
  parseProjectSkills,
  parseProjectSkillsRequest,
  type ProjectSkillRow,
  type ProjectSkills,
} from "../../shared/project-skills-ipc";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import { observationIssueForLocation } from "../skill-reconciliation/location-observation";
import { currentGrantRoot } from "../granted-hashing";
import { freshGrant } from "./adoption-reader";
import { guardSkillPath } from "./project-skill-files";
import type { ProjectSkillParking } from "./project-skill-parking";

export type ProjectSkillsReaderDependencies = Readonly<{
  registry: RegistryIpcServices;
  relationships: SkillRelationshipStore;
  bases: SkillBaseStore;
  parking: ProjectSkillParking;
  now?: () => number;
  userDataPath?: string;
}>;
type Context = Readonly<{
  projectId: string;
  grant: RegistryGrant;
  inventory: InventorySnapshot;
  uses: readonly ManagedSkillUse[];
  registry: Extract<Awaited<ReturnType<RegistryIpcServices["listRegistry"]>>, { status: "ready" }>["registry"];
  sources: ReturnType<typeof createProjectSkillSourceReader>;
  diagnostics: InventoryDiagnostic[];
  args: ProjectSkillsReaderDependencies;
  readExternalState: (folderPath: string) => Promise<ProjectSkillRow["state"]>;
}>;

export async function readProjectSkillGrant(
  projectId: string,
  args: ProjectSkillsReaderDependencies,
): Promise<RegistryGrant> {
  parseProjectSkillsRequest({ projectId });
  const registry = await args.registry.listRegistry();
  if (
    registry.status !== "ready" ||
    !registry.registry.projects.some(
      (project) =>
        project.ref.id === projectId && project.archivedAt === undefined && project.availability === "available",
    )
  )
    throw new Error("The project is unavailable; reopen it before managing its skills.");
  const grant = await freshGrant(args.registry, { kind: "project", id: projectId }, args.now ?? Date.now);
  if (!grant || !(await currentGrantRoot(grant)))
    throw new Error("Fresh project access is required; reopen the project.");
  return grant;
}

async function readDescription(grant: RegistryGrant, folder: string): Promise<{ name?: string; description?: string }> {
  await guardSkillPath(grant.root, folder);
  const target = await realpath(join(grant.root, folder, "SKILL.md"));
  const path = relative(grant.root, target);
  if (path.startsWith("../") || path === "..") throw new Error("Skill description points outside the project.");
  const details = await lstat(target);
  if (!details.isFile() || details.size > 1024 * 1024) throw new Error("Skill description cannot be read safely.");
  return parseFrontmatter(await readFile(target, "utf8"), true);
}

async function readCopyOrigin(
  artifact: ObservedArtifact,
  projection: string,
  use: ManagedSkillUse | undefined,
  context: Context,
): Promise<ProjectSkillRow["origin"]> {
  const source =
    use &&
    context.registry.sources.find((source) => source.ref.id === use.source.sourceId && source.archivedAt === undefined);
  if (use) {
    const packageLabel = (await context.sources.readInventory(use.source.sourceId))?.inventory.packages?.find(
      (pkg) => pkg.id === use.source.packageId,
    )?.displayName;
    return isWorkshopSource(source)
      ? { kind: "mine", ...use.source, label: packageLabel ?? use.source.packageId }
      : { kind: "external", ...use.source, source: source?.displayName ?? use.source.sourceId };
  }
  const lock = context.inventory.skillOrigins?.find(
    (origin) => origin.relativePath === projection || origin.artifactId === artifact.id,
  );
  return lock ? { kind: "external", source: lock.source.locator } : { kind: "project-only" };
}

async function readCopy(
  artifact: ObservedArtifact,
  projection: string,
  context: Context,
): Promise<ProjectSkillCopy | undefined> {
  const match = projection.match(/^(\.claude|\.agents)\/skills\/([^/]+)(?:\/SKILL\.md)?$/u);
  if (!match) return undefined;
  const folderPath = projection.endsWith("/SKILL.md") ? projection.slice(0, -"/SKILL.md".length) : projection;
  const harnessId = match[1] === ".claude" ? "claude-code" : "codex";
  try {
    parseSkillLocationKey({ projectId: context.projectId, harnessId, folderPath });
  } catch {
    return undefined;
  }
  const use = context.uses.find(
    (use) => use.location.projectId === context.projectId && use.location.folderPath === folderPath,
  );
  const origin = await readCopyOrigin(artifact, projection, use, context);
  let name = basename(folderPath);
  let description = artifact.summary ?? "";
  let symlink = artifact.symlinkState !== "none";
  let state: ProjectSkillRow["state"] = "unknown";
  try {
    symlink = (await lstat(await guardSkillPath(context.grant.root, folderPath))).isSymbolicLink();
    const frontmatter = await readDescription(context.grant, folderPath);
    name = frontmatter.name ?? name;
    description = frontmatter.description ?? description;
    if (
      origin.kind === "external" &&
      context.inventory.skillOrigins?.some((lock) => lock.skillKey === basename(folderPath))
    )
      state = await context.readExternalState(folderPath);
    else if (!observationIssueForLocation(context.inventory, folderPath))
      state = await compareProjectSkillUse(use, context.grant, context.args.bases, context.sources.readRevision);
  } catch {
    context.diagnostics.push({
      code: "inaccessible",
      severity: "warning",
      location: projection,
      message: "The skill description or complete tree could not be read safely.",
    });
  }
  return { folderPath, harnessId, symlink, name, description, use, origin, state };
}

async function readProjectSkillCopies(context: Context): Promise<readonly ProjectSkillCopy[]> {
  const copies: ProjectSkillCopy[] = [];
  const seen = new Set<string>();
  for (const artifact of context.inventory.artifacts.filter(
    (artifact) => artifact.kind === "skill" && artifact.scope === "project",
  )) {
    for (const projection of artifact.projectionPaths) {
      const copy = await readCopy(artifact, projection, context);
      if (!copy || seen.has(copy.folderPath)) continue;
      seen.add(copy.folderPath);
      copies.push(copy);
    }
  }
  return copies;
}

export async function readProjectSkills(
  projectId: string,
  args: ProjectSkillsReaderDependencies,
): Promise<ProjectSkills> {
  const grant = await readProjectSkillGrant(projectId, args);
  const observation = await args.registry.observeEntryWithGrant({ kind: "project", id: projectId }, grant.handle);
  if (observation.status !== "observed") throw new Error("Project skills could not be observed; reopen the project.");
  const relationships = await args.relationships.read();
  if (relationships.status !== "ready") throw new Error("Managed skill relationships are unavailable.");
  const registry = await args.registry.listRegistry();
  if (registry.status !== "ready") throw new Error("Marketplace registrations are unavailable.");
  const inventory = observation.observation.inventory;
  const diagnostics = [...inventory.diagnostics];
  const copies = await readProjectSkillCopies({
    projectId,
    grant,
    inventory,
    diagnostics,
    uses: relationships.state.uses,
    registry: registry.registry,
    sources: createProjectSkillSourceReader(registry.registry, args),
    readExternalState: createExternalProjectStateReader({
      userDataPath: args.userDataPath,
      projectId,
      origins: inventory.skillOrigins,
    }),
    args,
  });
  const parked = (await args.parking.read()).filter((record) => record.projectId === projectId);
  return parseProjectSkills({
    projectId,
    ...buildProjectSkillsView(copies, parked),
    git: inventory.gitScopes,
    diagnostics,
  });
}
