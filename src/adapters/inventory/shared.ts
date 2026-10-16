import {
  createInventoryDiagnostic,
  createObservedArtifact,
  type EvidenceConfidence,
  type InventoryArtifactKind,
  type InventoryDiagnostic,
  type InventoryMarketplace,
  type InventoryObservationScope,
  type InventoryScope,
  type ObservedArtifact,
  type ObservedPackage,
  type ProviderStateEvidence,
  type SymlinkState,
} from "../../domain/inventory";
import { parseFrontmatter } from "./frontmatter";
import { InventoryFilesystemError, type InventoryFileType, type InventoryFilesystemPort } from "../../ports/inventory";

export type InventoryDetectorResult = Readonly<{
  providerId: string;
  artifacts: readonly ObservedArtifact[];
  packages?: readonly ObservedPackage[];
  marketplace?: InventoryMarketplace;
  diagnostics: readonly InventoryDiagnostic[];
}>;

export type InventoryDetector = Readonly<{
  providerId: string;
  harnessAgnostic?: boolean;
  detect(filesystem: InventoryFilesystemPort, scope: InventoryObservationScope): Promise<InventoryDetectorResult>;
}>;

type ContentParser = "json" | "skill-frontmatter" | "frontmatter";

export type ScanLocation = Readonly<{
  path: string;
  kind: InventoryArtifactKind;
  mode: "file" | "tree" | "manifest-tree";
  parser?: ContentParser;
}>;

type ArtifactCandidate = Readonly<{
  path: string;
  kind: InventoryArtifactKind;
  physicalIdentity: string;
  symlinkState: SymlinkState;
  confidence: EvidenceConfidence;
  summary?: string;
}>;

type DetectorScan = {
  readonly providerId: string;
  readonly filesystem: InventoryFilesystemPort;
  readonly candidates: ArtifactCandidate[];
  readonly diagnostics: InventoryDiagnostic[];
};

const UNKNOWN_PROVIDER_STATE: ProviderStateEvidence = {
  packageState: "unknown",
  activationState: "unknown",
  authenticationPolicy: "unknown",
  authenticationState: "unknown",
};

const DIAGNOSTIC_SEVERITY = "warning" as const;
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "build",
  "dist",
  ".next",
  "out",
  "coverage",
  "sessions",
  "logs",
  "cache",
  "caches",
]);

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function joinRelativePath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function isExcludedPath(path: string): boolean {
  return path.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment) || segment.startsWith(".env"));
}

export function diagnostic(location: string, code: InventoryDiagnostic["code"], message: string): InventoryDiagnostic {
  return createInventoryDiagnostic({
    location,
    code,
    severity: DIAGNOSTIC_SEVERITY,
    message,
  });
}

export function errorDiagnostic(location: string, error: unknown): InventoryDiagnostic | undefined {
  if (error instanceof InventoryFilesystemError) {
    const code =
      error.code === "oversized"
        ? "oversized"
        : error.code === "unsupported"
          ? "unsupported"
          : error.code === "invalid-utf8"
            ? "malformed"
            : error.code === "not-found"
              ? undefined
              : "inaccessible";
    return code ? diagnostic(location, code, "The documented inventory location could not be observed.") : undefined;
  }

  return diagnostic(location, "inaccessible", "The documented inventory location could not be observed.");
}

function manifestKind(path: string): InventoryArtifactKind {
  const name = path.split("/").at(-1);
  if (name === "plugin.json") return "plugin-manifest";
  if (name === "marketplace.json") return "marketplace-manifest";
  return "unknown";
}

function parserFor(kind: InventoryArtifactKind, path: string): ContentParser | undefined {
  if (kind === "skill" && path.split("/").at(-1) === "SKILL.md") return "skill-frontmatter";
  if ((kind === "command" || kind === "agent") && path.endsWith(".md")) return "frontmatter";
  if (kind === "mcp-config" || kind === "plugin-manifest" || kind === "marketplace-manifest") {
    return path.endsWith(".json") ? "json" : undefined;
  }
  return undefined;
}

function compareSymlinkState(left: SymlinkState, right: SymlinkState): SymlinkState {
  if (left === "external" || right === "external") return "external";
  if (left === "broken" || right === "broken") return "broken";
  if (left === "inside-root" || right === "inside-root") return "inside-root";
  return "none";
}

function compareConfidence(left: EvidenceConfidence, right: EvidenceConfidence): EvidenceConfidence {
  const rank: Readonly<Record<EvidenceConfidence, number>> = {
    unknown: 0,
    heuristic: 1,
    exact: 2,
  };
  return rank[left] <= rank[right] ? left : right;
}

function firstSummary(candidates: readonly ArtifactCandidate[]): string | undefined {
  return candidates.map((candidate) => candidate.summary).find(Boolean);
}

function isRegularFile(type: InventoryFileType): boolean {
  return type === "file";
}

function isSupportedArtifactType(type: InventoryFileType): boolean {
  return type === "file" || type === "symlink";
}

function parseSkillFrontmatter(text: string): string | undefined {
  const parsed = parseFrontmatter(text, true);
  return parsed.valid ? parsed.description : undefined;
}

type MetadataValidation = Readonly<{ valid: boolean; summary?: string }>;

async function validateMetadata(scan: DetectorScan, path: string, parser: ContentParser): Promise<MetadataValidation> {
  let text: string;
  try {
    text = await scan.filesystem.readText(path);
  } catch (error: unknown) {
    const issue = errorDiagnostic(path, error);
    if (issue) scan.diagnostics.push(issue);
    return { valid: parser !== "skill-frontmatter" };
  }

  let valid = true;
  let summary: string | undefined;
  if (parser === "json") {
    try {
      JSON.parse(text);
    } catch {
      valid = false;
    }
  } else if (parser === "skill-frontmatter") {
    const parsed = parseFrontmatter(text, true);
    valid = parsed.valid;
    summary = valid ? parseSkillFrontmatter(text) : undefined;
  } else {
    const parsed = parseFrontmatter(text, false);
    valid = parsed.valid;
    summary = parsed.description;
  }

  if (!valid) {
    scan.diagnostics.push(diagnostic(path, "malformed", "Metadata at the documented location is malformed."));
  }

  return { valid: parser !== "skill-frontmatter" || valid, ...(summary ? { summary } : {}) };
}

async function observeArtifact(
  scan: DetectorScan,
  path: string,
  kind: InventoryArtifactKind,
  parser?: ContentParser,
): Promise<void> {
  let location;
  try {
    location = await scan.filesystem.lstat(path);
  } catch (error: unknown) {
    const issue = errorDiagnostic(path, error);
    if (issue) scan.diagnostics.push(issue);
    return;
  }

  if (!isSupportedArtifactType(location.type)) {
    scan.diagnostics.push(diagnostic(path, "unsupported", "The documented marker is not a supported file."));
    return;
  }

  let physicalIdentity = path;
  let symlinkState: SymlinkState = "none";
  if (location.type === "symlink") {
    try {
      const evidence = await scan.filesystem.realpathEvidence(path);
      symlinkState =
        evidence.status === "inside-root" ? "inside-root" : evidence.status === "outside-root" ? "external" : "broken";
      if (evidence.realpath) physicalIdentity = evidence.realpath;
      if (evidence.status === "outside-root") {
        scan.diagnostics.push(diagnostic(path, "outside-root", "The marker resolves outside the approved root."));
      } else if (evidence.status === "broken") {
        scan.diagnostics.push(diagnostic(path, "broken-link", "The marker is a broken symbolic link."));
      }
    } catch (error: unknown) {
      const issue = errorDiagnostic(path, error);
      if (issue) scan.diagnostics.push(issue);
      return;
    }
  } else {
    try {
      const evidence = await scan.filesystem.realpathEvidence(path);
      if (evidence.status !== "inside-root" || !evidence.realpath) {
        scan.diagnostics.push(diagnostic(path, "inaccessible", "The marker has no canonical physical identity."));
        return;
      }
      physicalIdentity = evidence.realpath;
    } catch (error: unknown) {
      const issue = errorDiagnostic(path, error);
      if (issue) scan.diagnostics.push(issue);
      return;
    }
  }

  let confidence: EvidenceConfidence = "exact";
  let summary: string | undefined;
  if (parser && isRegularFile(location.type)) {
    const metadata = await validateMetadata(scan, path, parser);
    if (!metadata.valid) confidence = "heuristic";
    summary = metadata.summary;
  }

  scan.candidates.push({
    path,
    kind,
    physicalIdentity,
    symlinkState,
    confidence,
    ...(summary ? { summary } : {}),
  });
}

async function scanTree(scan: DetectorScan, location: ScanLocation, path: string): Promise<void> {
  if (isExcludedPath(path)) return;

  let entries;
  try {
    entries = await scan.filesystem.listDirectory(path);
  } catch (error: unknown) {
    const issue = errorDiagnostic(path, error);
    if (issue) scan.diagnostics.push(issue);
    return;
  }

  for (const entry of [...entries].sort((left, right) => compareCodeUnits(left.name, right.name))) {
    const entryPath = joinRelativePath(path, entry.name);
    if (isExcludedPath(entryPath)) continue;
    if (entry.type === "directory") {
      await scanTree(scan, location, entryPath);
      continue;
    }
    if (entry.type === "symlink") {
      const kind = location.mode === "manifest-tree" ? manifestKind(entryPath) : location.kind;
      await observeArtifact(scan, entryPath, kind, parserFor(kind, entryPath));
      continue;
    }
    if (entry.type === "file") {
      const kind = location.mode === "manifest-tree" ? manifestKind(entryPath) : location.kind;
      await observeArtifact(scan, entryPath, kind, parserFor(kind, entryPath));
      continue;
    }
    scan.diagnostics.push(diagnostic(entryPath, "unsupported", "The marker is not a supported file."));
  }
}

async function scanLocation(scan: DetectorScan, location: ScanLocation): Promise<void> {
  let observed;
  try {
    observed = await scan.filesystem.lstat(location.path);
  } catch (error: unknown) {
    const issue = errorDiagnostic(location.path, error);
    if (issue) scan.diagnostics.push(issue);
    return;
  }

  if (location.mode === "file") {
    await observeArtifact(scan, location.path, location.kind, location.parser);
    return;
  }

  if (observed.type !== "directory") {
    scan.diagnostics.push(diagnostic(location.path, "unsupported", "The documented marker must be a directory."));
    return;
  }

  await scanTree(scan, location, location.path);
}

function mergeCandidates(
  providerId: string,
  candidates: readonly ArtifactCandidate[],
  scope: InventoryObservationScope,
): ObservedArtifact[] {
  const groups = new Map<string, ArtifactCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}\u0000${candidate.physicalIdentity}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const projections = [...new Set(group.map((candidate) => candidate.path))].sort(compareCodeUnits);
      const first = group.slice().sort((left, right) => compareCodeUnits(left.path, right.path))[0];
      const summary = firstSummary(group);
      return createObservedArtifact({
        kind: first.kind,
        relativePath: projections[0],
        displayPath: projections[0],
        physicalIdentity: first.physicalIdentity,
        projectionPaths: projections,
        providerIds: [providerId],
        scope: scope satisfies InventoryScope,
        confidence: group.reduce(
          (confidence, candidate) => compareConfidence(confidence, candidate.confidence),
          "exact" as EvidenceConfidence,
        ),
        symlinkState: group.reduce(
          (state, candidate) => compareSymlinkState(state, candidate.symlinkState),
          "none" as SymlinkState,
        ),
        ...(summary ? { summary } : {}),
        providerState: UNKNOWN_PROVIDER_STATE,
      });
    })
    .sort((left, right) => {
      const pathOrder = compareCodeUnits(left.relativePath, right.relativePath);
      return pathOrder || compareCodeUnits(left.kind, right.kind);
    });
}

function addDuplicateProjectionDiagnostics(
  candidates: readonly ArtifactCandidate[],
  diagnostics: InventoryDiagnostic[],
): void {
  const pathsByIdentity = new Map<string, string[]>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}\u0000${candidate.physicalIdentity}`;
    const paths = pathsByIdentity.get(key) ?? [];
    paths.push(candidate.path);
    pathsByIdentity.set(key, paths);
  }

  for (const paths of pathsByIdentity.values()) {
    const uniquePaths = [...new Set(paths)].sort(compareCodeUnits);
    if (uniquePaths.length > 1) {
      diagnostics.push(
        diagnostic(
          uniquePaths[0],
          "duplicate-projection",
          "Multiple documented projections share one physical artifact.",
        ),
      );
    }
  }
}

export async function scanInventoryLocations(
  providerId: string,
  filesystem: InventoryFilesystemPort,
  locations: readonly ScanLocation[],
  scope: InventoryObservationScope,
): Promise<InventoryDetectorResult> {
  const scan: DetectorScan = {
    providerId,
    filesystem,
    candidates: [],
    diagnostics: [],
  };

  for (const location of locations) await scanLocation(scan, location);
  addDuplicateProjectionDiagnostics(scan.candidates, scan.diagnostics);

  const diagnostics = [...scan.diagnostics].sort((left, right) => {
    const locationOrder = compareCodeUnits(left.location, right.location);
    return locationOrder || compareCodeUnits(left.code, right.code);
  });

  return {
    providerId,
    artifacts: mergeCandidates(providerId, scan.candidates, scope),
    diagnostics,
  };
}

export function fileLocation(path: string, kind: InventoryArtifactKind, parser?: ContentParser): ScanLocation {
  return { path, kind, mode: "file", ...(parser ? { parser } : {}) };
}

export function treeLocation(path: string, kind: InventoryArtifactKind): ScanLocation {
  return { path, kind, mode: "tree" };
}

export function manifestTreeLocation(path: string): ScanLocation {
  return { path, kind: "unknown", mode: "manifest-tree" };
}
