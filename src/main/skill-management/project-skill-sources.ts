import type { InventorySnapshot } from "../../domain/inventory";
import type { ManagedSkillUse, SkillRevision } from "../../domain/skill-reconciliation/types";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import { currentGrantRoot } from "../granted-hashing";
import { observationIssueForLocation } from "../skill-reconciliation/location-observation";
import { freshGrant, observedSourcePath } from "./adoption-reader";
import { captureProjectSkillRevision } from "./project-skill-revisions";

type Registry = Extract<Awaited<ReturnType<RegistryIpcServices["listRegistry"]>>, { status: "ready" }>["registry"];
type SourceRead = Readonly<{ grant: RegistryGrant; inventory: InventorySnapshot }>;
export function createProjectSkillSourceReader(
  registry: Registry,
  args: Readonly<{ registry: RegistryIpcServices; now?: () => number }>,
): Readonly<{
  readInventory(sourceId: string): Promise<SourceRead | undefined>;
  readRevision(use: ManagedSkillUse): Promise<SkillRevision | undefined>;
}> {
  const inventories = new Map<string, Promise<SourceRead | undefined>>();
  const revisions = new Map<string, Promise<SkillRevision | undefined>>();
  const readInventory = (sourceId: string): Promise<SourceRead | undefined> => {
    let read = inventories.get(sourceId);
    if (!read) {
      read = (async () => {
        const source = registry.sources.find(
          (source) =>
            source.ref.id === sourceId && source.archivedAt === undefined && source.availability === "available",
        );
        if (!source) return undefined;
        const grant = await freshGrant(args.registry, source.ref, args.now ?? Date.now);
        if (!grant || !(await currentGrantRoot(grant))) return undefined;
        const observed = await args.registry.observeEntryWithGrant(source.ref, grant.handle);
        return observed.status === "observed" ? { grant, inventory: observed.observation.inventory } : undefined;
      })();
      inventories.set(sourceId, read);
    }
    return read;
  };
  const readRevision = (use: ManagedSkillUse): Promise<SkillRevision | undefined> => {
    const key = JSON.stringify(use.source);
    let result = revisions.get(key);
    if (!result) {
      result = (async () => {
        const observed = await readInventory(use.source.sourceId);
        if (!observed) return undefined;
        const folder = observedSourcePath(observed.inventory, use.source);
        return folder && !observationIssueForLocation(observed.inventory, folder)
          ? captureProjectSkillRevision(observed.grant, folder)
          : undefined;
      })();
      revisions.set(key, result);
    }
    return result;
  };
  return { readInventory, readRevision };
}
