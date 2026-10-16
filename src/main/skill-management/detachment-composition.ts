import type { SkillObservationFilesystem, SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import type { RegistryIpcServices } from "../registry-ipc";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import { createSkillDetachmentAdapter } from "./detachment";

export function createSkillDetachmentComposition(
  args: Readonly<{
    registry: RegistryIpcServices;
    relationships: SkillRelationshipStore;
    bindings: BindingsStore;
    bases: SkillBaseStore;
    operationStore: OperationStore;
    filesystem?: SkillObservationFilesystem;
    now?: () => number;
  }>,
): ReturnType<typeof createSkillDetachmentAdapter> {
  return createSkillDetachmentAdapter(args);
}
