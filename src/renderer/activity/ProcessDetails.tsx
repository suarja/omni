// The process row's "Details" disclosure (D4): started, elapsed, state, working directory, and
// — for a root process only, fetched on demand once this row is actually expanded — the ports it
// listens on. Reuses the tree's own expand/collapse affordance (TreeList's chevron) rather than
// adding a second toggle in the row's `side` area: every process node gets this as its first
// synthetic child, so opening a row's children is "opening its details."
import { useEffect, useState, type ReactElement } from "react";

import type { AgentProcess } from "../../shared/activity-ipc";
import type { DesktopApi } from "../../shared/ipc";
import type { TreeNode } from "../components/ui/TreeList";
import { useI18n } from "../i18n";
import { formatElapsed, type ElapsedLanguage } from "./format";

function ProcessDetailsSub({
  api,
  language,
  process,
}: Readonly<{ api: DesktopApi | null; language: ElapsedLanguage; process: AgentProcess }>): ReactElement {
  const { t } = useI18n();
  const [ports, setPorts] = useState<readonly Readonly<{ pid: number; port: number }>[] | null>(null);

  useEffect(() => {
    if (process.depth !== 0 || !api?.getListeningPorts) return undefined;
    let active = true;
    void api
      .getListeningPorts({ pids: [process.pid] })
      .then((response) => {
        if (active) setPorts(response.ports);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, process.depth, process.pid]);

  const started = process.startedAt
    ? new Date(process.startedAt).toLocaleString(language === "fr" ? "fr-FR" : "en-US")
    : undefined;
  const parts = [
    started ? t("activity.detailsStarted", { started }) : undefined,
    t("activity.detailsElapsed", { elapsed: formatElapsed(process.elapsedSeconds, language) }),
    process.state ? t(`activity.state.${process.state}`) : undefined,
    process.cwd,
    ports?.length ? t("activity.detailsPorts", { ports: ports.map((port) => port.port).join(", ") }) : undefined,
  ].filter(Boolean);
  return <span className="activity-process-details">{parts.join(" · ")}</span>;
}

export function processDetailsNode(
  process: AgentProcess,
  api: DesktopApi | null,
  language: ElapsedLanguage,
  t: ReturnType<typeof useI18n>["t"],
): TreeNode {
  return {
    id: `${process.pid}:details`,
    item: {
      dataTestId: `activity-process-details-${process.pid}`,
      name: t("activity.detailsHeading"),
      sub: <ProcessDetailsSub api={api} language={language} process={process} />,
    },
  };
}
