import type { ExternalLibraryUiDesktopApi } from "./external-library-ui-ipc";
import type { StorefrontPresentationDesktopApi } from "./storefront-presentation-ipc";
import type { ProjectInspectionDesktopApi } from "./project-inspection-ipc";
import type { AgentMaintenanceDesktopApi } from "./agent-maintenance-ipc";
import type { RegistryDesktopApi } from "./registry-ipc";
import type { ArtifactDesktopApi } from "./artifact-ipc";
import type { IdentityDesktopApi } from "./identity-ipc";
import type { OperationsDesktopApi } from "./operations-ipc";
import type { BindingsDesktopApi } from "./bindings-ipc";
import type { ActivityDesktopApi } from "./activity-ipc";
import type { ApplyDesktopApi } from "./apply-ipc";
import type { LoginItemDesktopApi } from "./login-item-ipc";
import type { AppUpdatesDesktopApi } from "./app-updates-ipc";
import type { SettingsDesktopApi } from "./settings-ipc";
import type { AgentsDesktopApi } from "./agents-ipc";
import type { GuardDesktopApi } from "./guard-ipc";
import type { StackProfileDesktopApi } from "./stack-profile-ipc";
import type { CatalogueDesktopApi } from "./catalogue-ipc";
import type { AiGatewayDesktopApi } from "./ai-gateway-ipc";
import type { InferenceDesktopApi } from "./inference-ipc";
import type { AcademyDesktopApi } from "./academy-ipc";
import type { AgentJobsDesktopApi } from "./agent-jobs-ipc";
import type { SkillManagementDesktopApi } from "./skill-management-ipc";
import type { SkillReconciliationDesktopApi } from "./skill-reconciliation-ipc";
import type { SkillCopyComparisonDesktopApi } from "./skill-copy-comparison-ipc";

import type { ReviewEventsDesktopApi } from "./review-events";
import type { StorefrontsDesktopApi } from "./storefronts-ipc";
import type { ExternalLibraryDesktopApi } from "./external-library-ipc";

export interface DesktopApi
  extends
    RegistryDesktopApi,
    Partial<StorefrontsDesktopApi>,
    Partial<ExternalLibraryDesktopApi>,
    Partial<ExternalLibraryUiDesktopApi>,
    Partial<StorefrontPresentationDesktopApi>,
    Partial<ProjectInspectionDesktopApi>,
    Partial<ReviewEventsDesktopApi>,
    Partial<ArtifactDesktopApi>,
    Partial<IdentityDesktopApi>,
    Partial<OperationsDesktopApi>,
    Partial<BindingsDesktopApi>,
    Partial<ActivityDesktopApi>,
    Partial<ApplyDesktopApi>,
    Partial<SettingsDesktopApi>,
    Partial<LoginItemDesktopApi>,
    Partial<AppUpdatesDesktopApi>,
    Partial<AgentsDesktopApi>,
    Partial<AgentMaintenanceDesktopApi>,
    Partial<GuardDesktopApi>,
    Partial<StackProfileDesktopApi>,
    Partial<CatalogueDesktopApi>,
    Partial<AiGatewayDesktopApi>,
    Partial<InferenceDesktopApi>,
    Partial<AcademyDesktopApi>,
    Partial<AgentJobsDesktopApi>,
    Partial<SkillManagementDesktopApi>,
    Partial<SkillReconciliationDesktopApi>,
    Partial<SkillCopyComparisonDesktopApi> {}
