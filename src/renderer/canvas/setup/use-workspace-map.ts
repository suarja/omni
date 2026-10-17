import { useEffect, useRef, useState } from "react";
import type { AgentStatus } from "../../../shared/agents-ipc";
import type { RegistryView } from "../../../domain/project-source-registry";
import { useReviewRevision } from "../../review/use-review-revision";
import { deriveWorkspaceSetupProgress, type WorkspaceSetupProgress } from "./workspace-map-state";
import {
  workspaceMapReads,
  readWorkspaceMapPreferences,
  readWorkspaceMapAgents,
  refreshWorkspaceMapAgents,
  retainWorkspaceSetupPreference,
  type WorkspaceMapApi,
} from "./workspace-map-reads";

export type WorkspaceMapState = Readonly<{
  progress: WorkspaceSetupProgress;
  hidden: boolean;
  loading: boolean;
  saving: boolean;
  error: boolean;
  canSave: boolean;
  setHidden(hidden: boolean): Promise<void>;
}>;
export function useWorkspaceMap(api: WorkspaceMapApi | null, registry: RegistryView): WorkspaceMapState {
  const revision = useReviewRevision(api);
  const previousRevision = useRef(revision);
  const received = api ? workspaceMapReads(api) : null;
  const [status, setStatus] = useState<AgentStatus | null>(received?.status ?? null);
  const [hidden, setHidden] = useState(received?.hidden ?? false);
  const [loading, setLoading] = useState(
    Boolean(api?.getSettings || api?.getAgentStatus) &&
      (received?.hidden === undefined || received.status === undefined),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const mounted = useRef(false);
  const locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!api) return;
    if (previousRevision.current !== revision) refreshWorkspaceMapAgents(api);
    previousRevision.current = revision;
    let current = true;
    void Promise.allSettled([
      readWorkspaceMapPreferences(api).then((hidden) => {
        if (current) setHidden(hidden);
      }),
      readWorkspaceMapAgents(api).then((status) => {
        if (current) setStatus(status);
      }),
    ])
      .then((results) => {
        if (current) setError(results.some((result) => result.status === "rejected"));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, revision]);

  async function setPreference(next: boolean): Promise<void> {
    if (!api?.getSettings || !api.setSettings || locked.current) return;
    locked.current = true;
    setSaving(true);
    setError(false);
    try {
      const current = await api.getSettings();
      const saved = await api.setSettings({
        commitChanges: current.git.commitChanges,
        agents: current.agents,
        ai: current.ai,
        features: current.features,
        externalLibrary: current.externalLibrary,
        workspaceSetupHidden: next,
      });
      retainWorkspaceSetupPreference(api, saved.workspaceSetupHidden ?? false);
      if (mounted.current) setHidden(saved.workspaceSetupHidden ?? false);
    } catch {
      if (mounted.current) setError(true);
    } finally {
      locked.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return {
    progress: deriveWorkspaceSetupProgress(registry, status),
    hidden,
    loading,
    saving,
    error,
    canSave: Boolean(api?.getSettings && api?.setSettings),
    setHidden: setPreference,
  };
}
