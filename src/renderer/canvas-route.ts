import { entryForRoute, type Route } from "./navigation";

export type CanvasRoute = Extract<Route, { screen: "resource-canvas" }>;

// Remaining operation return links and Academy CTAs resolve through the same canvas entry.
export function resolveCanvasRoute(route: Route): CanvasRoute | null {
  const workspace: CanvasRoute = { screen: "resource-canvas", context: { kind: "workspace" } };
  switch (route.screen) {
    case "resource-canvas":
      return route;
    case "assignment":
    case "operation-apply":
    case "operation-remove":
    case "operation-import":
    case "operation-compatible":
    case "operation-receipt":
    case "operation-register-project":
    case "operation-restore":
    case "operation-restore-apply":
    case "add-to-project":
    case "operation-import-catalogue": {
      const entry = entryForRoute(route);
      return {
        ...workspace,
        context: entry ? { kind: "entry", entry } : workspace.context,
        initialOperation: route,
        ...("requestId" in route ? { requestId: route.requestId } : {}),
      };
    }
    case "library":
      return route.tab === "catalogue" ? null : workspace;
    case "home":
    case "welcome":
    case "projects":
      return workspace;
    case "review":
    case "activity":
    case "settings":
      return { ...workspace, initialRailSurface: route.screen };
    case "library-add":
    case "marketplace-create":
      return { ...workspace, initialRailSurface: "marketplace" };
    case "project-add":
      return {
        ...workspace,
        context: { kind: "entry", entry: { kind: "project", id: route.projectId } },
        initialProjectSheet: "add",
      };
    case "project":
      return { ...workspace, context: { kind: "entry", entry: { kind: "project", id: route.projectId } } };
    case "marketplace":
      return { ...workspace, context: { kind: "entry", entry: { kind: "source", id: route.sourceId } } };
    case "package":
      return {
        ...workspace,
        context: { kind: "package", entry: { kind: "source", id: route.sourceId }, packageId: route.packageId },
      };
    case "asset":
      return {
        ...workspace,
        context: {
          kind: "artifact",
          artifactId: route.artifactId,
          entry:
            route.from.kind === "project"
              ? { kind: "project", id: route.from.projectId }
              : { kind: "source", id: route.from.sourceId },
        },
      };
    case "settings-ai-connection":
    case "settings-ai-function":
      return { ...workspace, initialRailSurface: "settings", initialSettingsRoute: route };
    default:
      return null;
  }
}
