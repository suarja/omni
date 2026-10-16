// What a task may carry off the machine (Brief 35a §1/§6 of the design doc): a provider that
// never leaves the machine (`none`, `agent`, `local`) is exempt; a provider that does (`api-key`,
// pi's remote connection and any future remote provider are refused per task unless
// every category the task declares is opted in.

import type { InferenceProviderId } from "./provider";

export type DataCategory = "marketplace-content" | "stack-files" | "transcripts" | "process-commands";

export const DATA_CATEGORIES: readonly DataCategory[] = [
  "marketplace-content",
  "stack-files",
  "transcripts",
  "process-commands",
];

/** Settings shape for the opt-in checkboxes (Settings · Intelligence, "What leaves this machine"). */
export type DataCategoryPreferences = Readonly<{
  marketplaceContent: boolean;
  stackFiles: boolean;
  transcripts: boolean;
  processCommands: boolean;
}>;

const LOCAL_PROVIDERS = new Set<InferenceProviderId>(["none", "agent"]);

/** True for a provider that runs on this machine (or not at all) and so never needs an opt-in. */
export function isLocalProvider(providerId: InferenceProviderId, scope?: "remote" | "local"): boolean {
  return scope === "local" || LOCAL_PROVIDERS.has(providerId);
}

function preferenceKey(category: DataCategory): keyof DataCategoryPreferences {
  switch (category) {
    case "marketplace-content":
      return "marketplaceContent";
    case "stack-files":
      return "stackFiles";
    case "transcripts":
      return "transcripts";
    case "process-commands":
      return "processCommands";
  }
}

/**
 * The categories a task requires that a remote provider is not opted in for — empty for a local
 * provider, and empty for a remote one once every required category is checked. A router (here:
 * `budget.ts`'s `run`) refuses the call outright when this is non-empty, before any content is
 * ever built into a prompt.
 */
export function refusedCategories(
  providerId: InferenceProviderId,
  required: readonly DataCategory[],
  preferences: DataCategoryPreferences,
  scope?: "remote" | "local",
): readonly DataCategory[] {
  if (isLocalProvider(providerId, scope)) return [];
  return required.filter((category) => !preferences[preferenceKey(category)]);
}
