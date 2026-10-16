import type { ObservedArtifact, ObservedPackage } from "../../domain/inventory";
import type { Observation, SourceEntryView } from "../../domain/project-source-registry";
import type { ObservationResponse } from "../../shared/registry-ipc";
import type { AuditReport } from "../audit/audit-report";
import { visibleIn } from "../../domain/compatibility";
import { tCount, type TranslationFunction } from "../i18n";

export type LibraryHarness = "claude-code" | "codex";
export type CompatibilityCoverage = Readonly<{ harnesses: readonly LibraryHarness[]; partial: boolean }>;

const LIBRARY_HARNESSES: readonly LibraryHarness[] = ["claude-code", "codex"];

export function compatibilityHarnessLabel(harness: LibraryHarness, t: TranslationFunction): string {
  return t(harness === "claude-code" ? "operations.harness.claudeCode" : "operations.harness.codex");
}

/**
 * Renders a plugin or marketplace's harness coverage in words, e.g. "Usable in Claude Code and
 * Codex" — the plugin head meta line uses it, and anything else showing the same three-state
 * coverage (usable in both / one only / neither) reuses it rather than re-deriving the phrasing.
 */
export function usableInLine(harnesses: readonly LibraryHarness[], t: TranslationFunction): string {
  if (harnesses.includes("claude-code") && harnesses.includes("codex")) return t("library.usableInBoth");
  if (harnesses.includes("claude-code")) return t("library.usableInClaudeCodeOnly");
  if (harnesses.includes("codex")) return t("library.usableInCodexOnly");
  return t("library.notYetUsable");
}

/**
 * The harnesses a package (or, unioned across packages, a marketplace) is not yet compatible
 * with — the "Make compatible with X" menu item is offered only for these, so a fully compatible
 * plugin or marketplace shows no such item at all.
 */
export function missingHarnesses(
  packages: readonly Pick<ObservedPackage, "manifestPaths">[],
): readonly LibraryHarness[] {
  // Nothing observed, or nothing in the marketplace: nothing to make compatible — offering
  // both harnesses "just in case" was flow-audit finding F11.
  if (!packages.length) return [];
  return LIBRARY_HARNESSES.filter((harness) =>
    packages.some((packageInfo) => !visibleIn(packageInfo).includes(harness)),
  );
}

export const packageKindOrder = ["skill", "command", "agent", "hook", "mcp-config", "instruction"] as const;
export type PackageKind = (typeof packageKindOrder)[number];

export function sourceObservation(
  source: SourceEntryView,
  audit: AuditReport | null,
  selectedObservation?: ObservationResponse | null,
): Observation | undefined {
  if (selectedObservation?.status === "observed" && selectedObservation.observation.subject.id === source.ref.id)
    return selectedObservation.observation;
  return audit?.observations.find(
    (candidate) => candidate.subject.kind === "source" && candidate.subject.id === source.ref.id,
  );
}

export function isManifest(artifact: ObservedArtifact): boolean {
  return artifact.kind === "plugin-manifest" || artifact.kind === "marketplace-manifest";
}

export function contentArtifacts(artifacts: readonly ObservedArtifact[]): readonly ObservedArtifact[] {
  return artifacts.filter((artifact) => !isManifest(artifact));
}

export function packageArtifacts(observation: Observation, packageId: string): readonly ObservedArtifact[] {
  return contentArtifacts(observation.inventory.artifacts.filter((artifact) => artifact.packageId === packageId));
}

export function packageKind(artifact: ObservedArtifact): PackageKind | undefined {
  if (packageKindOrder.includes(artifact.kind as PackageKind)) return artifact.kind as PackageKind;
  if (artifact.kind === "rule") return "instruction";
  return undefined;
}

export function countByKind(
  artifacts: readonly ObservedArtifact[],
  t: TranslationFunction,
  language: "en" | "fr",
): string {
  const labels: Readonly<Record<PackageKind, string>> = {
    skill: "skills",
    command: "commands",
    agent: "agents",
    hook: "hooks",
    "mcp-config": "mcp-config",
    instruction: "instructions",
  };
  return packageKindOrder
    .map((kind) => {
      const count = artifacts.filter((artifact) => packageKind(artifact) === kind).length;
      return count ? tCount(`library.kinds.${labels[kind]}`, count, {}, language) : null;
    })
    .filter((value): value is string => value !== null)
    .join(" · ");
}

export function packageCount(observation: Observation | undefined): number {
  return observation?.inventory.packages?.length ?? 0;
}

export function assetCount(observation: Observation | undefined): number {
  return observation ? contentArtifacts(observation.inventory.artifacts).length : 0;
}

export function hasGitScope(observation: Observation | undefined): boolean {
  return (observation?.inventory.gitScopes.length ?? 0) > 0;
}

/** "3.4M" / "3,4 M" — a compact, locale-aware install count for a catalogue row's meta line. */
export function formatInstalls(installs: number, language: "en" | "fr"): string {
  return new Intl.NumberFormat(language === "fr" ? "fr-FR" : "en-US", { notation: "compact" }).format(installs);
}

export function compatibilityCoverage(packages: readonly ObservedPackage[]): CompatibilityCoverage {
  if (!packages.length) return { harnesses: [], partial: false };
  const harnesses = (["claude-code", "codex"] as const).filter((harness) =>
    packages.some((packageInfo) => visibleIn(packageInfo).includes(harness)),
  );
  return {
    harnesses,
    partial: harnesses.some((harness) => !packages.every((packageInfo) => visibleIn(packageInfo).includes(harness))),
  };
}
