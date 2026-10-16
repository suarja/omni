import type {
  EntryRef,
  Observation,
  RegistryEntryView,
  RegistryView,
  SourceEntryView,
} from "../../domain/project-source-registry";
import type { ObservedPackage } from "../../domain/inventory";
import {
  deriveIdentityFindings,
  type ArtifactIdentity,
  type IdentityFinding,
  type PhysicalIdentityLookup,
} from "../../domain/identity";
import { fallbackLanguage, t, tCount, type AppLanguage, type TranslationKey } from "../i18n";

export type AuditObservation = Observation &
  Readonly<{
    identities?: readonly ArtifactIdentity[];
    skipped?: readonly Readonly<{ artifactId: string; reason: "too-large" | "binary" | "unavailable" | "denied" }>[];
  }>;

export type AuditFinding = Readonly<{
  entry: EntryRef;
  kind: "availability" | "diagnostic" | "exact-duplicate" | "variant" | "unsupported-format" | "loose";
  severity: "info" | "warning" | "error";
  message: string;
  /** Up to three artifact names backing the message, shown as the row sub line. Absent for non-identity findings. */
  examples?: readonly string[];
}>;

export type AuditReport = Readonly<{
  observations: readonly AuditObservation[];
  findings: readonly AuditFinding[];
  unavailable: readonly EntryRef[];
}>;

export type AuditReportInput = Readonly<{
  observations: readonly AuditObservation[];
  findings: readonly AuditFinding[];
  unavailable: readonly EntryRef[];
  registry: RegistryView;
  language?: AppLanguage;
}>;

function entryKey(entry: EntryRef): string {
  return `${entry.kind}:${entry.id}`;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareEntries(left: EntryRef, right: EntryRef): number {
  return compareText(entryKey(left), entryKey(right));
}

function compareFindings(left: AuditFinding, right: AuditFinding): number {
  const kindComparison = compareText(left.kind, right.kind);
  if (kindComparison !== 0) return kindComparison;
  const messageComparison = compareText(left.message, right.message);
  if (messageComparison !== 0) return messageComparison;
  return compareEntries(left.entry, right.entry);
}

function diagnosticFindings(observations: readonly AuditObservation[]): AuditFinding[] {
  return observations.flatMap((observation) =>
    observation.inventory.diagnostics.map((diagnostic) => ({
      entry: observation.subject,
      kind: "diagnostic" as const,
      severity: diagnostic.severity,
      message: diagnostic.message,
    })),
  );
}

function uniqueEntries(entries: readonly EntryRef[]): EntryRef[] {
  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      const key = entryKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareEntries);
}

function displayNameFor(registry: RegistryView, ref: EntryRef): string {
  const entries: readonly (RegistryEntryView | SourceEntryView)[] =
    ref.kind === "project" ? registry.projects : registry.sources;
  const entry = entries.find((candidate) => candidate.ref.id === ref.id);
  return entry?.displayName || entry?.displayRoot || ref.id;
}

/** Joins display names as a readable list: "A and B" for two, "A, B, and C" for three or more. */
function joinNames(names: readonly string[], language: AppLanguage): string {
  if (names.length < 2) return names.join("");
  const conjunction = language === "fr" ? "et" : "and";
  if (names.length === 2) return `${names[0]} ${conjunction} ${names[1]}`;
  const leading = names.slice(0, -1).join(", ");
  const last = names[names.length - 1];
  return language === "fr" ? `${leading} ${conjunction} ${last}` : `${leading}, ${conjunction} ${last}`;
}

function formatRootNames(registry: RegistryView, roots: readonly EntryRef[], language: AppLanguage): string {
  return joinNames(
    roots.map((ref) => displayNameFor(registry, ref)),
    language,
  );
}

function messageFor(
  finding: IdentityFinding,
  registry: RegistryView,
  packages: readonly ObservedPackage[],
  language: AppLanguage,
): string {
  const examples = finding.examples.join(", ");
  switch (finding.kind) {
    case "exact-duplicate": {
      if (finding.roots.length === 1) {
        const root = displayNameFor(registry, finding.roots[0]!);
        return tCount("review.message.exactDuplicateSingle", finding.count, { root, examples }, language);
      }
      const roots = formatRootNames(registry, finding.roots, language);
      return tCount("review.message.exactDuplicate", finding.count, { roots, examples }, language);
    }
    case "loose": {
      const root = displayNameFor(registry, finding.roots[0]!);
      return tCount("review.message.loose", finding.count, { root }, language);
    }
    case "variant": {
      const roots = formatRootNames(registry, finding.roots, language);
      return t("review.message.variant" as TranslationKey, { logicalId: finding.logicalId ?? "", roots }, language);
    }
    case "unsupported-format": {
      const packageInfo = packages.find((candidate) => candidate.id === finding.packageId);
      return t(
        "review.message.unsupportedFormat" as TranslationKey,
        { package: packageInfo?.displayName ?? finding.packageId ?? "" },
        language,
      );
    }
  }
}

function identityAuditFindings(
  findings: readonly IdentityFinding[],
  registry: RegistryView,
  packages: readonly ObservedPackage[],
  language: AppLanguage,
): AuditFinding[] {
  return findings.map((finding) => ({
    entry: finding.roots[0]!,
    kind: finding.kind,
    severity: finding.severity,
    message: messageFor(finding, registry, packages, language),
    examples: finding.examples,
  }));
}

function buildPhysicalIdentityLookup(observations: readonly AuditObservation[]): PhysicalIdentityLookup {
  const lookup = new Map<string, string>();
  for (const observation of observations) {
    for (const artifact of observation.inventory.artifacts) {
      lookup.set(artifact.id, artifact.physicalIdentity);
    }
  }
  return lookup;
}

export function composeAuditReport(input: AuditReportInput): AuditReport {
  const observations = [...input.observations].sort((left, right) => compareEntries(left.subject, right.subject));
  const identities = observations.flatMap((observation) => observation.identities ?? []);
  const packages = observations.flatMap((observation) => observation.inventory.packages ?? []);
  const diagnostics = observations.flatMap((observation) => observation.inventory.diagnostics);
  const physicalIdentities = buildPhysicalIdentityLookup(observations);
  const identityFindings = deriveIdentityFindings(identities, packages, diagnostics, physicalIdentities);
  const language = input.language ?? fallbackLanguage;
  const findings = [
    ...input.findings,
    ...diagnosticFindings(observations),
    ...identityAuditFindings(identityFindings, input.registry, packages, language),
  ].sort(compareFindings);
  return {
    observations,
    findings,
    unavailable: uniqueEntries(input.unavailable),
  };
}

function activeEntries(registry: RegistryView): RegistryEntryView[] {
  return [...registry.projects, ...registry.sources]
    .filter((entry) => entry.archivedAt === undefined)
    .sort((left, right) => compareEntries(left.ref, right.ref));
}

export function selectAuditEntries(
  registry: RegistryView,
  selectedRefs?: readonly EntryRef[],
): readonly RegistryEntryView[] {
  const entries = activeEntries(registry);
  if (!selectedRefs) return entries;

  const selected = new Set(selectedRefs.map(entryKey));
  return entries.filter((entry) => selected.has(entryKey(entry.ref)));
}
