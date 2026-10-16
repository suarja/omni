import type { Route } from "../../navigation";

export type CanvasPage = Readonly<{ kind: "marketplace" | "library" }> | Readonly<{ kind: "source"; sourceId: string }>;
export type ExternalSelection = Readonly<{
  sourceId?: string;
  skillName?: string;
  skillPath?: string;
  useId?: string;
  view?: "source" | "skill" | "compare" | "install" | "add" | "copy";
  repository?: string;
  filter?: "all" | "unused";
  projectIds?: readonly string[];
}>;
export type MarketplaceSkillSelection = Readonly<{ path: string; packageId: string }>;
export function routeForCanvasPage(page: CanvasPage): Extract<Route, { screen: "resource-canvas" }> {
  return { screen: "resource-canvas", context: { kind: "workspace" }, canvasPage: page };
}
export function routeForExternal(selection: ExternalSelection): Extract<Route, { screen: "resource-canvas" }> {
  return {
    ...routeForCanvasPage(selection.sourceId ? { kind: "source", sourceId: selection.sourceId } : { kind: "library" }),
    ...(selection.view && selection.view !== "source" ? { initialExternalSelection: selection } : {}),
  };
}
