import type { ExternalUse } from "../../shared/external-library-ipc";
import { findRowUse, waitsForUpdate } from "./external-library/presentation";
import type { ProjectSkillRow, ProjectSkills } from "../../shared/project-skills-ipc";
import { translateCount, type TranslationFunction } from "../i18n";
import type { CanvasLayout } from "./spatial/spatial-types";
import type { GlossaryKey } from "./Glossary";
import { countActiveSkills, originKinds, originTitle, type ProjectInstructions } from "./project-view-model";

export type ProjectGraphNode = Readonly<{
  id: string;
  title: string;
  kind: "project" | "group" | "artifact";
  x: number;
  y: number;
  meta?: string;
  badge?: Readonly<{ kind: "update" | "modified"; label: string }>;
  concept?: GlossaryKey;
  row?: ProjectSkillRow;
  group?: ProjectSkillRow["origin"]["kind"];
}>;
export type ProjectGraphModel = Readonly<{
  nodes: readonly ProjectGraphNode[];
  headings: readonly Readonly<{ title: string; x: number; y: number }>[];
  layout: CanvasLayout;
}>;
function toLayout(nodes: readonly ProjectGraphNode[], connected: boolean): CanvasLayout {
  const center = nodes.find((node) => node.id === "project");
  const wires =
    connected && center
      ? nodes
          .filter((node) => node.id !== center.id)
          .map((node) => {
            const left = node.x < center.x;
            const a = left ? node : center;
            const b = left ? center : node;
            const start = a.x + 132;
            const end = b.x - 132;
            const bend = Math.max(50, (end - start) / 2);
            return {
              id: node.id,
              d: `M ${start} ${a.y} C ${start + bend} ${a.y}, ${end - bend} ${b.y}, ${end} ${b.y}`,
            };
          })
      : [];
  return {
    nodes: nodes.map((node) => ({
      x: node.x,
      y: node.y,
      node: { kind: "group", id: node.id, groupId: node.id, label: node.title, labelKind: "literal" },
    })),
    bounds: nodes.length
      ? {
          left: Math.min(...nodes.map((n) => n.x)) - 132,
          right: Math.max(...nodes.map((n) => n.x)) + 132,
          top: Math.min(...nodes.map((n) => n.y)) - 36,
          bottom: Math.max(...nodes.map((n) => n.y)) + 124,
        }
      : { left: -132, right: 132, top: -36, bottom: 36 },
    wires,
    ports: [],
  };
}
export function buildProjectGraph(
  data: ProjectSkills | null,
  name: string,
  group: ProjectSkillRow["origin"]["kind"] | null,
  instructions: readonly ProjectInstructions[],
  t: TranslationFunction,
  externalUses: readonly ExternalUse[] = [],
): ProjectGraphModel {
  const rows = data?.skills ?? [];
  const waiting = (row: ProjectSkillRow): boolean => {
    const use = findRowUse(externalUses, row, data?.projectId);
    return use ? waitsForUpdate(use) : row.state === "update-available";
  };
  const nodes: ProjectGraphNode[] = [];
  const headings: { title: string; x: number; y: number }[] = [];
  if (group) {
    const selected = rows.filter((row) => row.origin.kind === group);
    const sections =
      group === "external"
        ? [...new Set(selected.flatMap((row) => (row.origin.kind === "external" ? [row.origin.source] : [])))].map(
            (source) => ({
              title: source,
              rows: selected.filter((row) => row.origin.kind === "external" && row.origin.source === source),
            }),
          )
        : [{ title: "", rows: selected }];
    let y = 70;
    for (const section of sections) {
      if (section.title) {
        headings.push({ title: `${section.title} · ${section.rows.length}`, x: 40, y });
        y += 26;
      }
      section.rows.forEach((row, index) =>
        nodes.push({
          id: `skill:${row.id}`,
          title: row.name,
          kind: "artifact",
          row,
          x: 172 + (index % 4) * 284,
          y: y + Math.floor(index / 4) * 96 + 36,
          concept: index === 0 ? "agents" : undefined,
        }),
      );
      y += Math.ceil(section.rows.length / 4) * 96 + 18;
    }
  } else {
    nodes.push({ id: "project", title: name, kind: "project", x: 0, y: 0, concept: "project" });
    originKinds.forEach((kind, index) => {
      const part = rows.filter((row) => row.origin.kind === kind);
      const extra =
        kind === "external"
          ? translateCount(
              t,
              "projectView.sources",
              new Set(part.flatMap((row) => (row.origin.kind === "external" ? [row.origin.source] : []))).size,
            )
          : kind === "mine"
            ? part.some((row) => row.state === "update-available")
              ? translateCount(t, "projectView.updates", part.filter((row) => row.state === "update-available").length)
              : ""
            : part.some(
                  (row) =>
                    (row.agents.codex.state === "installed") !== (row.agents["claude-code"].state === "installed"),
                )
              ? t("projectView.oneSided", {
                  count: part.filter(
                    (row) =>
                      (row.agents.codex.state === "installed") !== (row.agents["claude-code"].state === "installed"),
                  ).length,
                })
              : "";
      nodes.push({
        id: kind,
        title: originTitle(kind, t),
        kind: "group",
        group: kind,
        concept: kind === "project-only" ? "local" : kind,
        x: -396,
        y: (index - 1) * 144,
        meta: data
          ? [
              translateCount(t, "projectView.skillCount", part.length),
              kind === "external"
                ? [
                    extra,
                    part.some(waiting)
                      ? t("externalLibrary.updates", {
                          count: part.filter(waiting).length,
                        })
                      : "",
                    part.some((row) => row.state === "removed-upstream")
                      ? translateCount(
                          t,
                          "externalLibrary.removedCount",
                          part.filter((row) => row.state === "removed-upstream").length,
                        )
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "",
            ]
              .filter(Boolean)
              .join(" · ")
          : t("projectView.loading"),
        ...(extra && kind !== "external" && data
          ? { badge: { kind: kind === "mine" ? ("update" as const) : ("modified" as const), label: extra } }
          : {}),
      });
    });
    let extraInstructionSlot = 3;
    instructions.forEach((instruction) =>
      nodes.push({
        id: `instructions:${instruction.path}`,
        title: t("projectView.instructionTitle", { name: instruction.path }),
        kind: "artifact",
        x: 396,
        // Keep two primary instruction slots above the fixed startup-cost card.
        y:
          -80 +
          (instruction.path === "AGENTS.md" ? 0 : instruction.path === "CLAUDE.md" ? 1 : extraInstructionSlot++) * 144,
        concept: "instructions",
        meta: instruction.aliases.length
          ? t("projectView.aliases", { names: instruction.aliases.join(", ") })
          : instruction.agents.map((agent) => agent.label).join(" · "),
      }),
    );
    nodes.push({
      id: "cost",
      title: t("projectView.startup"),
      kind: "group",
      x: 396,
      y: 208,
      concept: "cost",
      meta: data
        ? translateCount(t, "projectView.startupMeta", countActiveSkills(data), {
            tokens: Math.max(...Object.values(data.startupCost)),
          })
        : t("projectView.loading"),
    });
  }
  return { nodes, headings, layout: toLayout(nodes, !group) };
}
