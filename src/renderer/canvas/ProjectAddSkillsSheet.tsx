import { activeWorkshop } from "../../domain/source-roles";
import { useState, type ReactElement } from "react";
import type { ProjectSkillHarness, ProjectSkills } from "../../shared/project-skills-ipc";
import type { SkillIntent } from "../../shared/skill-management-ipc";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import type { AssignmentArtifactChoice } from "./changes/AssignmentTargets";
import { useI18n } from "../i18n";
import { SheetFrame } from "./SheetFrame";
import { Glossary } from "./Glossary";
import { harnessLabel, projectHarnesses } from "./project-view-model";
import { sourcePackagePath } from "./use-owned-skill-choices";

export function projectAssignmentChoices(
  canvas: ResourceCanvasProps,
  artifacts: readonly AssignmentArtifactChoice[],
  data: ProjectSkills | null,
): readonly AssignmentArtifactChoice[] {
  return artifacts.flatMap((artifact) => {
    const workshop = activeWorkshop(canvas.snapshot.registry);
    const source =
      workshop?.ref.id === artifact.sourceId && workshop.availability === "available" ? workshop : undefined;
    const evidence = canvas.snapshot.roots.find(
      (root) => root.entry.kind === "source" && root.entry.id === artifact.sourceId,
    )?.evidence;
    const pkg =
      evidence?.status === "observed"
        ? evidence.observation.inventory.packages?.find((pkg) => pkg.id === artifact.packageId)
        : undefined;
    const artifactPath = pkg ? sourcePackagePath(pkg.relativeRoot, artifact.artifactPath) : undefined;
    if (
      !source ||
      !artifactPath ||
      data?.skills.some(
        (row) =>
          row.origin.kind === "mine" &&
          row.origin.sourceId === artifact.sourceId &&
          row.origin.packageId === artifact.packageId &&
          row.origin.artifactPath === artifactPath,
      )
    )
      return [];
    return [{ ...artifact, artifactPath }];
  });
}
export function ProjectAddSkillsSheet(
  props: Readonly<{
    projectId: string;
    projectName: string;
    choices: readonly AssignmentArtifactChoice[];
    busy: boolean;
    onClose: () => void;
    onNewSkill?: () => void;
    onApply: (intents: readonly SkillIntent[]) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [harnesses, setHarnesses] = useState<readonly ProjectSkillHarness[]>(projectHarnesses);
  const keyFor = (choice: AssignmentArtifactChoice): string =>
    JSON.stringify([choice.sourceId, choice.packageId, choice.artifactPath]);
  const intents: readonly SkillIntent[] = props.choices
    .filter((choice) => selected.includes(keyFor(choice)))
    .map((choice) => ({
      kind: "assign",
      sourceId: choice.sourceId,
      packageId: choice.packageId,
      artifactPath: choice.artifactPath,
      targets: [{ projectId: props.projectId, harnessIds: harnesses }],
    }));
  return (
    <SheetFrame
      title={t("projectView.addTitle")}
      kicker={props.projectName}
      testId="project-add-skills"
      onClose={props.onClose}
      busy={props.busy}
      footer={
        <>
          <button className="canvas-secondary-button" type="button" onClick={props.onClose} disabled={props.busy}>
            {t("projectView.back")}
          </button>
          <button
            className="canvas-secondary-button is-ghost"
            type="button"
            onClick={props.onNewSkill}
            disabled={props.busy || !props.onNewSkill}
          >
            {t("projectView.newSkill")}
          </button>
          <span className="skill-footer-note" />
          <button
            className="canvas-secondary-button is-primary"
            type="button"
            disabled={props.busy || !intents.length || !harnesses.length}
            onClick={() => props.onApply(intents)}
          >
            {t("projectView.addApply", { count: intents.length })}
          </button>
        </>
      }
    >
      <p>{t("projectView.addHint")}</p>
      {props.choices.map((choice) => (
        <label
          className="project-pick-skill"
          data-testid={`project-add-choice-${encodeURIComponent(keyFor(choice))}`}
          key={keyFor(choice)}
        >
          <input
            type="checkbox"
            disabled={props.busy}
            checked={selected.includes(keyFor(choice))}
            onChange={() =>
              setSelected(
                selected.includes(keyFor(choice))
                  ? selected.filter((key) => key !== keyFor(choice))
                  : [...selected, keyFor(choice)],
              )
            }
          />
          <span>
            <strong>{choice.name}</strong>
            <small>
              {t("projectView.marketplace")} · {choice.packageId}
            </small>
          </span>
        </label>
      ))}
      {!props.choices.length ? <p>{t("projectView.empty")}</p> : null}
      <h3>
        {t("projectView.agents")} <Glossary concept="agents" />
      </h3>
      <div className="project-row-chips">
        {projectHarnesses.map((harness) => (
          <label className="project-chip" key={harness}>
            <input
              type="checkbox"
              disabled={props.busy}
              checked={harnesses.includes(harness)}
              onChange={() =>
                setHarnesses(
                  harnesses.includes(harness)
                    ? harnesses.filter((value) => value !== harness)
                    : [...harnesses, harness],
                )
              }
            />
            {harnessLabel(harness)}
          </label>
        ))}
      </div>
    </SheetFrame>
  );
}
