import type { ReactElement } from "react";
import type { ProjectSkillHarness, ProjectSkillRow } from "../../shared/project-skills-ipc";
import { CanvasGlyph, type CanvasGlyphName } from "./CanvasGlyph";
import { useI18n } from "../i18n";
import { Glossary } from "./Glossary";
import { ProjectAgentChips, ProjectSkillState } from "./ProjectSkillChips";
import { harnessLabel } from "./project-view-model";
import type { ProjectGraphModel } from "./project-graph-layout";

export function ProjectGraph(
  props: Readonly<{
    model: ProjectGraphModel;
    agents: readonly string[];
    onNode: (id: string) => void;
    onSkill: (row: ProjectSkillRow) => void;
    onToggleAgent?: (row: ProjectSkillRow, harness: ProjectSkillHarness) => void;
    busy?: boolean;
    readState?: "loading" | "unavailable" | "ready";
  }>,
): ReactElement {
  const { t } = useI18n();
  const bounds = props.model.layout.bounds;
  const grouped = props.model.nodes.some((node) => node.row);
  const rows = [...new Set(props.model.nodes.map((node) => node.y))].map((y) =>
    props.model.nodes.filter((node) => node.y === y),
  );
  return (
    <div className="canvas-graph project-graph" data-testid="canvas-graph">
      <svg
        aria-hidden="true"
        className="canvas-wires"
        style={{
          left: bounds.left - 20,
          top: bounds.top - 20,
          width: bounds.right - bounds.left + 40,
          height: bounds.bottom - bounds.top + 40,
        }}
        viewBox={`${bounds.left - 20} ${bounds.top - 20} ${bounds.right - bounds.left + 40} ${bounds.bottom - bounds.top + 40}`}
      >
        {props.model.layout.wires.map((wire) => (
          <path key={wire.id} className="canvas-wire" d={wire.d} />
        ))}
      </svg>
      {props.model.headings.map((heading) => (
        <h3 className="project-source-heading" key={heading.title} style={{ left: heading.x, top: heading.y }}>
          {heading.title}
        </h3>
      ))}
      {(grouped ? rows : [props.model.nodes]).map((row, index) => (
        <div
          key={index}
          className={grouped ? "project-graph-row" : "project-graph-overview"}
          style={
            grouped
              ? {
                  position: "absolute",
                  left: Math.min(...row.map((node) => node.x)) - 132,
                  top: row[0]!.y - 36,
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 264px)",
                  gap: 20,
                  alignItems: "stretch",
                }
              : undefined
          }
        >
          {row.map((node) => {
            const tone: CanvasGlyphName =
              node.kind === "project"
                ? "project"
                : node.row
                  ? "skill"
                  : node.concept === "instructions"
                    ? "doc"
                    : node.group === "mine"
                      ? "marketplace"
                      : node.group === "external"
                        ? "external"
                        : node.group === "project-only"
                          ? "skill"
                          : "group";
            return (
              <div
                className={`canvas-node-row project-node${node.id === "project" ? " is-center" : ""}`}
                style={
                  grouped
                    ? { position: "relative", height: "100%", boxSizing: "border-box" }
                    : { left: node.x - 132, top: node.y - 36 }
                }
                data-tone={tone}
                data-kind={node.kind}
                data-project-group={node.group}
                data-skill-row-id={node.row?.id}
                key={node.id}
              >
                <div
                  className="canvas-node"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      node.row ? props.onSkill(node.row) : props.onNode(node.id);
                    }
                  }}
                  data-kind={node.kind}
                  title={node.title}
                  onClick={() => (node.row ? props.onSkill(node.row) : props.onNode(node.id))}
                >
                  <span className="canvas-node-icon" aria-hidden="true">
                    <CanvasGlyph name={tone} />
                  </span>
                  <span className="project-node-body">
                    <span className="canvas-node-label">{node.title}</span>
                    <span className="project-node-meta">
                      {node.row ? (
                        <>
                          <ProjectAgentChips
                            row={node.row}
                            busy={props.busy}
                            onToggle={
                              props.onToggleAgent ? (harness) => props.onToggleAgent!(node.row!, harness) : undefined
                            }
                          />
                          <ProjectSkillState row={node.row} />
                        </>
                      ) : node.id === "project" ? (
                        props.agents.map((agent) => (
                          <span className="project-chip is-installed" key={agent}>
                            ✓ {harnessLabel(agent)}
                          </span>
                        ))
                      ) : (
                        <>
                          {node.meta}
                          {node.badge ? (
                            <span className={`project-chip is-${node.badge.kind}`}>{node.badge.label}</span>
                          ) : null}
                        </>
                      )}
                    </span>
                  </span>
                </div>
                {node.concept ? <Glossary concept={node.concept} /> : null}
              </div>
            );
          })}
        </div>
      ))}
      {!props.model.nodes.length && props.readState === "loading" ? (
        <p role="status">{t("projectView.loading")}</p>
      ) : null}
      {!props.model.nodes.length && (props.readState ?? "ready") === "ready" ? <p>{t("projectView.empty")}</p> : null}
    </div>
  );
}
