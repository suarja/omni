import type { ExternalSourceDetails, ExternalSource } from "../../../shared/external-library-ipc";
import type { ExternalDiscovery } from "../../../shared/external-library-ui-ipc";
import { translateCount, type TranslationFunction } from "../../i18n";
import { Glossary } from "../Glossary";
import type { ExternalLibraryState } from "../external-library/use-external-library";
import { licenceLabel } from "../external-library/presentation";
import type { ExternalSelection } from "./page-navigation";
import type { PageNode, PageSection } from "./PageGraph";
import { SkillUseChips } from "./SkillUseChips";
import { skillUseChips } from "./skill-use-chip-model";
import {
  externalSkillTargets,
  externalSkillTitle,
  resolveExternalSkill,
  type ExternalSkillTarget,
} from "./external-skill-selection";

type Inputs = Readonly<{
  library: ExternalLibraryState;
  t: TranslationFunction;
  open: (selection: ExternalSelection) => void;
  openSkill: (selection: ExternalSelection) => void;
  personalMarketplaceName?: string;
  activeProjectIds: ReadonlySet<string>;
}>;
function activeUses(uses: readonly ExternalSourceDetails["uses"][number][], activeProjectIds: ReadonlySet<string>) {
  return uses.filter((use) => activeProjectIds.has(use.projectId));
}
function skillNodes(
  details: ExternalSourceDetails,
  targets: readonly ExternalSkillTarget[],
  open: Inputs["open"],
  t: TranslationFunction,
  activeProjectIds: ReadonlySet<string>,
): PageNode[] {
  return targets.map((target) => {
    const resolved = resolveExternalSkill(details, target);
    const uses = activeUses(resolved.uses, activeProjectIds);
    const peers = activeUses(details.uses, activeProjectIds);
    const { skill } = resolved;
    return {
      id: JSON.stringify([details.source!.id, target.skillName, target.skillPath, target.useId]),
      title: externalSkillTitle(details, target),
      skillName: target.skillName,
      kind: "skill",
      unused: !uses.length,
      metadataLabels: uses.length ? skillUseChips(uses, peers, t).map((chip) => chip.label) : undefined,
      meta: uses.length ? (
        <SkillUseChips uses={uses} peers={peers} />
      ) : (
        <span className="page-node-description" title={skill?.description}>
          {skill?.description}
        </span>
      ),
      onOpen: () => open({ sourceId: details.source!.id, ...target, view: "skill" }),
    };
  });
}
function usedSourceSection(source: ExternalSource, input: Inputs): PageSection {
  const { library, open, t } = input;
  const activeProjects = source.projects.filter((project) => input.activeProjectIds.has(project.id));
  const details = library.details.get(source.id);
  const targets = details
    ? externalSkillTargets(details).filter(
        (target) => activeUses(resolveExternalSkill(details, target).uses, input.activeProjectIds).length,
      )
    : [];
  const nodes = details ? skillNodes(details, targets, input.openSkill, t, input.activeProjectIds) : [];
  const rest =
    details?.skills.filter(
      (skill) =>
        !details.uses.some((use) => skill.useIds.includes(use.id) && input.activeProjectIds.has(use.projectId)),
    ).length ?? source.unusedSkills;
  const browse = (): void => open({ sourceId: source.id, view: "source" });
  if (rest)
    nodes.push({
      id: `${source.id}:unused`,
      title: translateCount(t, "externalLibrary.otherSkills", rest),
      kind: "external",
      meta: t("externalLibrary.browseUnused"),
      onOpen: browse,
    });
  return {
    id: source.id,
    label: source.name,
    onOpen: browse,
    nodes,
    title: (
      <>
        {source.name}{" "}
        <small>
          ·{" "}
          {translateCount(t, "externalLibrary.sourceSummary", source.skillCount, {
            licence: licenceLabel(source.licence, t),
            count: source.skillCount,
            projects: t("externalLibrary.inProjects", {
              projects: activeProjects.map((project) => project.name).join(", "),
            }),
          })}
          {source.counts.removed
            ? ` · ${translateCount(t, "externalLibrary.removedCount", source.counts.removed)}`
            : ""}
        </small>
      </>
    ),
  };
}
function unusedSourceSection(sources: readonly ExternalSource[], input: Inputs): PageSection {
  const { t, open } = input;
  return {
    id: "unused",
    title: `${t("externalLibrary.unusedSources")} · ${sources.length}`,
    nodes: sources.map((source) => ({
      id: source.id,
      title: source.name,
      kind: "external",
      meta: translateCount(t, "externalLibrary.sourceSummary", source.skillCount, {
        licence: licenceLabel(source.licence, t),
        count: source.skillCount,
        projects: t("externalLibrary.noProject"),
      }),
      onOpen: () => open({ sourceId: source.id, view: "source" }),
    })),
  };
}
function macSection(input: Inputs, discoveries: ReadonlyMap<string, ExternalDiscovery>): PageSection | undefined {
  const { t, open, library } = input;
  const mac =
    library.mac?.marketplaces.filter(
      (item) =>
        !library.list?.sources.some((source) => source.repo?.toLowerCase() === item.repo.toLowerCase()) &&
        item.id !== input.personalMarketplaceName &&
        !(
          discoveries.get(item.repo)?.status === "ready" &&
          (discoveries.get(item.repo) as Extract<ExternalDiscovery, { status: "ready" }>).skills.length === 0
        ),
    ) ?? [];
  if (!mac.length) return undefined;
  return {
    id: "mac",
    title: (
      <>
        {t("externalLibrary.onMac")} <Glossary concept="onmac" /> <small>{t("externalLibrary.macHint")}</small>
      </>
    ),
    nodes: mac.map((item) => {
      const discovered = discoveries.get(item.repo);
      const count =
        discovered?.status === "ready"
          ? discovered.skills.length
            ? translateCount(t, "externalLibrary.skillCount", discovered.skills.length)
            : t("externalLibrary.commandsOnly")
          : discovered?.status === "failed"
            ? discovered.error.message
            : t("canvas.notRead");
      return {
        id: `mac:${item.repo}`,
        title: item.repo,
        kind: "external",
        unused: true,
        meta: (
          <>
            {count} · <span className="project-chip is-absent">{t("externalLibrary.add")}</span>
          </>
        ),
        onOpen: () => open({ view: "add", repository: item.repo }),
      };
    }),
  };
}
export function buildLibrarySections(
  input: Inputs,
  discoveries: ReadonlyMap<string, ExternalDiscovery>,
): readonly PageSection[] {
  const sources = input.library.list?.sources ?? [];
  const used = sources.filter((source) => source.projects.some((project) => input.activeProjectIds.has(project.id)));
  const unused = sources.filter((source) => !source.projects.some((project) => input.activeProjectIds.has(project.id)));
  const mac = macSection(input, discoveries);
  return [
    { id: "used", title: `${input.t("externalLibrary.used")} · ${used.length}`, nodes: [] },
    ...used.map((source) => usedSourceSection(source, input)),
    ...(unused.length ? [unusedSourceSection(unused, input)] : []),
    ...(mac ? [mac] : []),
  ];
}
export function buildSourceSections(
  details: ExternalSourceDetails | undefined,
  open: Inputs["open"],
  t: TranslationFunction,
  activeProjectIds: ReadonlySet<string>,
): readonly PageSection[] {
  if (!details?.source) return [];
  const targets = externalSkillTargets(details).filter((target) => {
    if (!target.useId) return true;
    return details.uses.some((use) => use.id === target.useId && activeProjectIds.has(use.projectId));
  });
  const used = targets.filter(
    (target) => !target.useId && activeUses(resolveExternalSkill(details, target).uses, activeProjectIds).length,
  );
  const unused = targets.filter(
    (target) => !target.useId && !activeUses(resolveExternalSkill(details, target).uses, activeProjectIds).length,
  );
  const removed = targets.filter((target) => target.useId);
  return (
    [
      ["used", "used", used],
      ["unused", "unused", unused],
      ["removed", "removedHeading", removed],
    ] as const
  )
    .filter(([, , names]) => names.length)
    .map(([id, label, names]) => ({
      id,
      title: (
        <>
          {t(`externalLibrary.${label}`)} · {names.length}
        </>
      ),
      nodes: skillNodes(details, names, open, t, activeProjectIds),
    }));
}
