import { useEffect, useState } from "react";
import type { DesktopApi } from "../../shared/ipc";
import type { AgentStatus } from "../../shared/agents-ipc";
import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_GUARD_SETTINGS,
  DEFAULT_EXTERNAL_LIBRARY_SETTINGS,
  type AiSettings,
  type ApprovalMode,
  type FeatureFlags,
  type SettingsSetRequest,
} from "../../shared/settings-ipc";
import { useFeatures } from "../features";
import { useReviewRevision } from "../review/use-review-revision";

type SheetSettings = Readonly<{
  paths: { marketplace?: string; store?: string };
  externalLibraryUpdates: "auto" | "ask";
  saveExternalLibrary: (updates: "auto" | "ask", onSaved?: () => void) => void;
  commitChanges: boolean;
  personalApproval: ApprovalMode;
  projectsApproval: ApprovalMode;
  intelligence: AiSettings;
  status: AgentStatus | null;
  loaded: boolean;
  rotating: boolean;
  error: boolean;
  features: FeatureFlags;
  saveApproval: (target: "personalMarketplace" | "projects", next: ApprovalMode) => void;
  saveGit: (next: boolean) => void;
  saveIntelligence: (next: AiSettings) => void;
  saveFeature: (key: keyof FeatureFlags, next: boolean) => void;
  rotate: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}>;

export function useSheetSettings(api: DesktopApi | null): SheetSettings {
  const { features, setFeatures } = useFeatures();
  const revision = useReviewRevision(api);
  const [paths, setPaths] = useState<{ marketplace?: string; store?: string }>({});
  const [commitChanges, setCommitChanges] = useState(true);
  const [personalApproval, setPersonalApproval] = useState<ApprovalMode>("conversation");
  const [projectsApproval, setProjectsApproval] = useState<ApprovalMode>("omni");
  const [guard, setGuard] = useState(DEFAULT_GUARD_SETTINGS);
  const [externalLibrary, setExternalLibrary] = useState(DEFAULT_EXTERNAL_LIBRARY_SETTINGS);
  const [intelligence, setIntelligence] = useState<AiSettings>(DEFAULT_AI_SETTINGS);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [loaded, setLoaded] = useState(!api?.getAgentStatus);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      ?.getOperationPaths?.()
      .then((value) => {
        if (active) setPaths({ marketplace: value.marketplace?.displayRoot, store: value.store.displayRoot });
      })
      .catch(() => undefined);
    void api
      ?.getSettings?.()
      .then((value) => {
        if (!active) return;
        setCommitChanges(value.git.commitChanges);
        setPersonalApproval(value.agents.approval.personalMarketplace);
        setProjectsApproval(value.agents.approval.projects);
        setGuard(value.agents.guard);
        setExternalLibrary(value.externalLibrary);
        setIntelligence(value.ai);
      })
      .catch(() => {
        if (active) setError(true);
      });
    void api
      ?.getAgentStatus?.()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [api, revision]);
  async function refreshStatus(): Promise<void> {
    if (api?.getAgentStatus) setStatus(await api.getAgentStatus());
  }
  function persist(patch: Partial<SettingsSetRequest>, rollback: () => void, onSaved?: () => void): void {
    setError(false);
    void api
      ?.setSettings?.({
        commitChanges,
        agents: { approval: { personalMarketplace: personalApproval, projects: projectsApproval }, guard },
        ai: intelligence,
        features,
        externalLibrary,
        ...patch,
      })
      .then(() => onSaved?.())
      .catch(() => {
        rollback();
        setError(true);
      });
  }
  function saveApproval(target: "personalMarketplace" | "projects", next: ApprovalMode): void {
    const previous = target === "personalMarketplace" ? personalApproval : projectsApproval;
    const set = target === "personalMarketplace" ? setPersonalApproval : setProjectsApproval;
    set(next);
    persist(
      {
        agents: {
          approval: {
            personalMarketplace: target === "personalMarketplace" ? next : personalApproval,
            projects: target === "projects" ? next : projectsApproval,
          },
          guard,
        },
      },
      () => set(previous),
    );
  }
  function saveExternalLibrary(updates: "auto" | "ask", onSaved?: () => void): void {
    const previous = externalLibrary;
    setExternalLibrary({ updates });
    persist({ externalLibrary: { updates } }, () => setExternalLibrary(previous), onSaved);
  }
  function saveGit(next: boolean): void {
    const previous = commitChanges;
    setCommitChanges(next);
    persist({ commitChanges: next }, () => setCommitChanges(previous));
  }
  function saveIntelligence(next: AiSettings): void {
    const previous = intelligence;
    setIntelligence(next);
    persist({ ai: next }, () => setIntelligence(previous));
  }
  function saveFeature(key: keyof FeatureFlags, next: boolean): void {
    const value = { ...features, [key]: next };
    setFeatures(value);
    persist({ features: value }, () => setFeatures(features));
  }
  async function rotate(): Promise<void> {
    if (!api?.rotateAgentToken || rotating) return;
    setRotating(true);
    setError(false);
    try {
      setStatus(await api.rotateAgentToken());
    } catch {
      setError(true);
    } finally {
      setRotating(false);
    }
  }
  return {
    externalLibraryUpdates: externalLibrary.updates,
    saveExternalLibrary,
    paths,
    commitChanges,
    personalApproval,
    projectsApproval,
    intelligence,
    status,
    loaded,
    rotating,
    error,
    features,
    saveApproval,
    saveGit,
    saveIntelligence,
    saveFeature,
    rotate,
    refreshStatus,
  };
}
