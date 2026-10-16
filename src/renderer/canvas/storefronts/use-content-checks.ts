import { useEffect, useState } from "react";
import type { DesktopApi } from "../../../shared/ipc";
import type { PublicationPlanSummary } from "../../../shared/publication-operations-ipc";
import { parsePublicationContentChecks } from "../../../shared/storefront-presentation-ipc";

export function useContentChecks(
  api: Partial<DesktopApi> | null,
  pluginId: string,
  revision: number,
): Readonly<{ summary: PublicationPlanSummary | null; error: boolean }> {
  const [state, setState] = useState<{
    pluginId: string;
    revision: number;
    summary: PublicationPlanSummary | null;
    error: boolean;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (!pluginId) return;
    if (!api?.readPublicationContentChecks) {
      setState({ pluginId, revision, summary: null, error: true });
      return;
    }
    void api
      .readPublicationContentChecks({ pluginId })
      .then((raw) => {
        const summary = parsePublicationContentChecks(raw);
        if (active) setState({ pluginId, revision, summary, error: false });
      })
      .catch(() => {
        if (active) setState({ pluginId, revision, summary: null, error: true });
      });
    return () => {
      active = false;
    };
  }, [api, pluginId, revision]);
  return state?.pluginId === pluginId && state.revision === revision ? state : { summary: null, error: false };
}
