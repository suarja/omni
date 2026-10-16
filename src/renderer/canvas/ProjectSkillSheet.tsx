import { SkillCallouts } from "./external-library/SkillCallouts";
import { findRowUse } from "./external-library/presentation";
import { useCanvasRail } from "./rail/rail-context";
import "./external-library/external-library.css";
import { readProjectSkills, projectSkillsKey } from "./read-project-skills";
import { useReviewRevision } from "../review/use-review-revision";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ProjectSkillRow } from "../../shared/project-skills-ipc";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import { useI18n } from "../i18n";
import { Glossary } from "./Glossary";
import { SheetFrame } from "./SheetFrame";
import { ProjectAgentChips } from "./ProjectSkillChips";
import { ProjectDocument } from "./ProjectDocument";
import { AnchoredFloating } from "./AnchoredFloating";
import {
  harnessLabel,
  isActiveSkill,
  maintenanceIntent,
  projectHarnesses,
  skillOriginLabel,
} from "./project-view-model";
import type { useProjectOperations } from "./use-project-operations";
import "./skill-actions.css";

type OtherProject = Readonly<{ id: string; name: string; row?: ProjectSkillRow; error?: string }>;
function matchesSkill(row: ProjectSkillRow, candidate: ProjectSkillRow): boolean {
  if (row.origin.kind === "mine" && candidate.origin.kind === "mine")
    return (
      row.origin.sourceId === candidate.origin.sourceId &&
      row.origin.packageId === candidate.origin.packageId &&
      row.origin.artifactPath === candidate.origin.artifactPath
    );
  if (row.origin.kind === "external" && candidate.origin.kind === "external")
    return row.origin.source === candidate.origin.source && row.name === candidate.name;
  return Boolean(row.skillId && row.skillId === candidate.skillId);
}
export function ProjectSkillSheet(
  props: Readonly<{
    canvas: ResourceCanvasProps;
    projectId: string;
    projectName: string;
    row: ProjectSkillRow;
    onClose: () => void;
    onUpdate: () => void;
    onCapture: () => void;
    operations: ReturnType<typeof useProjectOperations>;
  }>,
): ReactElement {
  const { t } = useI18n();
  const rail = useCanvasRail();
  const externalUse = findRowUse(
    [...(rail?.externalLibrary.details.values() ?? [])].flatMap((details) => details.uses),
    props.row,
    props.projectId,
  );
  const [others, setOthers] = useState<readonly OtherProject[]>([]);
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const active = isActiveSkill(props.row);
  const installed = projectHarnesses.filter((harness) => props.row.agents[harness].state === "installed");
  const missing = installed.length === 1 ? projectHarnesses.find((harness) => harness !== installed[0]) : undefined;
  const path = installed.flatMap((harness) =>
    props.row.agents[harness].folderPath ? [`${props.row.agents[harness].folderPath}/SKILL.md`] : [],
  )[0];
  const originKey = JSON.stringify(props.row.origin);
  const projects = props.canvas.snapshot.registry.projects.filter(
    (project) => project.ref.id !== props.projectId && !project.archivedAt && project.availability === "available",
  );
  const projectsKey = JSON.stringify(
    projects.map((project) => [projectSkillsKey(props.canvas.snapshot, project.ref.id), project.displayName]),
  );
  const reviewRevision = useReviewRevision(props.canvas.api);
  useEffect(() => {
    let current = true;
    const read = props.canvas.api?.readProjectSkills;
    if (!read) return;
    void Promise.all(
      projects.map(async (project): Promise<OtherProject> => {
        try {
          const data = await readProjectSkills(props.canvas, project.ref.id);
          return {
            id: project.ref.id,
            name: project.displayName,
            row: data.skills.find((candidate) => matchesSkill(props.row, candidate)),
          };
        } catch {
          return { id: project.ref.id, name: project.displayName, error: t("projectView.notObserved") };
        }
      }),
    ).then((results) => {
      if (current) setOthers(results);
    });
    return () => {
      current = false;
    };
  }, [
    props.canvas.api,
    projectsKey,
    reviewRevision,
    props.projectId,
    props.row.skillId,
    props.row.name,
    originKey,
    props.operations.toast,
    t,
  ]);
  const available = others.filter((other) => !other.row && !other.error);
  function installElsewhere(other: OtherProject): void {
    const origin = props.row.origin;
    if (origin.kind !== "mine") return;
    setMenu(false);
    void props.operations.runIntents(
      [
        {
          kind: "assign",
          sourceId: origin.sourceId,
          packageId: origin.packageId,
          artifactPath: origin.artifactPath,
          targets: [{ projectId: other.id, harnessIds: projectHarnesses }],
        },
      ],
      t("projectView.completed"),
    );
  }
  return (
    <SheetFrame
      title={props.row.name}
      subtitle={t(active ? "projectView.activeIn" : "projectView.disabledIn", { project: props.projectName })}
      kicker={
        <>
          {t("skillActions.skill")} <Glossary concept="skill" />
        </>
      }
      testId="project-skill-sheet"
      className="skill-origin-sheet"
      onClose={props.onClose}
      busy={props.operations.busy}
      footer={
        <>
          <button
            type="button"
            className={`canvas-secondary-button${active ? "" : " is-primary"}`}
            disabled={props.operations.busy}
            onClick={() => void props.operations.prepare(props.row, active ? "disable" : "enable")}
          >
            {active ? t("skillActions.disableIn", { project: props.projectName }) : t("projectView.enable")}
          </button>
          {active ? (
            <button
              type="button"
              className="canvas-secondary-button is-ghost is-danger"
              disabled={props.operations.busy}
              onClick={() => void props.operations.prepare(props.row, "delete")}
            >
              {t("projectView.delete")}
            </button>
          ) : null}
        </>
      }
    >
      {active &&
      props.row.origin.kind === "mine" &&
      props.row.state === "update-available" &&
      maintenanceIntent(props.projectId, props.row) ? (
        <div className="skill-callout">
          <div>
            <strong>
              {t("skillActions.update")} <Glossary concept="update" />
            </strong>
            <p>{t("projectView.updateCopy")}</p>
          </div>
          <button
            className="canvas-secondary-button is-small is-primary"
            type="button"
            disabled={props.operations.busy}
            onClick={props.onUpdate}
          >
            {t("projectView.updateAction")}
          </button>
        </div>
      ) : null}
      {missing ? (
        <div className="skill-callout is-warn">
          <div>
            <strong>{t("skillActions.onlyAgent", { agent: harnessLabel(installed[0]!) })}</strong>
            <p>{t("skillActions.invisibleAgent", { agent: harnessLabel(missing), project: props.projectName })}</p>
          </div>
          <button
            className="canvas-secondary-button is-small"
            type="button"
            disabled={props.operations.busy}
            onClick={() => void props.operations.toggleAgent(props.row, missing)}
          >
            {t("skillActions.installAgent", { agent: harnessLabel(missing) })}
          </button>
        </div>
      ) : null}
      {props.row.origin.kind === "project-only" ? (
        <div className="skill-callout">
          <div>
            <strong>
              {t("skillActions.onlyProject", { project: props.projectName })} <Glossary concept="capture" />
            </strong>
            <p>{t("skillActions.captureCallout")}</p>
          </div>
          <button
            className="canvas-secondary-button is-small is-primary"
            type="button"
            disabled={props.operations.busy || !active}
            data-testid="project-capture-open"
            onClick={props.onCapture}
          >
            {t("projectView.capture")}
          </button>
        </div>
      ) : null}
      {externalUse ? (
        <SkillCallouts use={externalUse} busy={props.operations.busy} onCapture={props.onCapture} />
      ) : null}
      {props.row.origin.kind === "external" ? (
        <div className="skill-callout is-external">
          <div>
            <strong>
              {t("skillActions.externalTitle", { source: props.row.origin.source })} <Glossary concept="copyext" />
            </strong>
            <p>{t("skillActions.externalCallout")}</p>
          </div>
          <button
            className="canvas-secondary-button is-small"
            type="button"
            disabled={props.operations.busy || !active}
            onClick={props.onCapture}
          >
            {t("skillActions.copy")}
          </button>
        </div>
      ) : null}
      <section className="project-sheet-section">
        <h3>
          {t("projectView.does")} <Glossary concept="skill" />
        </h3>
        <p>{props.row.description || t("projectView.descriptionMissing")}</p>
      </section>
      <section className="project-sheet-section">
        <h3>{t("projectView.origin")}</h3>
        <p>
          {skillOriginLabel(props.row, t)}{" "}
          {props.row.origin.kind === "external" ? <span className="skill-tag">{t("projectView.readOnly")}</span> : null}
        </p>
      </section>
      <section className="project-sheet-section">
        <h3>
          {t("projectView.installedIn")} <Glossary concept="agents" />
        </h3>
        <div className="skill-rows">
          <div className="skill-row">
            <div>
              <b>{props.projectName}</b>
              <small>{t(active ? "skillActions.thisProject" : "skillActions.parkedProject")}</small>
            </div>
            <ProjectAgentChips
              row={props.row}
              busy={props.operations.busy}
              onToggle={(harness) => void props.operations.toggleAgent(props.row, harness)}
            />
          </div>
          {others
            .filter((other) => other.row)
            .map((other) => (
              <div className="skill-row" key={other.id}>
                <b>{other.name}</b>
                <ProjectAgentChips
                  row={other.row!}
                  busy={props.operations.busy}
                  onToggle={(harness) =>
                    void props.operations.toggleAgent(other.row!, harness, { id: other.id, name: other.name })
                  }
                />
              </div>
            ))}
        </div>
        {others
          .filter((other) => other.error)
          .map((other) => (
            <small className="skill-hint" key={other.id}>
              {other.name} · {other.error}
            </small>
          ))}
        {props.row.origin.kind === "mine" ? (
          <button
            ref={anchor}
            className="canvas-secondary-button is-small is-ghost skill-other-project"
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={props.operations.busy || !available.length}
            onClick={() => setMenu(!menu)}
          >
            {t("skillActions.otherProject")}
          </button>
        ) : null}
        {menu ? (
          <AnchoredFloating kind="menu" anchor={anchor.current} onClose={() => setMenu(false)}>
            {available.map((other) => (
              <button type="button" role="menuitem" key={other.id} onClick={() => installElsewhere(other)}>
                {other.name}
              </button>
            ))}
          </AnchoredFloating>
        ) : null}
      </section>
      <section className="project-sheet-section">
        <h3>{t("projectView.content")}</h3>
        <ProjectDocument
          raw
          api={props.canvas.api}
          onEnsureGrant={props.canvas.onEnsureGrant}
          path={path}
          projectId={props.projectId}
        />
      </section>
    </SheetFrame>
  );
}
