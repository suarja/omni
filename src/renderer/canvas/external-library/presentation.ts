import type { ExternalComparison, ExternalSourceDetails, ExternalUse } from "../../../shared/external-library-ipc";
import type { ProjectSkillRow } from "../../../shared/project-skills-ipc";
import type { TranslationFunction } from "../../i18n";

export type SourceFilter = "all" | "used" | "unused";
export function needsComparison(use: ExternalUse): boolean {
  return use.state === "modified" && use.sourceChanged;
}
export function waitsForUpdate(use: ExternalUse): boolean {
  return use.state === "update" || needsComparison(use);
}
export function findRowUse(
  uses: readonly ExternalUse[],
  row: ProjectSkillRow,
  projectId?: string,
): ExternalUse | undefined {
  const origin = row.origin;
  return origin.kind === "external"
    ? uses.find(
        (use) =>
          use.sourceId.toLowerCase() === origin.source.toLowerCase() &&
          use.skillKey === row.name &&
          (!projectId || use.projectId === projectId),
      )
    : undefined;
}
export function useStateLabel(use: ExternalUse, t: TranslationFunction): string {
  if (use.state === "removed")
    return t(
      !use.lockStale && use.copyHash && use.copyHash !== use.lockHash
        ? "externalLibrary.modifiedRemoved"
        : "externalLibrary.removed",
    );
  return t(
    use.state === "modified"
      ? use.sourceChanged
        ? "externalLibrary.modifiedUpdate"
        : "externalLibrary.modified"
      : use.state === "update"
        ? "externalLibrary.update"
        : use.state === "unknown"
          ? "externalLibrary.unknown"
          : "externalLibrary.current",
  );
}
export function filterSourceSkills(
  details: ExternalSourceDetails,
  filter: SourceFilter,
  query: string,
): ExternalSourceDetails["skills"] {
  const text = query.trim().toLocaleLowerCase();
  return details.skills.filter(
    (skill) =>
      (filter === "all" || (filter === "used" ? skill.useIds.length > 0 : skill.useIds.length === 0)) &&
      (!text || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(text)),
  );
}
export function changedFiles(comparison: ExternalComparison): ExternalComparison["files"] {
  return comparison.files.filter((file) => file.classification !== "unchanged");
}
export function comparisonReady(
  comparison: ExternalComparison,
  choices: Readonly<Record<string, "mine" | "source">>,
  wholeCopy?: "mine" | "source",
): boolean {
  if (comparison.base.status === "not-found") return Boolean(wholeCopy);
  return (
    comparison.status === "ready" &&
    comparison.base.status === "found" &&
    comparison.files.every((file) => file.classification !== "conflict" || Boolean(choices[file.path]))
  );
}
export function formatSourceDate(value: string | undefined, language: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(language === "fr" ? "fr-FR" : "en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
export function formatCheckTime(value: string | undefined, language: string): string {
  return value
    ? new Intl.DateTimeFormat(language === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit" }).format(
        new Date(value),
      )
    : "—";
}
export function formatPassTime(
  value: string | undefined,
  t: TranslationFunction,
  language: string,
  now = new Date(),
): string {
  if (!value) return "—";
  const pass = new Date(value);
  const day = (date: Date): number => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const elapsedDays = (day(now) - day(pass)) / 86_400_000;
  const time = formatCheckTime(value, language);
  if (elapsedDays === 0) {
    const period = pass.getHours() < 12 ? "morning" : pass.getHours() < 18 ? "afternoon" : "evening";
    return t(`externalLibrary.passTime.${period}`, { time });
  }
  if (elapsedDays === 1) return t("externalLibrary.passTime.yesterday", { time });
  const date = new Intl.DateTimeFormat(language === "fr" ? "fr-FR" : "en-GB", {
    day: "numeric",
    month: "short",
  }).format(pass);
  return t("externalLibrary.passTime.date", { date, time });
}
export function useProjectLabel(use: ExternalUse, uses: readonly ExternalUse[]): string {
  const sameSkill = uses.filter(
    (other) =>
      other.projectId === use.projectId &&
      other.sourceId === use.sourceId &&
      (other.skillPath ?? other.skillKey) === (use.skillPath ?? use.skillKey),
  );
  return sameSkill.length > 1 ? `${use.projectName} · ${use.skillKey}` : use.projectName;
}
export function externalReviewItems(
  details: readonly ExternalSourceDetails[],
  mode: "auto" | "ask",
): readonly Readonly<{
  key: string;
  kind: "modified" | "removed" | "update" | "failure";
  sourceId: string;
  use?: ExternalUse;
  count?: number;
}>[] {
  const result: {
    key: string;
    kind: "modified" | "removed" | "update" | "failure";
    sourceId: string;
    use?: ExternalUse;
    count?: number;
  }[] = [];
  let removedCount = 0;
  for (const item of details) {
    if (!item.source) continue;
    const sourceId = item.source.id;
    for (const use of item.uses) {
      if (use.lastAutomaticFailure) result.push({ key: `failure:${use.id}`, kind: "failure", sourceId, use });
      else if (needsComparison(use)) result.push({ key: `modified:${use.id}`, kind: "modified", sourceId, use });
    }
    const removed = item.uses.filter((use) => use.state === "removed" && !use.acknowledged).length;
    removedCount += removed;
    const updates = item.uses.filter((use) => use.state === "update" && !use.lastAutomaticFailure).length;
    if (mode === "ask" && updates) result.push({ key: `update:${sourceId}`, kind: "update", sourceId, count: updates });
  }
  if (removedCount) result.push({ key: "removed:all", kind: "removed", sourceId: "", count: removedCount });
  return result;
}

export function licenceLabel(licence: string, t: TranslationFunction): string {
  return licence === "none"
    ? t("externalLibrary.licenceAbsent")
    : licence === "other"
      ? t("externalLibrary.licenceOther")
      : licence;
}
