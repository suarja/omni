import { createContext, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { DEFAULT_FEATURES, type FeatureFlags as SettingsFeatureFlags } from "../shared/settings-ipc";
import type { DesktopApi } from "../shared/ipc";
import type { Route } from "./navigation";

export type FeatureFlags = SettingsFeatureFlags & Readonly<{ publicCatalogue?: boolean }>;

export type FeaturesContextValue = Readonly<{
  features: FeatureFlags;
  setFeatures: (features: FeatureFlags) => void;
}>;

const noopSetFeatures = (): void => undefined;

const FeaturesContext = createContext<FeaturesContextValue>({
  features: DEFAULT_FEATURES,
  setFeatures: noopSetFeatures,
});

// One source of truth for the renderer (brief A1): App.tsx reads settings once at boot and owns
// the state; every other component reads or updates it through this context instead of keeping
// a second copy. Until the boot read resolves (or if it fails), the default above keeps every
// gated surface off — the V1 default — so nothing gated ever flashes on screen.
export function FeaturesProvider({
  children,
  value,
}: Readonly<{ children: ReactNode; value: FeaturesContextValue }>): ReactElement {
  return <FeaturesContext.Provider value={value}>{children}</FeaturesContext.Provider>;
}

export function useFeatures(): FeaturesContextValue {
  return useContext(FeaturesContext);
}

// Owns the boot-time read for App.tsx: reads settings once, and until that resolves (or if it
// fails) keeps every feature off — the same default the context already falls back to. A
// missing or malformed `features` field (a stale mock, an unreachable bridge) falls back to the
// same default instead of throwing; Settings still shows its own load error independently.
export function useBootFeatures(api: DesktopApi | null): FeaturesContextValue {
  const [features, setFeatures] = useState<FeatureFlags>(DEFAULT_FEATURES);
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    if (!api?.getSettings) return;
    void api
      .getSettings()
      .then((settings) => setFeatures(settings.features ?? DEFAULT_FEATURES))
      .catch(() => undefined);
  }, [api]);
  return { features, setFeatures };
}

const LEARN_SCREENS = new Set<Route["screen"]>(["learn", "academy-lesson"]);
const ACTIVITY_AGENTS_SCREENS = new Set<Route["screen"]>([
  "activity-agents",
  "activity-agent",
  "activity-worktrees",
  "worktree-cleanup",
]);

// Deferred routes stay gated at the shell boundary, including direct links and agent entry points.
export function isRouteGated(route: Route, features: FeatureFlags): boolean {
  if (route.screen === "resource-canvas" && route.initialOperation)
    return isRouteGated(route.initialOperation, features);
  if (route.screen === "resource-canvas" && route.initialSettingsRoute)
    return isRouteGated(route.initialSettingsRoute, features);
  if (
    !features.publicCatalogue &&
    (route.screen === "catalogue-entry" ||
      route.screen === "add-to-project" ||
      route.screen === "operation-import-catalogue" ||
      (route.screen === "library" && route.tab === "catalogue"))
  )
    return true;
  if (!features.learn && LEARN_SCREENS.has(route.screen)) return true;
  if (!features.activityAgents && ACTIVITY_AGENTS_SCREENS.has(route.screen)) return true;
  if (!features.compose && route.screen === "settings-ai-function" && route.task === "compose") return true;
  return false;
}

export function gatedFallbackRoute(route: Route): Route {
  if (ACTIVITY_AGENTS_SCREENS.has(route.screen))
    return { screen: "resource-canvas", context: { kind: "workspace" }, initialRailSurface: "activity" };
  if (route.screen === "settings-ai-function" || (route.screen === "resource-canvas" && route.initialSettingsRoute))
    return { screen: "resource-canvas", context: { kind: "workspace" }, initialRailSurface: "settings" };
  return { screen: "resource-canvas", context: { kind: "workspace" } };
}
