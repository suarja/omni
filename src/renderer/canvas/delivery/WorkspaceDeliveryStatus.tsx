import type { ReactElement } from "react";
import { workshopSyncLabel } from "./sync-label";
import { useCanvasRail } from "../rail/rail-context";
import { translateCount, useI18n } from "../../i18n";
import "./delivery.css";

export function WorkspaceDeliveryStatus(): ReactElement | null {
  const rail = useCanvasRail(),
    { t } = useI18n();
  if (!rail) return null;
  const { status, error } = rail.delivery;
  const projects =
    status?.projects.filter((project) => project.conflicts || project.updates || project.unavailable).length ?? 0;
  const workshop = status?.workshop?.sync;
  const workshopAlert = workshop && workshop.status !== "current";
  if (!projects && !workshopAlert && !status?.plugins.behind && !error && !status?.diagnostics.length) return null;
  return (
    <div className="workspace-delivery-status" data-testid="workspace-delivery-status" aria-live="polite">
      {workshopAlert ? (
        <button className="canvas-secondary-button is-small" type="button" onClick={() => rail.open("delivery")}>
          {workshopSyncLabel(workshop, t)}
        </button>
      ) : null}
      {status?.plugins.behind ? (
        <button className="canvas-secondary-button is-small" type="button" onClick={() => rail.open("delivery")}>
          {translateCount(t, "delivery.pluginsBehind", status.plugins.behind)}
        </button>
      ) : null}
      {projects ? (
        <button className="canvas-secondary-button is-small" type="button" onClick={() => rail.open("review")}>
          {translateCount(t, "delivery.projects", projects)}
        </button>
      ) : null}
      {error || status?.diagnostics.length ? (
        <button className="canvas-secondary-button is-small" type="button" onClick={() => rail.open("delivery")}>
          {t("delivery.unavailable")}
        </button>
      ) : null}
    </div>
  );
}
