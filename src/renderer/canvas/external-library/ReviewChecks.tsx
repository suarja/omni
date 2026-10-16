import { useProjectLabel } from "./presentation";
import { translateCount } from "../../i18n";
import type { ReactElement } from "react";
import { useI18n } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
import { CanvasGlyph } from "../CanvasGlyph";

export function ExternalReviewChecks(): ReactElement | null {
  const rail = useCanvasRail();
  const { t } = useI18n();
  if (!rail) return null;
  return (
    <>
      {rail.externalLibrary.error ? <p role="alert">{rail.externalLibrary.error}</p> : null}
      {rail.externalLibrary.review.map((item) => (
        <div className="rail-item" key={item.key} data-external-review={item.key}>
          <span className="rail-tile is-pending">
            <CanvasGlyph name="warn" />
          </span>
          <div>
            <strong>
              {item.kind === "failure"
                ? t("externalLibrary.failed")
                : item.kind === "modified"
                  ? t("externalLibrary.reviewModified", {
                      name: item.use!.skillKey,
                      project: useProjectLabel(item.use!, rail.externalLibrary.details.get(item.sourceId)?.uses ?? []),
                      source: item.sourceId,
                    })
                  : item.kind === "removed"
                    ? translateCount(t, "externalLibrary.reviewRemoved", item.count!)
                    : translateCount(t, "externalLibrary.askSummary", item.count!)}
            </strong>
            <small>
              {item.kind === "failure"
                ? `${useProjectLabel(item.use!, rail.externalLibrary.details.get(item.sourceId)?.uses ?? [])} · ${item.use!.skillKey} · ${item.use!.lastAutomaticFailure!.reason}`
                : item.kind === "removed"
                  ? t("externalLibrary.reviewRemovedHint")
                  : item.sourceId}
            </small>
          </div>
          <button
            type="button"
            className="canvas-secondary-button is-small"
            onClick={() => {
              const removed =
                item.kind === "removed"
                  ? [...rail.externalLibrary.details.values()]
                      .flatMap((details) => details.uses)
                      .find((use) => use.state === "removed" && !use.acknowledged)
                  : undefined;
              rail.openExternalDestination(
                removed
                  ? {
                      sourceId: removed.sourceId,
                      skillName: removed.skillKey,
                      skillPath: removed.skillPath,
                      useId: removed.id,
                      view: "skill",
                    }
                  : {
                      sourceId: item.sourceId,
                      ...(item.use
                        ? { useId: item.use.id, skillName: item.use.skillKey, skillPath: item.use.skillPath }
                        : {}),
                      view: "compare",
                    },
              );
            }}
          >
            {t(item.kind === "modified" ? "externalLibrary.compare" : "externalLibrary.view")}
          </button>
        </div>
      ))}
    </>
  );
}
