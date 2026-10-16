import type { ResourceSnapshot } from "../../../domain/resource-catalogue";
import type { WorkspaceSetupInputs } from "./workspace-setup-types";

export function createFallbackWorkspaceSetup(snapshot: ResourceSnapshot): WorkspaceSetupInputs {
  return {
    snapshot,
    api: null,
    commands: {
      registerProject: async () => null,
      registerSource: async () => null,
      refreshRegistry: async () => null,
      observeEntry: async () => undefined,
    },
    registryBusy: false,
    diagnostic: null,
  };
}
