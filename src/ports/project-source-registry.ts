import type { RegistryLoadResult, RegistryMutationResult, RegistryState } from "../domain/project-source-registry";

export type RegistryChange = (state: RegistryState) => RegistryState;

export interface ProjectSourceRegistryStore {
  read(): Promise<RegistryLoadResult>;
  mutate(expectedRevision: number, change: RegistryChange): Promise<RegistryMutationResult>;
}
