import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../../shared/ipc";
import type { AgentHarness } from "../../shared/agents-ipc";
import type { AgentMaintenanceState } from "../../shared/agent-maintenance-ipc";
import { parseAgentMaintenanceState } from "../../shared/agent-maintenance-ipc";
import { useReviewRevision } from "../review/use-review-revision";
import { useOptionalCanvasToast } from "../canvas/CanvasToast";
import { tCount, useI18n } from "../i18n";
import { agentName } from "./agent-utils";
const received = new WeakMap<Partial<DesktopApi>, Set<string>>();
export function useAgentMaintenance(
  api: Partial<DesktopApi> | null,
  openHistory: () => void,
): Readonly<{
  state: AgentMaintenanceState;
  error: string | null;
  retry(harness: AgentHarness): Promise<void>;
}> {
  const revision = useReviewRevision(api);
  const toast = useOptionalCanvasToast();
  const { t, language } = useI18n();
  const [state, setState] = useState<AgentMaintenanceState>({ updating: [], failures: [] });
  const [error, setError] = useState<string | null>(null);
  const retrying = useRef(false);
  useEffect(() => {
    let active = true;
    if (api?.getAgentMaintenance)
      void api
        .getAgentMaintenance()
        .then((state) => {
          if (active) {
            setState(parseAgentMaintenanceState(state));
            setError(null);
          }
        })
        .catch(() => {
          if (active) setError(t("agentSettings.unavailable"));
        });
    return () => {
      active = false;
    };
  }, [api, revision]);
  useEffect(() => {
    const notice = state.notice;
    if (!api || !notice || !toast) return;
    const seen = received.get(api) ?? new Set<string>();
    if (seen.has(notice.id)) return;
    seen.add(notice.id);
    received.set(api, seen);
    toast.show({
      message: tCount(
        "agentSettings.updateToast",
        notice.harnesses.length,
        {
          version: notice.version,
          agents: new Intl.ListFormat(language, { type: "conjunction" }).format(notice.harnesses.map(agentName)),
        },
        language,
      ),
      action: { label: t("agentSettings.details"), run: openHistory },
    });
  }, [api, state.notice, language, t, toast, openHistory]);
  async function retry(harness: AgentHarness): Promise<void> {
    if (!api?.retryAgentUpdate || retrying.current) return;
    retrying.current = true;
    setError(null);
    setState((state) => ({ ...state, updating: [...state.updating, harness] }));
    try {
      setState(parseAgentMaintenanceState(await api.retryAgentUpdate({ harness })));
    } catch (error) {
      setError(error instanceof Error ? error.message : t("agentSettings.unavailable"));
    } finally {
      retrying.current = false;
      setState((state) => ({ ...state, updating: state.updating.filter((item) => item !== harness) }));
    }
  }
  return { state, error, retry };
}
