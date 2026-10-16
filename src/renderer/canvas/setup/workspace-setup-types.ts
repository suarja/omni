import type { EntryRef, SourceOwnership } from "../../../domain/project-source-registry";
import type { ResourceSnapshot } from "../../../domain/resource-catalogue";
import type { DesktopApi } from "../../../shared/ipc";
import type {
  RegisterProjectResponse,
  RegisterSourceResponse,
  RegistryViewResponse,
} from "../../../shared/registry-ipc";

export type WorkspaceSetupIntent = "marketplace" | "project";

export type WorkspaceSetupCommands = Readonly<{
  registerProject: (grantHandle?: string) => Promise<RegisterProjectResponse | null>;
  registerSource: (ownership: SourceOwnership) => Promise<RegisterSourceResponse | null>;
  refreshRegistry: () => Promise<RegistryViewResponse | null>;
  observeEntry: (entry: EntryRef) => Promise<void>;
}>;

export type WorkspaceSetupInputs = Readonly<{
  snapshot: ResourceSnapshot;
  api: Pick<
    DesktopApi,
    | "pickOperationParent"
    | "previewOperation"
    | "applyOperation"
    | "getAgentStatus"
    | "inspectProject"
    | "registerInspectedProject"
  > | null;
  commands: WorkspaceSetupCommands;
  registryBusy: boolean;
  diagnostic: string | null;
}>;
