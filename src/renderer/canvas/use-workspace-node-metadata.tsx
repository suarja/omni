import { LoadingSkeleton } from "../components/ui/Skeleton";
import { translateCount } from "../i18n";
import { externalLibraryRef } from "./external-library/workspace";
import { needsComparison, waitsForUpdate } from "./external-library/presentation";
import type { ReactNode } from "react";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import { useI18n } from "../i18n";
import { useCanvasRail } from "./rail/rail-context";
import { canvasNodeMetadata } from "./canvas-node-metadata";

export function useWorkspaceNodeMetadata(
  canvas: ResourceCanvasProps | undefined,
  active: boolean,
): ReadonlyMap<string, ReactNode> {
  const { t } = useI18n();
  const rail = useCanvasRail();
  const metadata = new Map<string, ReactNode>(
    active && canvas ? canvasNodeMetadata(canvas.snapshot, t, rail?.uses, rail?.cachedProjectSkills) : [],
  );
  if (active && canvas)
    for (const source of canvas.snapshot.registry.sources.filter(
      (source) => source.role === "storefront" && !source.archivedAt,
    )) {
      const report = rail?.storefronts.drift?.storefronts.find((item) => item.sourceId === source.ref.id);
      metadata.set(
        JSON.stringify({ kind: "entry", entry: source.ref }),
        report ? (
          <>
            {t("storefronts.public")} ·{" "}
            {t(report.plugins.length === 1 ? "storefronts.plugins.one" : "storefronts.plugins.other", {
              count: report.plugins.length,
            })}{" "}
            {report.behindPlugins ? (
              <>
                ·{" "}
                <span className="project-chip is-update">
                  {t("storefronts.behind", { count: report.behindPlugins })}
                </span>
              </>
            ) : null}
            {report.unavailablePlugins ? <> · {t("canvas.notRead")}</> : null}
          </>
        ) : rail?.storefronts.loading ? (
          <LoadingSkeleton label={t("canvas.loadingSurface", { surface: source.displayName })} variant="inline" />
        ) : (
          t("canvas.notRead")
        ),
      );
    }
  if (active && rail?.externalLibrary.list) {
    const library = rail.externalLibrary;
    const uses = [...library.details.values()].flatMap((details) => details.uses);
    const compare = uses.filter(needsComparison).length;
    metadata.set(
      JSON.stringify(externalLibraryRef),
      <>
        {translateCount(t, "externalLibrary.followed", library.list!.sources.length)}
        {compare ? (
          <>
            {" "}
            · <span className="project-chip is-modified">{t("externalLibrary.compareCount", { count: compare })}</span>
          </>
        ) : null}
      </>,
    );
    for (const project of canvas?.snapshot.registry.projects ?? []) {
      const key = JSON.stringify({ kind: "entry", entry: project.ref });
      const mine =
        rail.projectSkills
          .find((data) => data.projectId === project.ref.id)
          ?.skills.filter((row) => row.origin.kind === "mine" && row.state === "update-available").length ?? 0;
      const count = mine + uses.filter((use) => use.projectId === project.ref.id && waitsForUpdate(use)).length;
      const base = metadata.get(key);
      if (count)
        metadata.set(
          key,
          <>
            {base} · <span className="project-chip is-update">{t("externalLibrary.updates", { count })}</span>
          </>,
        );
    }
  }
  return metadata;
}
