import { LoadingSkeleton } from "../components/ui/Skeleton";
import { findRowUse, needsComparison } from "./external-library/presentation";
import { useCanvasRail } from "./rail/rail-context";
import { useState, type ReactElement } from "react";
import type { ProjectSkillRow, ProjectSkills } from "../../shared/project-skills-ipc";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import { useI18n, translateCount } from "../i18n";
import { ProjectGitInfo } from "./ProjectGitInfo";
import { ProjectProtection } from "./ProjectProtection";
import { AnchoredFloating } from "./AnchoredFloating";
import { useRef } from "react";
import { Glossary } from "./Glossary";
import { SheetFrame } from "./SheetFrame";
import { ProjectAgentChips, ProjectSkillState } from "./ProjectSkillChips";
import { ProjectDocument } from "./ProjectDocument";
import {
  countActiveSkills,
  filterProjectSkills,
  harnessLabel,
  isActiveSkill,
  isDisabledSkill,
  installedProjectHarnesses,
  maintenanceIntent,
  originKinds,
  originTitle,
  projectHarnesses,
  projectInventory,
  skillOriginLabel,
  type ProjectInstructions,
  type ProjectSkillFilter,
} from "./project-view-model";
import type { useProjectOperations } from "./use-project-operations";

export type ProjectSheetTab = "skills" | "instructions" | "info";
export function ProjectSkillsSheet(
  props: Readonly<{
    canvas: ResourceCanvasProps;
    projectId: string;
    projectName: string;
    data: ProjectSkills | null;
    instructions: readonly ProjectInstructions[];
    tab: ProjectSheetTab;
    onTab: (tab: ProjectSheetTab) => void;
    onClose: () => void;
    onOpenSkill: (row: ProjectSkillRow) => void;
    onAdd: () => void;
    onUpdate: (row: ProjectSkillRow) => void;
    onCapture: (row: ProjectSkillRow) => void;
    operations: ReturnType<typeof useProjectOperations>;
  }>,
): ReactElement {
  const { t, language } = useI18n();
  const rail = useCanvasRail();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProjectSkillFilter>("active");
  const menuAnchor = useRef<HTMLElement | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const inventory = projectInventory(props.canvas.snapshot, props.projectId);
  const project = props.canvas.snapshot.registry.projects.find((project) => project.ref.id === props.projectId);
  const rows = props.data?.skills ?? [];
  const filtered = filterProjectSkills(rows, filter, query);
  const diagnostics = [
    ...new Map(
      [...(inventory?.diagnostics ?? []), ...(props.data?.diagnostics ?? [])].map((d) => [
        `${d.location}:${d.code}:${d.message}`,
        d,
      ]),
    ).values(),
  ];
  function renderRow(row: ProjectSkillRow): ReactElement {
    const active = isActiveSkill(row);
    const externalUse = findRowUse(
      [...(rail?.externalLibrary.details.values() ?? [])].flatMap((details) => details.uses),
      row,
      props.projectId,
    );
    const installed = projectHarnesses.filter((harness) => row.agents[harness].state === "installed");
    const missing = installed.length === 1 ? projectHarnesses.find((harness) => harness !== installed[0]) : undefined;
    return (
      <div className="project-skill-row" data-skill-row-id={row.id} key={row.id}>
        <div className="project-skill-row-body">
          <button
            type="button"
            data-testid={`project-open-skill-${row.id}`}
            className="project-skill-name"
            onClick={() => props.onOpenSkill(row)}
          >
            {row.name}
          </button>
          <p title={row.description}>
            {skillOriginLabel(row, t)} — {row.description || t("projectView.descriptionMissing")}
          </p>
          <div className="project-row-chips">
            <ProjectAgentChips
              row={row}
              busy={props.operations.busy}
              onToggle={(harness) => void props.operations.toggleAgent(row, harness)}
            />
            <ProjectSkillState row={row} />
          </div>
        </div>
        <div className="project-row-controls">
          <button
            type="button"
            role="switch"
            aria-checked={active}
            aria-label={`${t(active ? "projectView.disable" : "projectView.enable")} ${row.name}`}
            className="canvas-switch project-skill-switch"
            disabled={props.operations.busy}
            onClick={(event) => {
              event.currentTarget.focus();
              void props.operations.prepare(row, active ? "disable" : "enable");
            }}
          />
          <button
            type="button"
            className="project-more"
            aria-label={t("projectView.more", { name: row.name })}
            aria-haspopup="menu"
            aria-expanded={menu === row.id}
            onClick={(event) => {
              event.currentTarget.focus();
              menuAnchor.current = event.currentTarget;
              setMenu(menu === row.id ? null : row.id);
            }}
            disabled={props.operations.busy}
          >
            ⋯
          </button>
        </div>
        {menu === row.id ? (
          <AnchoredFloating
            anchor={menuAnchor.current}
            kind="menu"
            className="project-row-menu"
            onClose={() => setMenu(null)}
          >
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setMenu(null);
                props.onOpenSkill(row);
              }}
            >
              {t("projectView.open")}
            </button>
            {row.state === "update-available" && maintenanceIntent(props.projectId, row) ? (
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenu(null);
                  props.onUpdate(row);
                }}
              >
                {t("projectView.updateAction")}
              </button>
            ) : null}
            {externalUse &&
            (needsComparison(externalUse) ||
              externalUse.state === "removed" ||
              (externalUse.state === "update" && rail?.externalLibrary.mode === "ask")) ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  props.onUpdate(row);
                }}
              >
                {t(needsComparison(externalUse) ? "externalLibrary.compare" : "externalLibrary.view")}
              </button>
            ) : null}
            {missing ? (
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenu(null);
                  void props.operations.toggleAgent(row, missing);
                }}
              >
                {t("skillActions.installAgent", { agent: harnessLabel(missing) })}
              </button>
            ) : null}
            {row.origin.kind === "project-only" || row.origin.kind === "external" ? (
              <button
                aria-label={t(row.origin.kind === "external" ? "skillActions.copy" : "projectView.capture")}
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenu(null);
                  props.onCapture(row);
                }}
              >
                <span>
                  {t(row.origin.kind === "external" ? "skillActions.copy" : "projectView.capture")}
                  <small>
                    {t(row.origin.kind === "external" ? "skillActions.copyHint" : "skillActions.captureHint")}
                  </small>
                </span>
              </button>
            ) : null}
            {active ? (
              <button
                aria-label={t("projectView.disable")}
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenu(null);
                  void props.operations.prepare(row, "disable");
                }}
              >
                <span>
                  {t("projectView.disable")}
                  <small>{t("skillActions.disableHint")}</small>
                </span>
              </button>
            ) : null}
            <button
              className="danger"
              aria-label={t("projectView.delete")}
              role="menuitem"
              type="button"
              onClick={() => {
                setMenu(null);
                void props.operations.prepare(row, "delete");
              }}
            >
              <span>
                {t("projectView.delete")}
                <small>{t("skillActions.deleteHint")}</small>
              </span>
            </button>
          </AnchoredFloating>
        ) : null}
      </div>
    );
  }
  return (
    <SheetFrame
      title={props.projectName}
      subtitle={project?.displayRoot}
      kicker={
        <>
          {t("projectView.project")} <Glossary concept="project" />
        </>
      }
      testId="project-sheet"
      busy={props.operations.busy}
      onClose={props.onClose}
      tabs={
        <div className="canvas-sheet-tabs" role="tablist">
          {(["skills", "instructions", "info"] as const).map((tab) => (
            <button
              type="button"
              role="tab"
              id={`project-tab-${tab}`}
              aria-selected={props.tab === tab}
              aria-controls="project-tab-panel"
              key={tab}
              onClick={() => props.onTab(tab)}
            >
              {t(`projectView.${tab}`)}
            </button>
          ))}
        </div>
      }
      footer={
        <>
          <span>{t("projectView.changesBoth")}</span>
          <button
            type="button"
            className="canvas-secondary-button is-primary"
            disabled={props.operations.busy || !props.data}
            data-testid="project-add-skills-open"
            onClick={props.onAdd}
          >
            {t("projectView.add")}
          </button>
        </>
      }
    >
      <div id="project-tab-panel" role="tabpanel" aria-labelledby={`project-tab-${props.tab}`}>
        {props.tab === "skills" ? (
          <>
            <div className="project-callout">
              {props.data ? (
                <>
                  <strong>
                    {translateCount(t, "projectView.cost", countActiveSkills(props.data), {
                      tokens: Math.max(...Object.values(props.data.startupCost)).toLocaleString(language),
                    })}
                  </strong>{" "}
                  <Glossary concept="cost" />
                  {projectHarnesses.map((harness) => (
                    <small key={harness}>
                      {translateCount(t, "projectView.agentCost", props.data!.activeSkillCount[harness], {
                        agent: harnessLabel(harness),
                        tokens: props.data!.startupCost[harness].toLocaleString(language),
                      })}
                    </small>
                  ))}
                </>
              ) : (
                <LoadingSkeleton label={t("projectView.loading")} variant="settings" />
              )}
            </div>
            <input
              className="project-skill-filter"
              aria-label={t("projectView.filter")}
              placeholder={t("projectView.filter")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="project-filters">
              {(["active", "mine", "external", "project-only", "disabled"] as const).map((key) => (
                <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                  {t(
                    key === "active"
                      ? "projectView.active"
                      : key === "mine"
                        ? "projectView.marketplace"
                        : key === "external"
                          ? "projectView.externals"
                          : key === "project-only"
                            ? "projectView.localFilter"
                            : "projectView.disabledFilter",
                  )}
                  {key === "active" || key === "disabled"
                    ? ` · ${rows.filter(key === "active" ? isActiveSkill : isDisabledSkill).length}`
                    : ""}
                </button>
              ))}
            </div>
            {originKinds.map((kind) => {
              const part = filtered.filter((row) => row.origin.kind === kind);
              return part.length ? (
                <section className="project-sheet-section" key={kind}>
                  <h3>
                    {originTitle(kind, t)} · {part.length}{" "}
                    <Glossary concept={kind === "project-only" ? "local" : kind} />
                  </h3>
                  {part.map(renderRow)}
                </section>
              ) : null;
            })}
            {props.data && !filtered.length ? <p>{t("projectView.empty")}</p> : null}
          </>
        ) : props.tab === "instructions" ? (
          <>
            <h3>
              {t("projectView.startupFile")} <Glossary concept="instructions" />
            </h3>
            {!props.instructions.length ? <p>{t("projectView.noInstructions")}</p> : null}
            {props.instructions.map((instruction) => (
              <section className="project-sheet-section" key={instruction.path}>
                <div className="project-sheet-card">
                  <strong>{instruction.path}</strong>
                  <div className="project-row-chips">
                    {instruction.agents.map((agent) => (
                      <span className="project-chip is-installed" key={agent.path}>
                        {agent.path === instruction.path
                          ? agent.label
                          : t("projectView.via", { agent: agent.label, name: agent.path })}
                      </span>
                    ))}
                  </div>
                  {instruction.aliases.length ? (
                    <p>{t("projectView.aliases", { names: instruction.aliases.join(", ") })}</p>
                  ) : null}
                </div>
                <ProjectDocument
                  projectId={props.projectId}
                  path={instruction.path}
                  api={props.canvas.api}
                  onEnsureGrant={props.canvas.onEnsureGrant}
                />
              </section>
            ))}
          </>
        ) : (
          <>
            <h3>{t("projectView.project")}</h3>
            <dl className="project-info">
              <dt>{t("projectView.path")}</dt>
              <dd>{project?.displayRoot}</dd>
              <dt>{t("projectView.git")}</dt>
              <dd>
                <ProjectGitInfo scopes={props.data?.git ?? inventory?.gitScopes ?? []} />
              </dd>
              <dt>{t("projectView.agents")}</dt>
              <dd>
                {installedProjectHarnesses(inventory, props.data).map(harnessLabel).join(" · ") ||
                  t("projectView.notObserved")}
              </dd>
            </dl>
            <h3>{t("projectView.files")}</h3>
            <dl className="project-info">
              {projectHarnesses.map((harness) => {
                const installed = rows.filter((row) => row.agents[harness].state === "installed");
                return (
                  <div key={harness}>
                    <dt>{harness === "claude-code" ? ".claude/skills" : ".agents/skills"}</dt>
                    <dd>
                      {props.data
                        ? `${translateCount(t, "projectView.skillCount", installed.length)} · ${translateCount(t, "projectView.links", installed.filter((row) => row.agents[harness].symlink).length)}`
                        : t("projectView.notObserved")}
                    </dd>
                  </div>
                );
              })}
              {props.instructions.map((instruction) => (
                <div key={instruction.path}>
                  <dt>{instruction.path}</dt>
                  <dd>{instruction.aliases.join(", ")}</dd>
                </div>
              ))}
            </dl>
            <ProjectProtection api={props.canvas.api} projectId={props.projectId} />
            <h3>{t("projectView.diagnostics")}</h3>
            {diagnostics.length ? (
              <ul className="project-diagnostics">
                {diagnostics.map((d) => (
                  <li key={`${d.location}:${d.code}:${d.message}`}>
                    <code>{d.location}</code>
                    <p>
                      {d.code} · {d.message}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t("projectView.noDiagnostics")}</p>
            )}
          </>
        )}
      </div>
    </SheetFrame>
  );
}
