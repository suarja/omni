import { createHash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { Binding } from "../../domain/assignment-plan";
import { isActiveAvailableProject } from "../../domain/active-projects";
import { activeWorkshop } from "../../domain/source-roles";
import { deriveSkillInventoryIdentity } from "../../domain/skill-inventory";
import { compactSkillInventoryUnit, compactSkillInventoryIdentity } from "../../domain/skill-inventory-limits";
import { resolveTarget } from "../../domain/harness-targets";
import type { RegistryEntryView, RegistryView } from "../../domain/project-source-registry";
import type { InventorySnapshot } from "../../domain/inventory";
import type { ManagedSkillUse } from "../../domain/skill-reconciliation/types";
import type {
  AgentSkillInventoryResponse,
  SkillInventoryLocation,
  SkillInventoryOrigin,
  SkillInventoryReadUnit,
  SkillInventoryScope,
  SkillInventorySnapshot,
  SkillInventoryLimit,
} from "../../shared/skill-inventory";
import { createLocalInventoryPort } from "../../adapters/inventory/local-filesystem";
import { inspectSkillFolder, type SkillFolderBudget } from "../../adapters/inventory/skill-folder-hash";
import { parseFrontmatter } from "../../adapters/inventory/frontmatter";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import type { BindingsStore } from "../bindings-store";
import { currentGrantRoot, resolveGrantedPath } from "../granted-hashing";
import { unitId } from "../assignment-resolution";
import { createSkillRelationshipStore } from "../skill-reconciliation/store";
import { createExternalProjectStateReader } from "../external-library/project-state";
import { readExternalSnapshot } from "../external-library/snapshot";
import { createSkillBaseStore, type SkillBaseStore } from "../skill-reconciliation/bases";
import { createProjectSkillSourceReader } from "../skill-management/project-skill-sources";
import { compareProjectSkillUse } from "../skill-management/project-skill-revisions";
import { createSkillInventoryPages } from "./skill-inventory-pages";
import { readRegisteredRoots } from "./router-observations";
import { fail, id, keys, object, optionalBoolean } from "./router-inputs";

type Options = Readonly<{
  registry: RegistryIpcServices;
  bindingsStore: Pick<BindingsStore, "read">;
  userDataPath: string;
  resolveBindingState: (binding: Binding) => Promise<"current" | "update" | "conflict">;
}>;
type Context = Readonly<{
  options: Options;
  sources: ReturnType<typeof createProjectSkillSourceReader>;
  bases: SkillBaseStore;
  entry: RegistryEntryView;
  inventory: InventorySnapshot;
  grant: RegistryGrant;
  bindings: readonly Binding[];
  uses: readonly ManagedSkillUse[];
  budget: SkillFolderBudget;
  limits: SkillInventoryLimit[];
}>;
function selectedProjects(value: unknown, registry: RegistryView): readonly RegistryEntryView<"project">[] {
  if (value === undefined) return registry.projects.filter((entry) => entry.archivedAt === undefined);
  if (!Array.isArray(value) || value.length > 64)
    throw fail("Inventory projectIds must be an array of at most 64 project ids.");
  return [...new Set(value.map((item) => id(item, "Project id")))].map((projectId) => {
    const project = registry.projects.find((entry) => entry.ref.id === projectId);
    if (!project) throw fail(`Inventory project ${projectId} is not registered; register it first.`);
    return project;
  });
}
function skillFolders(inventory: InventorySnapshot): readonly Readonly<{ folder: string; packageId?: string }>[] {
  const folders = new Map<string, { folder: string; packageId?: string }>();
  for (const artifact of inventory.artifacts.filter((artifact) => artifact.kind === "skill")) {
    for (const path of artifact.projectionPaths) {
      const folder =
        basename(path) === "SKILL.md"
          ? dirname(path)
          : /^\.(?:claude|agents|cursor)\/skills\/[^/]+$/u.test(path) && artifact.symlinkState !== "none"
            ? path
            : undefined;
      if (!folder) continue;
      folders.set(folder, { folder, ...(artifact.packageId ? { packageId: artifact.packageId } : {}) });
    }
  }
  return [...folders.values()].sort((a, b) => a.folder.localeCompare(b.folder));
}
function locationFor(folder: string): SkillInventoryLocation {
  const harness = folder.startsWith(".claude/")
    ? "claude-code"
    : folder.startsWith(".agents/")
      ? "codex"
      : folder.startsWith(".cursor/")
        ? "cursor"
        : "omni";
  return { harness, folder };
}
function bindingFolder(binding: Binding): string | undefined {
  const target = resolveTarget({
    kind: "skill",
    id: unitId("skill", binding.artifactPath),
    harnessId: binding.harnessId,
  });
  return target.status === "target" ? target.relativePath : undefined;
}
async function originFor(
  context: Context,
  locations: readonly SkillInventoryLocation[],
  folder: string,
  packageId?: string,
): Promise<SkillInventoryOrigin> {
  const { entry, inventory, bindings, uses, options } = context;
  if (entry.ref.kind === "source")
    return { kind: "marketplace", sourceId: entry.ref.id, packageId: packageId ?? "implicit-root" };
  const matches = (folder: string): boolean => locations.some((location) => location.folder === folder);
  const use = uses.find(
    (use) => use.location.projectId === entry.ref.id && matches(use.location.folderPath) && !use.disabled,
  );
  const binding = bindings.find(
    (binding) =>
      binding.projectId === entry.ref.id && binding.kind === "skill" && matches(bindingFolder(binding) ?? ""),
  );
  if (use || binding) {
    const source = use?.source ?? binding!;
    const state = use
      ? await compareProjectSkillUse(
          { ...use, location: { ...use.location, folderPath: folder } },
          context.grant,
          context.bases,
          context.sources.readRevision,
        )
      : undefined;
    return {
      kind: "marketplace",
      sourceId: source.sourceId,
      packageId: source.packageId,
      bindingId: use?.bindingId ?? binding!.bindingId,
      state:
        state === "current"
          ? "current"
          : state === "update-available"
            ? "update"
            : state === "modified-here"
              ? "conflict"
              : (state ?? (binding ? await options.resolveBindingState(binding) : "unknown")),
    };
  }
  const lock = inventory.skillOrigins?.find((origin) => matches(dirname(origin.relativePath)));
  if (!lock) return { kind: "local" };
  const state = await createExternalProjectStateReader({
    userDataPath: options.userDataPath,
    projectId: entry.ref.id,
    origins: inventory.skillOrigins,
  })(dirname(lock.relativePath));
  const observed = readExternalSnapshot(options.userDataPath)
    ?.sources.flatMap((source) => source.uses)
    .find(
      (use) => use.projectId === entry.ref.id && use.sourceId === lock.source.locator && use.skillKey === lock.skillKey,
    );
  const skillPath = lock.sourceSkillPath?.replace(/\/SKILL\.md$/u, "") ?? observed?.skillPath;
  return { kind: "external", repo: lock.source.locator, ...(skillPath ? { skillPath } : {}), state };
}
async function readUnits(context: Context): Promise<SkillInventoryReadUnit[]> {
  const groups = new Map<string, { folder: string; packageId?: string; locations: SkillInventoryLocation[] }>();
  for (const item of skillFolders(context.inventory)) {
    const canonical = await resolveGrantedPath(context.grant, item.folder);
    const safe = canonical !== "denied" && canonical !== "unavailable";
    const location = locationFor(item.folder);
    const details = await lstat(join(context.grant.root, item.folder)).catch(() => undefined);
    const linkTo = details?.isSymbolicLink()
      ? await readlink(join(context.grant.root, item.folder)).catch(() => undefined)
      : undefined;
    const key = safe ? canonical : item.folder;
    const existing = groups.get(key);
    const located = { ...location, ...(linkTo ? { linkTo } : {}) };
    if (existing) existing.locations.push(located);
    else
      groups.set(key, {
        folder: safe ? relative(context.grant.root, canonical) : item.folder,
        packageId: item.packageId,
        locations: [located],
      });
  }
  const filesystem = createLocalInventoryPort(context.grant.root);
  const units: SkillInventoryReadUnit[] = [];
  for (const item of groups.values()) {
    const scope = context.entry.ref.kind === "project" ? context.entry.ref.id : "marketplace";
    const read = await inspectSkillFolder(filesystem, item.folder, context.budget);
    let description = "";
    let lines: number | null = null;
    if (read.status === "hashed" && read.skillMd) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(read.skillMd);
        const metadata = parseFrontmatter(text, true);
        if (!metadata.valid) context.limits.push({ scope, path: item.folder, reason: "malformed-frontmatter" });
        description = metadata.description ?? "";
        lines = text ? text.split(/\r?\n/u).length - (text.endsWith("\n") ? 1 : 0) : 0;
      } catch {
        context.limits.push({ scope, path: item.folder, reason: "invalid-utf8" });
      }
    } else
      context.limits.push({
        scope,
        path: item.folder,
        reason: read.status === "unverified" ? read.reason : "missing-skill-md",
      });
    if (description.length > 160)
      context.limits.push({ scope, path: item.folder, reason: "description-capped-at-160" });
    units.push({
      id: `u${createHash("sha256")
        .update(JSON.stringify([context.entry.ref.kind, context.entry.ref.id, item.folder]))
        .digest("hex")
        .slice(0, 16)}`,
      name: basename(item.folder),
      scope,
      ...(scope === "marketplace" ? { packageId: item.packageId ?? "implicit-root" } : {}),
      locations: item.locations,
      origin: await originFor(context, item.locations, item.folder, item.packageId),
      description: description.slice(0, 160),
      lines,
      files: read.status === "hashed" ? read.files : null,
      contentHash: read.status === "hashed" && read.skillMd ? read.hash : null,
      skillMdPath: join(context.grant.root, item.folder, "SKILL.md"),
    });
  }
  return units;
}
async function staleBindings(context: Context): Promise<SkillInventorySnapshot["identity"]["staleBindings"]> {
  const candidates = new Map<string, { bindingId: string; projectId: string; folder: string }>();
  for (const binding of context.bindings.filter(
    (binding) => binding.kind === "skill" && binding.projectId === context.entry.ref.id,
  )) {
    const folder = bindingFolder(binding);
    if (folder)
      candidates.set(binding.bindingId, { bindingId: binding.bindingId, projectId: binding.projectId, folder });
  }
  for (const use of context.uses.filter((use) => use.location.projectId === context.entry.ref.id && !use.disabled))
    candidates.set(use.bindingId, {
      bindingId: use.bindingId,
      projectId: use.location.projectId,
      folder: use.location.folderPath,
    });
  const stale: Array<SkillInventorySnapshot["identity"]["staleBindings"][number]> = [];
  for (const candidate of candidates.values()) {
    const path = await resolveGrantedPath(context.grant, `${candidate.folder}/SKILL.md`);
    if (path === "unavailable") {
      // A denied or unreadable copy is uncertainty, not evidence of absence.
      try {
        await lstat(join(context.grant.root, candidate.folder, "SKILL.md"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") stale.push(candidate);
        else
          context.limits.push({
            scope: candidate.projectId,
            path: candidate.folder,
            reason: "binding-copy-unreadable",
          });
      }
    } else if (path === "denied")
      context.limits.push({ scope: candidate.projectId, path: candidate.folder, reason: "binding-copy-denied" });
  }
  return stale;
}
type RootInventoryRead = Readonly<{
  root: string;
  units: readonly SkillInventoryReadUnit[];
  stale: SkillInventorySnapshot["identity"]["staleBindings"];
}>;
async function readRootInventory(
  entry: RegistryEntryView,
  inventory: InventorySnapshot,
  shared: Omit<Context, "entry" | "inventory" | "grant">,
): Promise<RootInventoryRead> {
  const handle = await shared.options.registry.getGrantForEntry(entry.ref);
  const grant = handle ? shared.options.registry.get(handle) : undefined;
  if (!grant || !(await currentGrantRoot(grant))) throw fail("Fresh root access is required.");
  const context: Context = { ...shared, entry, inventory, grant };
  for (const diagnostic of inventory.diagnostics.filter((diagnostic) => diagnostic.code !== "git-unavailable"))
    shared.limits.push({ scope: entry.ref.id, path: diagnostic.location, reason: diagnostic.message });
  return {
    root: grant.root,
    units: await readUnits(context),
    stale: entry.ref.kind === "project" ? await staleBindings(context) : [],
  };
}
async function readInventorySnapshot(params: unknown, options: Options): Promise<SkillInventorySnapshot> {
  const request = object(params, "skill_inventory parameters");
  keys(request, ["projectIds", "includeMarketplace"], "skill_inventory parameters");
  const includeMarketplace = optionalBoolean(request.includeMarketplace, "includeMarketplace") ?? true;
  const loaded = await options.registry.listRegistry();
  if (loaded.status !== "ready") throw fail("Inventory registry is unavailable; reopen Omni.");
  const projects = selectedProjects(request.projectIds, loaded.registry);
  const marketplace = includeMarketplace ? activeWorkshop(loaded.registry) : undefined;
  const entries: RegistryEntryView[] = [...projects];
  if (marketplace) entries.push(marketplace);
  const read = await readRegisteredRoots(options.registry, entries);
  const unavailable: Array<SkillInventorySnapshot["unavailable"][number]> = read.unreadRoots.map((root) => ({
    ...(root.root.kind === "project" ? { projectId: root.root.id } : {}),
    name: root.name,
    reason: root.reason,
  }));
  if (includeMarketplace && !marketplace)
    unavailable.push({ name: "marketplace", reason: "No active workshop is registered." });
  const bindings = await options.bindingsStore.read();
  const relationships = await createSkillRelationshipStore(
    join(options.userDataPath, "omni/skill-relationships.json"),
  ).read();
  if (bindings.status !== "ready" || relationships.status !== "ready")
    throw fail("Inventory bindings or skill relationships are unavailable; inspect the stores before auditing.");
  const units: SkillInventoryReadUnit[] = [];
  const stale: Array<SkillInventorySnapshot["identity"]["staleBindings"][number]> = [];
  const limits: SkillInventoryLimit[] = [];
  const scopes: SkillInventoryScope[] = [];
  const budget = { remainingBytes: 32 * 1024 * 1024 };
  const sources = createProjectSkillSourceReader(loaded.registry, { registry: options.registry });
  const bases = createSkillBaseStore(options.userDataPath);
  for (const { entry, observation } of read.observations) {
    if (entry.ref.kind === "project" && !isActiveAvailableProject(entry as RegistryEntryView<"project">)) continue;
    try {
      const read = await readRootInventory(entry, observation.inventory, {
        options,
        sources,
        bases,
        bindings: bindings.bindings,
        uses: relationships.state.uses,
        limits,
        budget,
      });
      scopes.push({
        key: entry.ref.kind === "source" ? "m" : `p${scopes.filter((scope) => scope.kind === "project").length}`,
        kind: entry.ref.kind === "source" ? "marketplace" : "project",
        ...(entry.ref.kind === "source" ? { sourceId: entry.ref.id } : { projectId: entry.ref.id }),
        name: entry.displayName,
        root: read.root,
      });
      units.push(...read.units);
      stale.push(...read.stale);
    } catch {
      unavailable.push({
        ...(entry.ref.kind === "project" ? { projectId: entry.ref.id } : {}),
        name: entry.displayName,
        reason: "Inventory root access failed; reopen the registered root and retry.",
      });
    }
  }
  return {
    status: unavailable.length || limits.length ? "partial" : "ready",
    scopes,
    units: units.map((unit) => {
      const scope = scopes.find((scope) =>
        unit.scope === "marketplace" ? scope.kind === "marketplace" : scope.projectId === unit.scope,
      );
      if (!scope) throw fail("Inventory scope could not be resolved; restart the inventory.");
      return compactSkillInventoryUnit(unit, scope);
    }),
    identity: compactSkillInventoryIdentity(deriveSkillInventoryIdentity(units, stale)),
    unavailable,
    limits,
  };
}
export function createSkillInventoryReader(
  options: Options,
): (params: unknown) => Promise<AgentSkillInventoryResponse> {
  return createSkillInventoryPages((params) => readInventorySnapshot(params, options));
}
