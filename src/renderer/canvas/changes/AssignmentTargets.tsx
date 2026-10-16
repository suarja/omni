import { harnessLabel } from "../project-view-model";
import { useEffect, useMemo, useState, type ReactElement } from "react";

import type { HarnessId } from "../../../domain/harness-targets";
import type { SkillIntent } from "../../../shared/skill-management-ipc";
import { useI18n } from "../../i18n";
import type { ChangesPackageChoice, ChangesSourceChoice } from "./ChangesWorkbench";

export type AssignmentProjectChoice = Readonly<{
  id: string;
  name: string;
  harnesses: readonly HarnessId[];
  available: boolean;
}>;
export type AssignmentArtifactChoice = Readonly<{
  sourceId: string;
  packageId: string;
  artifactPath: string;
  name: string;
}>;

function initialHarnesses(
  projectId: string | undefined,
  projects: readonly AssignmentProjectChoice[],
): Readonly<Record<string, readonly HarnessId[]>> {
  if (!projectId) return {};
  const project = projects.find((candidate) => candidate.id === projectId);
  return project ? { [projectId]: project.harnesses } : {};
}

export function AssignmentTargets(
  props: Readonly<{
    sources: readonly ChangesSourceChoice[];
    packages: readonly ChangesPackageChoice[];
    artifacts: readonly AssignmentArtifactChoice[];
    projects: readonly AssignmentProjectChoice[];
    sourceId?: string;
    packageId?: string;
    projectId?: string;
    busy: boolean;
    onInvalidate: () => void;
    onReview: (intent: Extract<SkillIntent, { kind: "assign" }>) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const [sourceId, setSourceId] = useState(props.sourceId ?? props.sources[0]?.id ?? "");
  const [packageId, setPackageId] = useState(props.packageId ?? "");
  const [artifactPath, setArtifactPath] = useState("");
  const [selectedProjects, setSelectedProjects] = useState<readonly string[]>(props.projectId ? [props.projectId] : []);
  const [selectedHarnesses, setSelectedHarnesses] = useState<Readonly<Record<string, readonly HarnessId[]>>>(() =>
    initialHarnesses(props.projectId, props.projects),
  );
  const packageChoices = useMemo(
    () => props.packages.filter((item) => item.sourceId === sourceId),
    [props.packages, sourceId],
  );
  const artifactChoices = useMemo(
    () => props.artifacts.filter((item) => item.sourceId === sourceId && item.packageId === packageId),
    [props.artifacts, packageId, sourceId],
  );

  useEffect(() => {
    if (props.sourceId) setSourceId(props.sourceId);
    if (props.packageId) setPackageId(props.packageId);
  }, [props.packageId, props.sourceId]);

  useEffect(() => {
    if (!props.projectId) return;
    setSelectedProjects([props.projectId]);
    setSelectedHarnesses(initialHarnesses(props.projectId, props.projects));
  }, [props.projectId, props.projects]);

  const changeSource = (value: string): void => {
    setSourceId(value);
    setPackageId("");
    setArtifactPath("");
    props.onInvalidate();
  };
  const changePackage = (value: string): void => {
    setPackageId(value);
    setArtifactPath("");
    props.onInvalidate();
  };
  const toggleProject = (project: AssignmentProjectChoice): void => {
    const selected = selectedProjects.includes(project.id);
    setSelectedProjects(
      selected ? selectedProjects.filter((id) => id !== project.id) : [...selectedProjects, project.id],
    );
    setSelectedHarnesses((current) => {
      const next = { ...current };
      if (selected) delete next[project.id];
      else next[project.id] = project.harnesses;
      return next;
    });
    props.onInvalidate();
  };
  const toggleHarness = (projectId: string, harness: HarnessId): void => {
    setSelectedHarnesses((current) => {
      const values = current[projectId] ?? [];
      return {
        ...current,
        [projectId]: values.includes(harness) ? values.filter((value) => value !== harness) : [...values, harness],
      };
    });
    props.onInvalidate();
  };
  const review = (): void => {
    const targets = selectedProjects.flatMap((projectId) => {
      const harnessIds = selectedHarnesses[projectId] ?? [];
      return harnessIds.length ? [{ projectId, harnessIds }] : [];
    });
    if (!sourceId || !packageId || !targets.length) return;
    props.onReview({
      kind: "assign",
      sourceId,
      packageId,
      ...(artifactPath ? { artifactPath } : {}),
      targets,
    });
  };

  return (
    <div className="changes-form" data-testid="changes-assignment-form">
      <p className="changes-note">{t("skillManagement.assignmentSubtitle")}</p>
      <label>
        <span>{t("skillManagement.source")}</span>
        <select onChange={(event) => changeSource(event.target.value)} value={sourceId}>
          <option value="">{t("skillManagement.source")}</option>
          {props.sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("skillManagement.package")}</span>
        <select onChange={(event) => changePackage(event.target.value)} value={packageId}>
          <option value="">{t("skillManagement.package")}</option>
          {packageChoices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("skillManagement.assignmentContent")}</span>
        <select
          disabled={!packageId}
          onChange={(event) => {
            setArtifactPath(event.target.value);
            props.onInvalidate();
          }}
          value={artifactPath}
        >
          <option value="">{t("skillManagement.packageAll")}</option>
          {artifactChoices.map((item) => (
            <option key={item.artifactPath} value={item.artifactPath}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <section aria-label={t("skillManagement.projects")} className="changes-targets">
        <h3>{t("skillManagement.projects")}</h3>
        {props.projects.length ? (
          props.projects.map((project) => {
            const selected = selectedProjects.includes(project.id);
            return (
              <fieldset className="changes-project-target" key={project.id}>
                <label className="changes-checkbox">
                  <input
                    checked={selected}
                    disabled={!project.available}
                    onChange={() => toggleProject(project)}
                    type="checkbox"
                  />
                  <span>{project.name}</span>
                  {!project.available ? <small>{t("skillManagement.projectUnavailable")}</small> : null}
                </label>
                <div className="changes-harness-targets">
                  <small>{t("skillManagement.harnessTargets")}</small>
                  {(["claude-code", "codex", "cursor"] as const).map((harness) => {
                    const available = project.harnesses.includes(harness);
                    return (
                      <label className="changes-checkbox" key={harnessLabel(harness)}>
                        <input
                          checked={(selectedHarnesses[project.id] ?? []).includes(harness)}
                          disabled={!selected || !available}
                          onChange={() => toggleHarness(project.id, harness)}
                          type="checkbox"
                        />
                        <span>{harnessLabel(harness)}</span>
                        {!available ? <small>{t("skillManagement.unavailable")}</small> : null}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })
        ) : (
          <p className="changes-note">{t("skillManagement.noProjects")}</p>
        )}
      </section>
      <button
        className="changes-primary"
        disabled={
          props.busy || !sourceId || !packageId || !selectedProjects.some((id) => (selectedHarnesses[id] ?? []).length)
        }
        onClick={review}
        type="button"
      >
        {props.busy ? t("skillManagement.loading") : t("skillManagement.review")}
      </button>
    </div>
  );
}
