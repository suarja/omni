import { externalLibrary } from "./en/external-library";
import { storefronts } from "./en/storefronts";
import { addResource } from "./en/add-resource";
import { newSkill } from "./en/new-skill";
import { skillActions } from "./en/skill-actions";
import { agentSettings } from "./en/agent-settings";
import { uxSettings } from "./en/ux-settings";
import { rail } from "./en/rail";
import { workspace, navigation, bootstrap, home, welcome, learn } from "./en/shell";
import { onboarding } from "./en/onboarding";
import {
  review,
  reviewExtras,
  agents,
  activity,
  library,
  marketplaceFlow,
  operations,
  assignment,
} from "./en/destinations";
import { lifecycle } from "./en/lifecycle";
import { project, asset } from "./en/project";
import { registry } from "./en/registry";
import { plugins, artifacts, errors, inventory, changeReview, theme, settings } from "./en/catalog";
import { settingsGit } from "./en/settings-git";
import { settingsFeatures } from "./en/settings-features";
import { agentsSetup } from "./en/agents-setup";
import { receipt } from "./en/receipt";
import { canvas } from "./en/canvas";
import { projectView } from "./en/project-view";
import { canvasSetup } from "./en/canvas-setup";
import { skillManagement } from "./en/skill-management";

type WidenStrings<Value> = Value extends string ? string : { readonly [Key in keyof Value]: WidenStrings<Value[Key]> };

type TranslationTree = {
  readonly [key: string]: string | TranslationTree;
};

function defineEnglish<const Value extends TranslationTree>(value: Value): WidenStrings<Value> {
  return value as unknown as WidenStrings<Value>;
}

export const en = defineEnglish({
  workspace,
  navigation,
  bootstrap,
  home,
  welcome,
  learn,
  agentsSetup,
  receipt,
  canvas,
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
  skillManagement,
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
});

export type Translations = typeof en;
