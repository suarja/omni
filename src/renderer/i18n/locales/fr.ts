import { delivery } from "./fr/delivery";
import { externalLibrary } from "./fr/external-library";
import { storefronts } from "./fr/storefronts";
import { addResource } from "./fr/add-resource";
import { newSkill } from "./fr/new-skill";
import { skillActions } from "./fr/skill-actions";
import { agentSettings } from "./fr/agent-settings";
import { uxSettings } from "./fr/ux-settings";
import { rail } from "./fr/rail";
import type { Translations } from "./en";
import { workspace, navigation, bootstrap, home, welcome, learn } from "./fr/shell";
import { onboarding } from "./fr/onboarding";
import { review, reviewExtras, agents, library, marketplaceFlow, operations, assignment } from "./fr/destinations";
import { activity } from "./fr/activity";
import { lifecycle } from "./fr/lifecycle";
import { project, asset } from "./fr/project";
import { registry } from "./fr/registry";
import { plugins, artifacts, errors, inventory, changeReview, theme, settings } from "./fr/catalog";
import { settingsGit } from "./fr/settings-git";
import { settingsFeatures } from "./fr/settings-features";
import { agentsSetup } from "./fr/agents-setup";
import { receipt } from "./fr/receipt";
import { en } from "./en";
import { skillManagement } from "./fr/skill-management";
import { canvasSkillCopies } from "./fr/canvas-skill-copies";
import { projectView } from "./fr/project-view";
import { canvas } from "./fr/canvas";
import { canvasSetup } from "./fr/canvas-setup";

export const fr: Translations = {
  delivery,
  workspace,
  navigation,
  bootstrap,
  home,
  welcome,
  learn,
  agentsSetup,
  receipt,
  canvas: { ...canvas, ...canvasSkillCopies },
  projectView,
  skillActions,
  newSkill,
  addResource,
  storefronts,
  externalLibrary,
  uxSettings,
  agentSettings,
  rail,
  canvasSetup,
  skillManagement: { ...en.skillManagement, ...skillManagement },
  onboarding,
  review,
  reviewExtras,
  agents,
  activity,
  marketplaceFlow,
  operations: { ...operations, lifecycle },
  assignment,
  library,
  project,
  asset,
  registry,
  plugins,
  artifacts,
  errors,
  inventory,
  changeReview,
  theme,
  settings: {
    ...settings,
    groups: { ...settings.groups, git: settingsGit.group, features: settingsFeatures.group },
    rows: { ...settings.rows, git: settingsGit },
    features: settingsFeatures,
  },
};
