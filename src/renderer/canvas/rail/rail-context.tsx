import { usePersonalMarketplace } from "../use-personal-marketplace";
import { useWorkspaceMap } from "../setup/use-workspace-map";
import {
  routeForCanvasPage,
  routeForExternal,
  type ExternalSelection,
  type MarketplaceSkillSelection,
} from "../pages/page-navigation";
import { useExternalLibrary } from "../external-library/use-external-library";
import { useStorefronts } from "../storefronts/use-storefronts";
import type { AgentRequest } from "../../../shared/agents-ipc";
import type { ExternalUse } from "../../../shared/external-library-ipc";
import { useAgentMaintenance } from "../../agents/use-agent-maintenance";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ManagedSkillUse } from "../../../domain/skill-reconciliation/types";
import { parseWorkspaceSkillUsesResponse } from "../../../shared/workspace-skill-uses-ipc";
import { useReviewRevision } from "../../review/use-review-revision";
import { readObservedProjectSkills } from "./observed-project-skills";
import type { ResourceSnapshot } from "../../../domain/resource-catalogue";
import type { ProjectSkills } from "../../../shared/project-skills-ipc";
import type { CanvasSession } from "../spatial/spatial-types";
import type { ResourceCanvasProps } from "../resource-canvas-types";
import { createCanvasSession } from "../spatial/canvas-session";
import { useOmniAgentRequestsState } from "../../review/agent-requests";

export type RailDestination = "review" | "activity" | "settings";
export type RailSurface =
  | RailDestination
  | "project"
  | "marketplace"
  | "owned-marketplace"
  | "draft"
  | "storefront"
  | "publish"
  | "external-library"
  | "marketplace-skill";
export type PublishSelection = Readonly<{
  pluginId?: string;
  storefrontId?: string;
  update?: boolean;
  retryOperationId?: string;
  agentRequest?: AgentRequest;
}>;
type CachedSkills = Readonly<{ key: string; data: ProjectSkills }>;
const sessions = new WeakMap<CanvasSession, ReadonlyMap<string, CachedSkills>>();
function projectKey(snapshot: ResourceSnapshot, id: string): string {
  const project = snapshot.registry.projects.find((item) => item.ref.id === id && !item.archivedAt);
  const evidence = snapshot.roots.find((item) => item.entry.kind === "project" && item.entry.id === id)?.evidence;
  return JSON.stringify([
    project?.displayRoot,
    project?.availability,
    evidence?.status === "observed" ? evidence.observation.observedAt : evidence?.status,
  ]);
}
function useRailState(canvas: ResourceCanvasProps) {
  const workspaceMap = useWorkspaceMap(canvas.railServices?.api ?? canvas.api, canvas.snapshot.registry);
  const contextStorefrontId =
    canvas.context.kind === "entry" &&
    canvas.context.entry.kind === "source" &&
    canvas.snapshot.registry.sources.some(
      (source) =>
        source.ref.id === (canvas.context.kind === "entry" ? canvas.context.entry.id : "") &&
        source.role === "storefront" &&
        !source.archivedAt,
    )
      ? canvas.context.entry.id
      : null;
  const [localSession] = useState(createCanvasSession);
  const session = canvas.session ?? localSession;
  const snapshot = useRef(canvas.snapshot);
  snapshot.current = canvas.snapshot;
  const [saved, setSaved] = useState(() => sessions.get(session) ?? new Map<string, CachedSkills>());
  const [surface, setSurface] = useState<RailSurface | null>(
    canvas.initialPublicationRequest
      ? "publish"
      : contextStorefrontId
        ? "storefront"
        : (canvas.initialRailSurface ?? null),
  );
  const storefronts = useStorefronts(canvas);
  const externalLibrary = useExternalLibrary(canvas);
  const personal = usePersonalMarketplace(
    canvas,
    canvas.canvasPage?.kind === "marketplace" || surface === "owned-marketplace" || surface === "marketplace-skill"
      ? "observe"
      : "cached",
  );
  const [marketplaceSkill, setMarketplaceSkill] = useState<MarketplaceSkillSelection | undefined>(
    canvas.initialMarketplaceSkill,
  );
  const [externalSelection, setExternalSelection] = useState<ExternalSelection>(canvas.initialExternalSelection ?? {});
  const [selectedRemovedUse, setSelectedRemovedUse] = useState<ExternalUse | undefined>();
  const [storefrontId, setStorefrontId] = useState<string | null>(contextStorefrontId);
  const [publishSelection, setPublishSelection] = useState<PublishSelection>(
    canvas.initialPublicationRequest?.request.kind === "publish-plugin"
      ? {
          agentRequest: canvas.initialPublicationRequest,
          pluginId: canvas.initialPublicationRequest.request.pluginId,
          storefrontId: canvas.initialPublicationRequest.request.storefrontId,
        }
      : {},
  );
  const [newSkillPackageId, setNewSkillPackageId] = useState<string | undefined>();
  const maintenance = useAgentMaintenance(canvas.railServices?.api ?? canvas.api, () => setSurface("activity"));
  const contextKey = JSON.stringify(canvas.context);
  useEffect(() => {
    setSurface(
      canvas.initialPublicationRequest
        ? "publish"
        : contextStorefrontId
          ? "storefront"
          : (canvas.initialRailSurface ?? null),
    );
    if (canvas.initialPublicationRequest?.request.kind === "publish-plugin")
      setPublishSelection({
        agentRequest: canvas.initialPublicationRequest,
        pluginId: canvas.initialPublicationRequest.request.pluginId,
        storefrontId: canvas.initialPublicationRequest.request.storefrontId,
      });
    setExternalSelection(canvas.initialExternalSelection ?? {});
    setMarketplaceSkill(canvas.initialMarketplaceSkill);
    if (canvas.initialExternalSelection) setSurface("external-library");
    if (canvas.initialMarketplaceSkill) setSurface("marketplace-skill");
    setStorefrontId(contextStorefrontId);
    setMenuOpen(false);
  }, [
    canvas.initialRailSurface,
    canvas.initialSettingsRoute,
    canvas.initialPublicationRequest,
    contextStorefrontId,
    contextKey,
    JSON.stringify(canvas.canvasPage),
    JSON.stringify(canvas.initialExternalSelection),
    JSON.stringify(canvas.initialMarketplaceSkill),
  ]);
  const [menuOpen, setMenuOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const blocked = useRef(false);
  const requests = useOmniAgentRequestsState(canvas.api);
  const reviewRevision = useReviewRevision(canvas.api);
  const [uses, setUses] = useState<readonly ManagedSkillUse[]>([]);
  const [usesUnavailable, setUsesUnavailable] = useState(!canvas.api?.readWorkspaceSkillUses);
  useEffect(() => {
    let active = true;
    if (!canvas.api?.readWorkspaceSkillUses) {
      setUses([]);
      setUsesUnavailable(true);
      return;
    }
    void canvas.api
      .readWorkspaceSkillUses()
      .then((raw) => {
        if (!active) return;
        const result = parseWorkspaceSkillUsesResponse(raw);
        setUses(result.status === "ready" ? result.uses : []);
        setUsesUnavailable(result.status !== "ready");
      })
      .catch(() => {
        if (active) {
          setUses([]);
          setUsesUnavailable(true);
        }
      });
    return () => {
      active = false;
    };
  }, [canvas.api, reviewRevision]);
  const rememberSkills = useCallback(
    (data: ProjectSkills): void => {
      const key = projectKey(snapshot.current, data.projectId);
      setSaved((current) => {
        if (current.get(data.projectId)?.data === data && current.get(data.projectId)?.key === key) return current;
        const next = new Map(current).set(data.projectId, { key, data });
        sessions.set(session, next);
        return next;
      });
    },
    [session],
  );
  function rememberOpener(): void {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  function open(next: RailSurface): void {
    if (blocked.current) return;
    if (next === "owned-marketplace") {
      setSurface(null);
      canvas.onNavigate(routeForCanvasPage({ kind: "marketplace" }));
      return;
    }
    if (!menuOpen && (!surface || next === "review" || next === "activity" || next === "settings")) rememberOpener();
    setMenuOpen(false);
    setSurface((current) => (current === next ? null : next));
  }
  function close(): void {
    if (blocked.current) return;
    setSurface(null);
    setMenuOpen(false);
    requestAnimationFrame(() => opener.current?.isConnected && opener.current.focus());
  }
  function closeMenu(): void {
    if (blocked.current) return;
    setMenuOpen(false);
    requestAnimationFrame(() => opener.current?.isConnected && opener.current.focus());
  }
  function toggleMenu(): void {
    if (blocked.current) return;
    rememberOpener();
    setMenuOpen((current) => !current);
  }
  const cachedProjectSkills = [...saved].flatMap(([id, value]) =>
    value.key === projectKey(canvas.snapshot, id) ? [value.data] : [],
  );
  function selectExternal(selection: ExternalSelection): void {
    if (!surface) rememberOpener();
    setMenuOpen(false);
    const use =
      selection.sourceId && selection.useId
        ? externalLibrary.details.get(selection.sourceId)?.uses.find((item) => item.id === selection.useId)
        : undefined;
    setSelectedRemovedUse(use?.state === "removed" ? use : undefined);
    setExternalSelection(selection);
    setSurface(
      selection.view === "add"
        ? "marketplace"
        : selection.view && selection.view !== "source"
          ? "external-library"
          : null,
    );
  }
  return {
    canvas,
    workspaceMap,
    storefronts,
    externalLibrary,
    personal,
    marketplaceSkill,
    openMarketplaceSkill: (selection: MarketplaceSkillSelection): void => {
      if (blocked.current) return;
      rememberOpener();
      setMarketplaceSkill(selection);
      setSurface("marketplace-skill");
      canvas.onNavigate({
        screen: "resource-canvas",
        context: canvas.context,
        canvasPage: canvas.canvasPage,
        initialMarketplaceSkill: selection,
      });
    },
    openPlugins: (): void => {
      if (!blocked.current) setSurface("owned-marketplace");
    },
    externalSelection,
    selectedRemovedUse,
    openExternalDestination: (selection: ExternalSelection = {}): void => {
      if (blocked.current) return;
      selectExternal(selection);
      if (selection.view !== "add") canvas.onNavigate(routeForExternal(selection));
    },
    openExternalContext: (selection: ExternalSelection): void => {
      if (blocked.current) return;
      selectExternal(selection);
      canvas.onNavigate({
        screen: "resource-canvas",
        context: canvas.context,
        canvasPage: canvas.canvasPage,
        initialExternalSelection: selection,
      });
    },
    storefrontId,
    publishSelection,
    newSkillPackageId,
    openStorefront: (sourceId: string): void => {
      if (blocked.current) return;
      rememberOpener();
      setMenuOpen(false);
      setStorefrontId(sourceId);
      setSurface("storefront");
    },
    openPublish: (selection: PublishSelection = {}): void => {
      if (blocked.current) return;
      rememberOpener();
      setMenuOpen(false);
      setPublishSelection(selection);
      setSurface("publish");
    },
    openNewSkill: (packageId?: string): void => {
      if (blocked.current) return;
      rememberOpener();
      setNewSkillPackageId(packageId);
      setSurface("draft");
    },
    surface,
    menuOpen,
    requests,
    maintenance,
    open,
    close,
    toggleMenu,
    closeMenu,
    blocked,
    rememberSkills,
    uses,
    usesUnavailable,
    cachedProjectSkills,
    projectSkills: [
      ...new Map([
        ...readObservedProjectSkills(canvas.snapshot, uses).map((data) => [data.projectId, data] as const),
        ...cachedProjectSkills.map((data) => [data.projectId, data] as const),
      ]).values(),
    ],
    overlayOpen: surface !== null || Boolean(canvas.routeSheet),
  };
}
type RailState = ReturnType<typeof useRailState>;
const RailContext = createContext<RailState | null>(null);
export function CanvasRailProvider(
  props: Readonly<{ canvas: ResourceCanvasProps; children: ReactNode }>,
): ReactElement {
  const state = useRailState(props.canvas);
  return <RailContext.Provider value={state}>{props.children}</RailContext.Provider>;
}
export function useCanvasRail(): RailState | null {
  return useContext(RailContext);
}
