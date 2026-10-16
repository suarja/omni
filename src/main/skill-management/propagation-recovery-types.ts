import type { SkillLocationKey, SkillRevision } from "../../domain/skill-reconciliation/types";
import type { SkillPropagationReceiptPointer } from "../../shared/skill-propagation-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import type { SkillRelationshipStore, SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import type { OperationStore } from "../operation-store";

export type PropagationRecoveryDependencies = Readonly<{
  userDataPath: string;
  registry: RegistryIpcServices;
  relationships: SkillRelationshipStore;
  bindings: BindingsStore;
  bases: SkillBaseStore;
  operationStore: OperationStore;
  filesystem?: SkillObservationFilesystem;
  now?: () => number;
}>;

export type PropagationRestoreTarget = Readonly<{
  receipt: OperationReceipt;
  pointer: SkillPropagationReceiptPointer;
  grant: RegistryGrant;
  filesBefore: ReadonlyMap<string, Uint8Array>;
  filesAfter: ReadonlyMap<string, Uint8Array>;
  relationshipRevision: number;
  baseRevision: SkillRevision;
  sourceRootIdentity: string;
}>;
