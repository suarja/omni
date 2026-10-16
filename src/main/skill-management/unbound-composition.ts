import type { SkillOperationJournal } from "../../application/skill-management-journal";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { FileWriter } from "../operation-files";
import type { OperationStore } from "../operation-store";
import type { RegistryIpcServices } from "../registry-ipc";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import { createSkillAdoptionAdapter } from "./adoption";
import { createSkillUnboundResolutionAdapter } from "./unbound-resolution";

export function createSkillLinkAdapters(
  args: Readonly<{
    userDataPath: string;
    registry: RegistryIpcServices;
    relationships: SkillRelationshipStore;
    bindings: BindingsStore;
    bases: SkillBaseStore;
    operationStore: OperationStore;
    journal: SkillOperationJournal;
    fileWriter?: FileWriter;
    now: () => number;
  }>,
): Readonly<{
  adoption: ReturnType<typeof createSkillAdoptionAdapter>;
  unboundResolution: ReturnType<typeof createSkillUnboundResolutionAdapter>;
}> {
  const adoption = createSkillAdoptionAdapter({
    registry: args.registry,
    relationships: args.relationships,
    bindings: args.bindings,
    bases: args.bases,
    operationStore: args.operationStore,
    now: args.now,
  });
  const unboundResolution = createSkillUnboundResolutionAdapter({
    userDataPath: args.userDataPath,
    registry: args.registry,
    relationships: args.relationships,
    bindings: args.bindings,
    bases: args.bases,
    operationStore: args.operationStore,
    journal: args.journal,
    adoption,
    ...(args.fileWriter ? { fileWriter: args.fileWriter } : {}),
    now: args.now,
  });
  return { adoption, unboundResolution };
}
