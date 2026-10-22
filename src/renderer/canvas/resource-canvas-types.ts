import type { ResourceContext, ResourceRef, ResourceSnapshot } from "../../domain/resource-catalogue";
import type { EntryRef, Observation } from "../../domain/project-source-registry";
import type { DesktopApi } from "../../shared/ipc";
import type { WriteSkillRequest } from "../../shared/operations-write-skill-ipc";
import type { SkillIntent } from "../../shared/skill-management-ipc";
import type { Route, Destination } from "../navigation";
import type { CanvasSession } from "./spatial/spatial-types";
import type { WorkspaceSetupInputs } from "./setup/workspace-setup-types";
import type { ReactNode } from "react";
import type { RailSurface } from "./rail/rail-context";

export type ResourceCanvasProps = Readonly<{
  railServices?: Readonly<{
    api: DesktopApi | null;
    audit: import("../destination-state").DestinationAuditState &
      Partial<Pick<import("../audit/use-audit-session").AuditSession, "start" | "cancel">>;
    bindingPreviews?: readonly import("../review/binding-previews").BindingPreviewGroup[];
    mode: import("../theme/theme-provider").ThemeMode;
    onModeChange: (mode: import("../theme/theme-provider").ThemeMode) => void;
  }>;
  context: ResourceContext;
  canvasPage?: import("./pages/page-navigation").CanvasPage;
  initialExternalSelection?: import("./pages/page-navigation").ExternalSelection;
  initialMarketplaceSkill?: import("./pages/page-navigation").MarketplaceSkillSelection;
  onForward?: () => void;
  initialRailSurface?: RailSurface;
  initialProjectSheet?: "add" | "project";
  initialSettingsRoute?: Extract<Route, { screen: "settings-ai-connection" | "settings-ai-function" }>;
  routeSheet?: ReactNode;
  diagnostic?: string;
  registryLoading?: boolean;
  registryMutationBusy?: boolean;
  snapshot: ResourceSnapshot;
  api:
    | (Partial<DesktopApi> &
        Pick<
          DesktopApi,
          | "readArtifact"
          | "observeSkillCopies"
          | "compareSkillCopies"
          | "previewSkillOperation"
          | "refreshSkillOperation"
          | "applySkillOperation"
          | "readSkillOperationResult"
          | "readSkillVariantOrigin"
        > &
        Partial<
          Pick<
            DesktopApi,
            | "readProjectSkills"
            | "listSkillOperationRecoveries"
            | "onReviewChanged"
            | "listAgentRequests"
            | "observeSource"
            | "archiveEntry"
          >
        >)
    | null;
  onEnsureGrant: (entry: EntryRef) => Promise<string | null>;
  onObserveAdoptionSource?: (sourceId: string, isCurrent: () => boolean) => Promise<Observation | null>;
  onRefreshSkillAdoption?: () => Promise<void>;
  onNavigate: (route: Route) => void;
  onBack?: () => void;
  onRefresh: () => void;
  onNavigateDestination: (destination: Destination) => void;
  setup?: WorkspaceSetupInputs;
  session?: CanvasSession;
  initialPublicationRequest?: import("../../shared/agents-ipc").AgentRequest;
  initialSkillRequest?: WriteSkillRequest;
  initialSkillIntent?: SkillIntent;
  initialSkillIntentId?: string;
  initialSkillRestoreOperationId?: string;
  initialSkillResultId?: string;
  initialSkillCopy?: Readonly<{ ref: Extract<ResourceRef, { kind: "artifact" }>; relativePath: string }>;
  requestId?: string;
}>;
