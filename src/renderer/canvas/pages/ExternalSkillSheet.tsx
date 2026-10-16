import { useSourceRepository } from "./use-source-repository";
import type { ReactElement } from "react";
import { useI18n } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
import { SheetFrame } from "../SheetFrame";
import { Glossary } from "../Glossary";
import { SkillCallouts } from "../external-library/SkillCallouts";
import { licenceLabel, formatSourceDate, useProjectLabel, useStateLabel } from "../external-library/presentation";
import { InlineSkillInstall } from "./InlineSkillInstall";
import { SkillDocumentPreview } from "./SkillDocumentPreview";
import { externalSkillTitle, resolveExternalSkill, type ExternalSkillTarget } from "./external-skill-selection";
import { activeAvailableProjectIds } from "./active-projects";

export function ExternalSkillSheet(props: Readonly<{ sourceId: string }> & ExternalSkillTarget): ReactElement | null {
  const rail = useCanvasRail()!;
  const { t, language } = useI18n();
  const repository = useSourceRepository(rail.canvas.api, props.sourceId);
  const details = rail.externalLibrary.details.get(props.sourceId);
  const source = details?.source;
  const resolved = resolveExternalSkill(details, props);
  const activeProjectIds = activeAvailableProjectIds(rail.canvas.snapshot.registry.projects);
  const uses = resolved.uses.filter((use) => activeProjectIds.has(use.projectId));
  const { skill, removed } = resolved;
  const skillPath = skill?.path ?? removed?.skillPath ?? props.skillPath;
  const copy = (useId?: string): void =>
    rail.openExternalContext({ sourceId: props.sourceId, skillName: props.skillName, skillPath, useId, view: "copy" });
  return (
    <SheetFrame
      title={details ? externalSkillTitle(details, { ...props, skillPath }) : props.skillName}
      kicker={
        <>
          {t("externalLibrary.sourceKicker")} · {source?.name ?? props.sourceId} <Glossary concept="library" />
        </>
      }
      subtitle={
        source
          ? [
              licenceLabel(source.licence, t),
              skill?.lastChangeAt
                ? t("externalLibrary.changedOn", { date: formatSourceDate(skill.lastChangeAt, language) })
                : undefined,
              t(skill ? "externalLibrary.readOnly" : "externalLibrary.removed"),
            ]
              .filter(Boolean)
              .join(" · ")
          : undefined
      }
      testId="external-skill-sheet"
      className="external-library-sheet"
      onClose={rail.close}
      footer={
        <>
          {removed ? (
            <button
              type="button"
              className="canvas-secondary-button"
              onClick={() =>
                rail.openExternalContext({
                  sourceId: props.sourceId,
                  skillName: removed.skillKey,
                  skillPath: removed.skillPath,
                  useId: removed.id,
                  view: "compare",
                })
              }
            >
              {t("externalLibrary.view")}
            </button>
          ) : null}
          <button
            className="canvas-secondary-button"
            type="button"
            disabled={(!skill && !removed) || !rail.canvas.api?.prepareExternalSkillImport}
            onClick={() => copy(removed?.id)}
          >
            {t("externalLibrary.copy")}
          </button>
          <span className="skill-footer-note" />
          <button
            className="canvas-secondary-button"
            type="button"
            disabled={!source?.repo || !rail.canvas.api?.openExternalSourceRepository}
            onClick={() => void repository.open()}
          >
            {t("externalLibrary.githubMenu")}
          </button>
        </>
      }
    >
      {repository.error ? <p role="alert">{repository.error}</p> : null}
      {!details || (!skill && !removed) ? (
        <p role="alert">{rail.externalLibrary.error ?? t("externalLibrary.unknown")}</p>
      ) : null}
      {uses
        .filter((use) => use.state !== "up-to-date")
        .map((use) => (
          <SkillCallouts key={use.id} use={use} onCapture={() => copy(use.id)} />
        ))}
      {skill?.description ? <p className="sh-sub">{skill.description}</p> : null}
      <section className="external-section">
        <h3>
          {t("projectView.installedIn")} · {new Set(uses.map((use) => use.projectId)).size}
        </h3>
        <div className="external-rows">
          {uses.map((use) => (
            <div className="external-row" key={use.id}>
              <div>
                <b>{useProjectLabel(use, uses)}</b>
                <small>{use.folderPath}</small>
              </div>
              <span className={`project-chip is-${use.state === "up-to-date" ? "current" : use.state}`}>
                {useStateLabel(use, t)}
              </span>
            </div>
          ))}
          {!uses.length ? <p>{t("externalLibrary.noProjectsYet")}</p> : null}
        </div>
      </section>
      {skill ? (
        <InlineSkillInstall
          installedProjectIds={uses.map((use) => use.projectId)}
          disabled={Boolean(source?.lastError)}
          onInstall={(projectIds) =>
            rail.openExternalContext({
              sourceId: props.sourceId,
              skillName: props.skillName,
              skillPath: skill.path,
              view: "install",
              projectIds,
            })
          }
        />
      ) : null}
      <SkillDocumentPreview
        name={props.skillName}
        description={skill?.description}
        origin={
          skill
            ? source?.kind === "folder"
              ? {
                  entry: { kind: "source", id: props.sourceId.replace(/^folder:/u, "") },
                  path: `${skill.path}/SKILL.md`,
                }
              : { sourceId: props.sourceId, skillPath: skill.path }
            : removed
              ? { entry: { kind: "project", id: removed.projectId }, path: `${removed.folderPath}/SKILL.md` }
              : undefined
        }
      />
      <div className="external-callout is-read-only">
        <div>
          <b>{t("externalLibrary.published", { source: source?.name ?? props.sourceId })}</b>
          <p>{t("externalLibrary.publishedHint")}</p>
        </div>
      </div>
    </SheetFrame>
  );
}
