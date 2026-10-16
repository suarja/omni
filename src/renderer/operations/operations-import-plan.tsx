import { slugify } from "../../domain/marketplace-format";
import { visibleIn } from "../../domain/compatibility";
import { artifactName } from "../../domain/identity";
import type { Harness } from "../../domain/harness-projection";
import type { ObservedArtifact, ObservedPackage } from "../../domain/inventory";
import type { EntryRef, Observation } from "../../domain/project-source-registry";
import type { OperationAction, OperationPlan } from "../../shared/operations-ipc";
import { useI18n, tCount } from "../i18n";
import { packageArtifacts } from "../library/library-data";
import type { ReactElement } from "react";
import { Badge } from "../components/ui/Badge";

export type Target = Readonly<
  { kind: "none" } | { kind: "package"; packageId: string } | { kind: "new"; name: string; description?: string }
>;

export function targetIsValid(target: Target): boolean {
  if (target.kind === "none") return false;
  return (
    target.kind === "package" ||
    (target.name.trim().length > 0 &&
      Boolean(target.description?.trim()) &&
      slugify(target.name).length > 0 &&
      !/[\\/]/u.test(target.name) &&
      !target.name.includes(".."))
  );
}

export function projectionHarnesses(observation: Observation | null): readonly Harness[] {
  const paths = [
    ...(observation?.inventory.marketplace ? [observation.inventory.marketplace.manifestPath] : []),
    ...(observation?.inventory.artifacts
      .filter((artifact) => artifact.kind === "marketplace-manifest")
      .flatMap((artifact) => [artifact.relativePath, ...artifact.projectionPaths]) ?? []),
    ...(observation?.inventory.packages?.flatMap((pkg) => pkg.manifestPaths) ?? []),
  ].map((path) => path.replaceAll("\\", "/"));
  return [
    ...(paths.some((path) => path.includes(".claude-plugin/marketplace.json")) ? ["claude-code" as const] : []),
    ...(paths.some(
      (path) => path.includes(".agents/plugins/marketplace.json") || path.includes(".codex-plugin/marketplace.json"),
    )
      ? ["codex" as const]
      : []),
  ];
}

export function harnessLabel(harness: "omni" | Harness, t: ReturnType<typeof useI18n>["t"]): string {
  if (harness === "omni") return t("operations.harness.omni");
  return harness === "claude-code" ? t("operations.harness.claudeCode") : t("operations.harness.codex");
}

export function packageBadges(packageInfo: ObservedPackage, t: ReturnType<typeof useI18n>["t"]): ReactElement {
  return (
    <>
      {visibleIn(packageInfo).map((harness) => (
        <Badge key={harness} variant="type">
          {harnessLabel(harness, t)}
        </Badge>
      ))}
    </>
  );
}

export function importTitle(origin: EntryRef, name: string, t: ReturnType<typeof useI18n>["t"]): string {
  return origin.kind === "project"
    ? t("operations.import.captureTitle", { name })
    : t("operations.import.importTitle", { name });
}

export function preferredArtifactPath(artifact: ObservedArtifact): string {
  const paths = [artifact.relativePath, ...artifact.projectionPaths].map((path) => path.replaceAll("\\", "/"));
  const skillPaths = artifact.kind === "skill" ? paths.filter((path) => path.includes(".claude/skills/")) : [];
  const candidates = skillPaths.length ? skillPaths : paths;
  // Prefer Claude skill projections, then choose shortest and lexical order for deterministic rendering.
  return (
    [...candidates].sort((left, right) => left.length - right.length || left.localeCompare(right))[0] ??
    artifact.relativePath
  );
}

export function formatByteSize(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
}

export function packageAssetCount(observation: Observation | null, packageInfo: ObservedPackage): number {
  return observation ? packageArtifacts(observation, packageInfo.id).length : 0;
}

export function writeFileActions(plan: OperationPlan): readonly OperationAction[] {
  return plan.actions.filter((action) => action.kind === "write-file" && !action.manifest);
}

export function packageRelativePath(path: string, packagePath: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedPackagePath = packagePath.replaceAll("\\", "/").replace(/\/$/u, "");
  return normalizedPath.startsWith(`${normalizedPackagePath}/`)
    ? normalizedPath.slice(normalizedPackagePath.length + 1)
    : normalizedPath;
}

export function compactFilePath(path: string, plan: OperationPlan, artifact: ObservedArtifact, name: string): string {
  const relativePath = packageRelativePath(path, plan.displayTarget);
  const unitPrefix = artifact.kind === "skill" ? `skills/${name}/` : artifact.kind === "hook" ? `hooks/${name}/` : "";
  if (unitPrefix && relativePath.startsWith(unitPrefix)) return relativePath.slice(unitPrefix.length);
  return relativePath.split("/").at(-1) ?? relativePath;
}

export function manifestNames(plan: OperationPlan): string {
  return plan.actions
    .filter((action) => action.kind === "write-file" && action.manifest)
    .map((action) => packageRelativePath(action.relativePath, plan.displayTarget))
    .join(" · ");
}

export function gitLabel(plan: OperationPlan, marketplaceName: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (plan.git.mode === "commit") return t("operations.preview.gitCommit", { target: marketplaceName });
  return plan.git.warnings[0] ?? t("operations.preview.gitNoCommit");
}
