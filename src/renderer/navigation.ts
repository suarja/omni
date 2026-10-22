import type { EntryRef, RegistryView } from "../domain/project-source-registry";
import type { WriteSkillRequest } from "../shared/operations-write-skill-ipc";
import type { AgentHarness } from "../shared/agents-ipc";
import type { AiFunctionId } from "../shared/ai-gateway-ipc";
import type { ResourceContext, ResourceRef } from "../domain/resource-catalogue";
import type { SkillIntent } from "../shared/skill-management-ipc";
import type { RailSurface } from "./canvas/rail/rail-context";

export type Destination = "welcome" | "home" | "library" | "projects" | "review" | "activity" | "learn" | "settings";

export const ACADEMY_CTA_ROUTES = ["library-add", "agents-setup", "projects", "review", "library"] as const;

export type Route =
  | { screen: "home" }
  | {
      screen: "resource-canvas";
      context: ResourceContext;
      canvasPage?: import("./canvas/pages/page-navigation").CanvasPage;
      initialExternalSelection?: import("./canvas/pages/page-navigation").ExternalSelection;
      initialMarketplaceSkill?: import("./canvas/pages/page-navigation").MarketplaceSkillSelection;
      initialRailSurface?: RailSurface;
      initialProjectSheet?: "add" | "project";
      initialSettingsRoute?: Extract<Route, { screen: "settings-ai-connection" | "settings-ai-function" }>;
      initialOperation?: OperationRoute;
      initialPublicationRequest?: import("../shared/agents-ipc").AgentRequest;
      initialSkillRequest?: WriteSkillRequest;
      initialSkillIntent?: SkillIntent;
      initialSkillIntentId?: string;
      initialSkillRestoreOperationId?: string;
      initialSkillResultId?: string;
      initialSkillCopy?: Readonly<{ ref: Extract<ResourceRef, { kind: "artifact" }>; relativePath: string }>;
      requestId?: string;
    }
  | { screen: "library"; tab: "marketplaces" | "all" | "catalogue" }
  | { screen: "marketplace"; sourceId: string }
  | { screen: "package"; sourceId: string; packageId: string }
  | { screen: "library-add" }
  | { screen: "marketplace-create"; returnTo: "library" | "onboarding" }
  | { screen: "projects" }
  | { screen: "project"; projectId: string; tab: "overview" | "context" | "review" }
  | {
      screen: "asset";
      artifactId: string;
      from: { kind: "project"; projectId: string } | { kind: "library"; sourceId: string; packageId?: string };
    }
  | {
      screen: "assignment";
      sourceId: string;
      packageId: string;
      // Omitted: assign every artifact of the package (whole-plugin assignment).
      artifactPath?: string;
      returnTo: Route;
      preselectProjectId?: string;
      requestId?: string;
    }
  | { screen: "project-add"; projectId: string }
  | { screen: "review" }
  | { screen: "activity" }
  | { screen: "learn" }
  | { screen: "academy-lesson"; lang?: "en" | "fr"; kind: "course" | "tutorial" | "topic"; slug: string }
  | { screen: "activity-agents" }
  | { screen: "activity-agent"; sessionId: string }
  | { screen: "activity-worktrees"; projectId?: string }
  | { screen: "worktree-cleanup"; returnTo: Route }
  | { screen: "operation-import"; source: EntryRef; relativePath: string; returnTo: Route; requestId?: string }
  | { screen: "catalogue-entry"; ownerRepo: string; skill: string; returnTo: Route }
  | {
      screen: "add-to-project";
      ownerRepo: string;
      skill: string;
      projectId: string;
      returnTo: Route;
    }
  | {
      screen: "operation-import-catalogue";
      ownerRepo: string;
      skill: string;
      sourceId: string;
      grantHandle: string;
      relativePath: string;
      name: string;
      description?: string;
      returnTo: Route;
    }
  | {
      screen: "operation-compatible";
      sourceId: string;
      packageId?: string;
      harness: "claude-code" | "codex";
      returnTo: Route;
      requestId?: string;
    }
  | { screen: "operation-link-storefront"; requestId: string }
  | { screen: "operation-register-project"; requestId: string }
  | { screen: "operation-restore"; operationId: string }
  | { screen: "operation-receipt"; operationId: string; returnTo: Route }
  | { screen: "operation-apply"; projectId: string; bindingIds?: readonly string[] }
  | { screen: "operation-remove"; bindingId: string; projectId: string }
  | { screen: "operation-restore-apply"; operationId: string }
  | { screen: "settings" }
  | { screen: "settings-ai-connection" }
  | { screen: "settings-ai-function"; task: AiFunctionId }
  | { screen: "welcome" };

export type OperationRoute = Extract<
  Route,
  {
    screen:
      | "assignment"
      | "operation-apply"
      | "operation-remove"
      | "operation-import"
      | "operation-compatible"
      | "operation-receipt"
      | "operation-link-storefront"
      | "operation-register-project"
      | "operation-restore"
      | "operation-restore-apply"
      | "add-to-project"
      | "operation-import-catalogue";
  }
>;

export function routeForDestination(destination: Destination): Route {
  if (destination === "learn") return { screen: "learn" };
  if (destination === "review" || destination === "activity" || destination === "settings")
    return { screen: "resource-canvas", context: { kind: "workspace" }, initialRailSurface: destination };
  return { screen: "resource-canvas", context: { kind: "workspace" } };
}

export function rootDestination(route: Route): Destination {
  if (route.screen === "resource-canvas") return "home";
  if (route.screen === "academy-lesson") return "learn";
  if (route.screen === "settings-ai-connection" || route.screen === "settings-ai-function") return "settings";
  if (route.screen === "activity-agents" || route.screen === "activity-agent" || route.screen === "activity-worktrees")
    return "activity";
  if (
    route.screen === "project" ||
    route.screen === "project-add" ||
    (route.screen === "asset" && route.from.kind === "project") ||
    (route.screen === "operation-import" && route.source.kind === "project")
  )
    return "projects";
  if (
    route.screen === "asset" ||
    route.screen === "marketplace" ||
    route.screen === "package" ||
    (route.screen === "assignment" &&
      route.returnTo.screen !== "project" &&
      route.returnTo.screen !== "project-add" &&
      !(route.returnTo.screen === "asset" && route.returnTo.from.kind === "project")) ||
    route.screen === "library-add" ||
    route.screen === "marketplace-create"
  )
    return "library";
  if (route.screen === "assignment") return rootDestination(route.returnTo);
  if (route.screen === "operation-import") return "library";
  if (route.screen === "catalogue-entry") return route.returnTo.screen === "project" ? "projects" : "library";
  if (route.screen === "operation-import-catalogue") return "library";
  if (route.screen === "add-to-project") return "projects";
  if (route.screen === "operation-compatible") return "library";
  if (route.screen === "worktree-cleanup") return rootDestination(route.returnTo);
  if (
    route.screen === "operation-link-storefront" ||
    route.screen === "operation-restore" ||
    route.screen === "operation-register-project"
  )
    return "review";
  if (route.screen === "operation-receipt") return rootDestination(route.returnTo);
  if (route.screen === "operation-apply" || route.screen === "operation-restore-apply") return "review";
  if (route.screen === "operation-remove") return "projects";
  return route.screen;
}

export function entryForRoute(route: Route): EntryRef | null {
  if (route.screen === "resource-canvas")
    return route.initialOperation
      ? entryForRoute(route.initialOperation)
      : route.context.kind === "workspace"
        ? null
        : route.context.entry;
  if (route.screen === "project" || route.screen === "project-add") return { kind: "project", id: route.projectId };
  if (route.screen === "marketplace" || route.screen === "package") return { kind: "source", id: route.sourceId };
  if (route.screen === "asset")
    return route.from.kind === "project"
      ? { kind: "project", id: route.from.projectId }
      : { kind: "source", id: route.from.sourceId };
  if (route.screen === "operation-import") return route.source;
  if (route.screen === "operation-compatible") return { kind: "source", id: route.sourceId };
  if (route.screen === "assignment") return { kind: "source", id: route.sourceId };
  if (route.screen === "operation-apply" || route.screen === "operation-remove" || route.screen === "add-to-project")
    return { kind: "project", id: route.projectId };
  return null;
}

export function resolveLaunchDestination(_registry: RegistryView): "home" {
  return "home";
}
