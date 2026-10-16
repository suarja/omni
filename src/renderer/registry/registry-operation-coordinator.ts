export type RegistryMutationToken = Readonly<{ generation: number }>;
export type RegistryLoadToken = Readonly<{
  generation: number;
  mutationGeneration: number | null;
}>;

export type RegistryOperationCoordinator = Readonly<{
  beginLoad: (mutation?: RegistryMutationToken) => RegistryLoadToken | null;
  beginMutation: () => RegistryMutationToken | null;
  endMutation: (mutation: RegistryMutationToken) => boolean;
  isLoadAuthorized: (load: RegistryLoadToken) => boolean;
  isMutationActive: () => boolean;
}>;

export function createRegistryOperationCoordinator(): RegistryOperationCoordinator {
  let generation = 0;
  let activeMutation: RegistryMutationToken | null = null;

  function beginMutation(): RegistryMutationToken | null {
    if (activeMutation !== null) return null;
    generation += 1;
    activeMutation = { generation };
    return activeMutation;
  }

  function endMutation(mutation: RegistryMutationToken): boolean {
    if (activeMutation?.generation !== mutation.generation) return false;
    activeMutation = null;
    return true;
  }

  function beginLoad(mutation?: RegistryMutationToken): RegistryLoadToken | null {
    if (mutation === undefined) {
      return activeMutation === null ? { generation, mutationGeneration: null } : null;
    }
    return activeMutation?.generation === mutation.generation
      ? { generation, mutationGeneration: mutation.generation }
      : null;
  }

  function isLoadAuthorized(load: RegistryLoadToken): boolean {
    if (load.generation !== generation) return false;
    return load.mutationGeneration === null
      ? activeMutation === null
      : activeMutation?.generation === load.mutationGeneration;
  }

  return { beginLoad, beginMutation, endMutation, isLoadAuthorized, isMutationActive: () => activeMutation !== null };
}
