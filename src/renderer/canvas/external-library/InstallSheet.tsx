import { readProjectSkills } from "../read-project-skills";
import { licenceLabel } from "./presentation";
import { createResourceCatalogue } from "../../../domain/resource-catalogue";
import { useEffect, useState, type ReactElement } from "react";
import { type ProjectSkills } from "../../../shared/project-skills-ipc";
import type { SkillIntent } from "../../../shared/skill-management-ipc";
import { useI18n } from "../../i18n";
import { SheetFrame } from "../SheetFrame";
import { Glossary } from "../Glossary";
import { useCanvasRail } from "../rail/rail-context";
import { projectHarnesses, harnessLabel } from "../project-view-model";
import { useExternalOperation } from "./use-external-operation";
import { OperationEvidence } from "./OperationEvidence";
import { formatSourceDate } from "./presentation";
import { resolveExternalSkill } from "../pages/external-skill-selection";

export function InstallSheet(
  props: Readonly<{
    sourceId: string;
    skillName: string;
    skillPath?: string;
    useId?: string;
    onApplyingChange: (busy: boolean) => void;
    initialProjectIds?: readonly string[];
  }>,
): ReactElement | null {
  const rail = useCanvasRail();
  const { t, language } = useI18n();
  const [selected, setSelected] = useState<readonly string[]>(props.initialProjectIds ?? []);
  const [agents, setAgents] = useState<readonly ("claude-code" | "codex")[]>(projectHarnesses);
  const [replace, setReplace] = useState(false);
  const [projects, setProjects] = useState<ReadonlyMap<string, ProjectSkills>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const details = rail?.externalLibrary.details.get(props.sourceId);
  const source = details?.source;
  const { skill } = resolveExternalSkill(details, props);
  const available =
    rail?.canvas.snapshot.registry.projects.filter(
      (project) => !project.archivedAt && project.availability === "available",
    ) ?? [];
  const projectKey = JSON.stringify(available.map((project) => project.ref.id));
  const api = rail?.canvas.api;
  useEffect(() => {
    let active = true;
    setProjects(new Map());
    setErrors(new Map());
    void Promise.allSettled(
      available.map(async (project) => {
        if (!rail) throw new Error("Installation targets are unavailable. Reopen the library.");
        const data = await readProjectSkills(rail.canvas, project.ref.id);
        return [project.ref.id, data] as const;
      }),
    ).then((reads) => {
      if (!active) return;
      const next = new Map<string, ProjectSkills>();
      const failures = new Map<string, string>();
      reads.forEach((read, index) => {
        const id = available[index]!.ref.id;
        if (read.status === "fulfilled") next.set(...read.value);
        else
          failures.set(
            id,
            read.reason instanceof Error ? read.reason.message : "Installation target could not be read.",
          );
      });
      setProjects(next);
      setErrors(failures);
    });
    return () => {
      active = false;
    };
  }, [api, projectKey]);
  const already = (projectId: string): boolean =>
    Boolean(skill?.useIds.some((id) => details?.uses.some((use) => use.id === id && use.projectId === projectId)));
  const conflicts = selected.flatMap((projectId) => {
    const row = projects.get(projectId)?.skills.find((row) => row.name === props.skillName);
    return row ? [{ projectId, row }] : [];
  });
  const folderResource =
    source?.kind === "folder" && skill && rail
      ? createResourceCatalogue(rail.canvas.snapshot)
          .search("")
          .find(
            (item) =>
              item.ref.entry.id === props.sourceId.replace(/^folder:/u, "") &&
              item.relativePath === `${skill.path}/SKILL.md`,
          )
      : undefined;
  const folderParent =
    folderResource && rail
      ? createResourceCatalogue(rail.canvas.snapshot).inspect(folderResource.ref)?.parent
      : undefined;
  const ready = Boolean(
    !source?.lastError &&
    (source?.repo || folderParent?.kind === "package") &&
    skill &&
    selected.length &&
    agents.length &&
    selected.every((id) => !errors.has(id) && projects.has(id) && !already(id)) &&
    (!conflicts.length || replace),
  );
  const intents: SkillIntent[] =
    ready && skill
      ? [
          source?.kind === "folder" && folderParent?.kind === "package"
            ? {
                kind: "assign",
                sourceId: folderParent.entry.id,
                packageId: folderParent.packageId,
                artifactPath: skill.path,
                targets: selected.map((projectId) => ({ projectId, harnessIds: agents })),
              }
            : {
                kind: "install-external-skill",
                sourceId: props.sourceId,
                skillPath: skill.path,
                skillName: skill.name,
                targets: selected.map((projectId) => ({ projectId, harnessIds: [...agents] })),
                conflict: replace ? "replace" : "refuse",
              },
        ]
      : [];
  const operation = useExternalOperation(rail!.canvas, intents, props.onApplyingChange, rail!.externalLibrary.reload);
  if (!rail) return null;
  return (
    <SheetFrame
      title={t("externalLibrary.installTitle")}
      kicker={
        <>
          {props.skillName} <Glossary concept="library" />
        </>
      }
      subtitle={t("externalLibrary.fromVersion", {
        source: source?.name ?? props.sourceId,
        version: source?.head?.commit.slice(0, 7) ?? "—",
        date: formatSourceDate(source?.head?.date, language),
      })}
      testId="external-install-sheet"
      className="external-library-sheet"
      busy={operation.applying}
      onClose={rail.close}
      footer={
        <>
          <button
            className="canvas-secondary-button"
            type="button"
            disabled={operation.applying}
            onClick={() =>
              rail.openExternalContext({
                sourceId: props.sourceId,
                skillName: props.skillName,
                skillPath: skill?.path ?? props.skillPath,
                useId: props.useId,
                view: "skill",
              })
            }
          >
            {t("externalLibrary.back")}
          </button>
          <span className="skill-footer-note">
            {conflicts.length && !replace ? t("externalLibrary.chooseReplace") : ""}
          </span>
          <button
            type="button"
            className="canvas-secondary-button is-primary"
            disabled={!operation.ready}
            onClick={() => void operation.apply()}
          >
            {t("externalLibrary.install")}
          </button>
        </>
      }
    >
      <p className="sh-sub">{skill?.description}</p>
      <section className="external-section">
        <h3>{t("externalLibrary.projectSelect")}</h3>
        <div className="external-options">
          {available.map((project) => (
            <label key={project.ref.id} className="external-option" data-project-id={project.ref.id}>
              <input
                type="checkbox"
                disabled={already(project.ref.id) || operation.applying || !projects.has(project.ref.id)}
                checked={already(project.ref.id) || selected.includes(project.ref.id)}
                onChange={(event) => {
                  setReplace(false);
                  setSelected((current) =>
                    event.target.checked ? [...current, project.ref.id] : current.filter((id) => id !== project.ref.id),
                  );
                }}
              />
              <span>
                {project.displayName}{" "}
                <small>
                  ·{" "}
                  {already(project.ref.id)
                    ? t("externalLibrary.alreadyInstalled")
                    : `${projects.get(project.ref.id)?.skills.length ?? "—"} skills`}
                </small>
                {errors.has(project.ref.id) ? (
                  <span role="alert" className="external-error">
                    {errors.get(project.ref.id)}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      </section>
      <section className="external-section">
        <h3>
          {t("externalLibrary.agents")} <Glossary concept="agents" />
        </h3>
        <div className="external-chips">
          {projectHarnesses.map((agent) => (
            <label className="project-chip is-installed" key={agent}>
              <input
                type="checkbox"
                checked={agents.includes(agent)}
                disabled={operation.applying}
                onChange={(event) =>
                  setAgents((current) =>
                    event.target.checked ? [...current, agent] : current.filter((id) => id !== agent),
                  )
                }
              />{" "}
              {harnessLabel(agent)}
            </label>
          ))}
        </div>
      </section>
      <section className="external-section">
        <h3>{t("externalLibrary.checks")}</h3>
        <div className="external-check">
          <span>✓</span>
          <div>
            <b>
              {t("externalLibrary.licence")} {source ? licenceLabel(source.licence, t) : "—"}
            </b>
            <small>
              {t(
                source?.licence === "none" || source?.licence === "other"
                  ? "externalLibrary.licenceUnknown"
                  : "externalLibrary.licenceHint",
              )}
            </small>
          </div>
        </div>
        <div className="external-check">
          <span>{skill ? "✓" : "✕"}</span>
          <div>
            <b>{t("externalLibrary.validSkill")}</b>
            <small>{t("externalLibrary.validHint")}</small>
          </div>
        </div>
        {conflicts.length ? (
          conflicts.map(({ projectId, row }) => (
            <div className={`external-check${replace ? "" : " is-failed"}`} key={projectId}>
              <span>{replace ? "✓" : "✕"}</span>
              <div>
                <b>
                  {t("externalLibrary.conflict", {
                    project: available.find((project) => project.ref.id === projectId)?.displayName ?? projectId,
                    name: row.name,
                  })}
                </b>
                <small>{row.origin.kind === "external" ? row.origin.source : t("projectView.local")}</small>
              </div>
            </div>
          ))
        ) : (
          <div className="external-check">
            <span>✓</span>
            <b>{t("externalLibrary.noConflict")}</b>
          </div>
        )}
        {conflicts.length ? (
          <label className="external-option">
            <input
              type="checkbox"
              checked={replace}
              disabled={operation.applying}
              onChange={(event) => setReplace(event.target.checked)}
            />
            <span>
              {t("externalLibrary.replace")} <small>· {t("externalLibrary.backup")}</small>
            </span>
          </label>
        ) : null}
      </section>
      <section className="external-section">
        <h3>{t("externalLibrary.changes")}</h3>
        <div className="external-rows">
          {selected.map((projectId) => (
            <div className="external-row" key={projectId}>
              <div>
                <b>{available.find((project) => project.ref.id === projectId)?.displayName ?? projectId}</b>
                <small>
                  {t("externalLibrary.installEffects", {
                    name: props.skillName,
                    agents: new Intl.ListFormat(language, { type: "conjunction" }).format(agents.map(harnessLabel)),
                  })}
                </small>
              </div>
            </div>
          ))}
        </div>
      </section>
      <OperationEvidence {...operation} />
    </SheetFrame>
  );
}
