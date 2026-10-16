import {
  createInventoryDiagnostic,
  createGitScope,
  createInventorySnapshot,
  createObservedArtifact,
  createObservedPackage,
  type InventoryDiagnostic,
  type GitScope,
  type InventoryMarketplace,
  type InventoryObservationScope,
  type InventorySnapshot,
  type ObservedArtifact,
  type ObservedPackage,
  type ProviderStateEvidence,
} from "../domain/inventory";
import { createLocalInventoryPort } from "../adapters/inventory/local-filesystem";
import {
  createLocalGitAdapter,
  type InventoryGitPort,
  type LocalGitScopeRequest,
} from "../adapters/inventory/local-git";
import { claudeCodeInventoryDetector } from "../adapters/inventory/claude-code";
import { codexInventoryDetector } from "../adapters/inventory/codex";
import { cursorInventoryDetector } from "../adapters/inventory/cursor";
import { openCodeInventoryDetector } from "../adapters/inventory/opencode";
import { associateObservedPackages, sourceLayoutInventoryDetector } from "../adapters/inventory/source-layout";
import { normalizeGitScopes } from "./inventory-git";
import { mergePhysicalArtifacts } from "./inventory-merge";
import type { InventoryDetector, InventoryDetectorResult } from "../adapters/inventory/shared";
import type { InventoryFilesystemPort } from "../ports/inventory";
import { observeSkillOrigins } from "../adapters/inventory/skill-origins";

const DEFAULT_DETECTORS: readonly InventoryDetector[] = [
  claudeCodeInventoryDetector,
  codexInventoryDetector,
  cursorInventoryDetector,
  openCodeInventoryDetector,
  sourceLayoutInventoryDetector,
];

const DEFAULT_PROVIDER_DIAGNOSTIC = "The detector result was not usable.";
const REDACTED_DIAGNOSTIC = "The detector diagnostic was redacted.";

export type InventoryScanRequest = Readonly<{
  approvedRoot: string;
  rootHandle: string;
  displayRoot: string;
  scope: InventoryObservationScope;
  observedAt?: string;
  gitScopes?: readonly LocalGitScopeRequest[];
}>;

export type InventoryScanDependencies = {
  filesystem?: InventoryFilesystemPort;
  detectors?: readonly InventoryDetector[];
  git?: InventoryGitPort;
  now?: () => string;
};

type DetectorObservation = Readonly<{
  providerId: string;
  artifacts: readonly ObservedArtifact[];
  packages: readonly ObservedPackage[];
  marketplace?: InventoryMarketplace;
  diagnostics: readonly InventoryDiagnostic[];
}>;

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function diagnosticSort(left: InventoryDiagnostic, right: InventoryDiagnostic): number {
  if (right.location.startsWith(`${left.location}/`)) return 1;
  if (left.location.startsWith(`${right.location}/`)) return -1;
  const locationOrder = compareCodeUnits(left.location, right.location);
  if (locationOrder) return locationOrder;
  const codeOrder = compareCodeUnits(left.code, right.code);
  if (codeOrder) return codeOrder;
  const severityOrder = compareCodeUnits(left.severity, right.severity);
  return severityOrder || compareCodeUnits(left.message, right.message);
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function containsAbsolutePath(value: string): boolean {
  const normalized = stripWrappingQuotes(value).replaceAll("\\", "/");
  return (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    /(?:^|[^A-Za-z0-9_])(?:\/|[a-zA-Z]:\/)/.test(normalized)
  );
}

function safeProviderLocation(providerId: string): string {
  return safeRelativeLocation(providerId, "detector");
}

function malformedDiagnostic(providerId: string): InventoryDiagnostic {
  return createInventoryDiagnostic({
    location: safeProviderLocation(providerId),
    code: "malformed",
    severity: "warning",
    message: DEFAULT_PROVIDER_DIAGNOSTIC,
  });
}

function detectorFailureDiagnostic(providerId: string): InventoryDiagnostic {
  return createInventoryDiagnostic({
    location: safeProviderLocation(providerId),
    code: "inaccessible",
    severity: "warning",
    message: "The detector could not be observed; other providers were preserved.",
  });
}

function safeRelativeLocation(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = stripWrappingQuotes(value).replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (containsAbsolutePath(normalized) || segments.some((segment) => segment === "." || segment === "..")) {
    return fallback;
  }
  return normalized;
}

function safeDiagnosticMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return REDACTED_DIAGNOSTIC;
  const message = value.trim();
  if (
    message.length > 240 ||
    message.includes("\n") ||
    message.includes("\r") ||
    message.includes("---") ||
    /(?:password|secret|token|api[_-]?key|authorization)\s*[:=]/i.test(message)
  ) {
    return REDACTED_DIAGNOSTIC;
  }

  const quotedPath = /(["'])(?:[A-Za-z]:[\\/]|\\\\|\/\/|\/)[^\r\n]*?\1/g;
  const unquotedPath = /(?<![A-Za-z0-9._-])(?:[A-Za-z]:[\\/]|\\\\|\/\/|\/)[^\r\n"'`<>]*/g;
  return message.replace(quotedPath, "<absolute-path>").replace(unquotedPath, "<absolute-path>");
}

function safeRootHandle(value: unknown): string {
  if (typeof value !== "string") return "root";
  const normalized = stripWrappingQuotes(value);
  return normalized && !containsAbsolutePath(normalized) && !/[\r\n]/.test(normalized) ? normalized : "root";
}

function normalizeArtifactPath(value: unknown): string | undefined {
  return safeRelativeLocation(value, "") || undefined;
}

function normalizeProviderId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = stripWrappingQuotes(value);
  return normalized &&
    !containsAbsolutePath(normalized) &&
    !normalized.startsWith("\\") &&
    !normalized.split(/[\\/]/).some((segment) => segment === "." || segment === "..")
    ? normalized
    : undefined;
}

function normalizeDetectorDiagnostic(providerId: string, value: unknown): InventoryDiagnostic {
  if (typeof value !== "object" || value === null) return malformedDiagnostic(providerId);
  const candidate = value as Record<string, unknown>;
  const location = safeRelativeLocation(candidate.location, "");
  const message = safeDiagnosticMessage(candidate.message);
  if (!location || message === REDACTED_DIAGNOSTIC) return malformedDiagnostic(providerId);
  try {
    return createInventoryDiagnostic({
      location,
      code: candidate.code,
      severity: candidate.severity,
      message,
    });
  } catch {
    return malformedDiagnostic(providerId);
  }
}

function normalizeDetectorArtifact(
  providerId: string,
  value: unknown,
  scope: InventoryObservationScope,
  harnessAgnostic: boolean,
): ObservedArtifact | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = { ...(value as Record<string, unknown>) };
    const relativePath = normalizeArtifactPath(candidate.relativePath);
    const displayPath = normalizeArtifactPath(candidate.displayPath);
    const physicalIdentity = normalizeArtifactPath(candidate.physicalIdentity ?? relativePath);
    if (!relativePath || !displayPath || !physicalIdentity) return undefined;
    candidate.relativePath = relativePath;
    candidate.displayPath = displayPath;
    candidate.physicalIdentity = physicalIdentity;
    candidate.scope = scope;
    candidate.providerIds = harnessAgnostic
      ? Array.isArray(candidate.providerIds)
        ? candidate.providerIds
        : []
      : [providerId];
    delete candidate.id;
    if (candidate.projectionPaths !== undefined) {
      if (!Array.isArray(candidate.projectionPaths)) return undefined;
      const projectionPaths = candidate.projectionPaths.map(normalizeArtifactPath);
      if (projectionPaths.some((path) => !path)) return undefined;
      candidate.projectionPaths = projectionPaths;
    }
    if (candidate.providerIds !== undefined) {
      if (!Array.isArray(candidate.providerIds)) return undefined;
      const providerIds = candidate.providerIds.map(normalizeProviderId);
      if (providerIds.some((providerId) => !providerId)) return undefined;
      candidate.providerIds = providerIds;
    }
    if (Object.hasOwn(candidate, "providerState")) {
      const providerState = sanitizeProviderState(candidate.providerState);
      if (providerState) {
        candidate.providerState = providerState;
      } else {
        delete candidate.providerState;
      }
    }
    return createObservedArtifact(candidate);
  } catch {
    return undefined;
  }
}

function sanitizeProviderState(value: unknown): ProviderStateEvidence | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const revision =
    typeof candidate.revision === "string" && /^[0-9a-f]{4,64}$/i.test(candidate.revision.trim())
      ? candidate.revision.trim()
      : undefined;
  return {
    packageState: "unknown",
    activationState: "unknown",
    authenticationPolicy: "unknown",
    authenticationState: "unknown",
    ...(revision ? { revision } : {}),
  };
}

function isDetectorResult(value: unknown): value is InventoryDetectorResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.artifacts) && Array.isArray(candidate.diagnostics);
}

function normalizeDetectorPackage(value: unknown): ObservedPackage | undefined {
  try {
    return createObservedPackage(value);
  } catch {
    return undefined;
  }
}

async function observeDetector(
  detector: InventoryDetector,
  filesystem: InventoryFilesystemPort,
  scope: InventoryObservationScope,
): Promise<DetectorObservation> {
  let result: unknown;
  try {
    result = await detector.detect(filesystem, scope);
  } catch {
    return {
      providerId: detector.providerId,
      artifacts: [],
      packages: [],
      diagnostics: [detectorFailureDiagnostic(detector.providerId)],
    };
  }
  if (!isDetectorResult(result)) {
    return {
      providerId: detector.providerId,
      artifacts: [],
      packages: [],
      diagnostics: [malformedDiagnostic(detector.providerId)],
    };
  }

  const artifacts: ObservedArtifact[] = [];
  const diagnostics = result.diagnostics.map((diagnostic) =>
    normalizeDetectorDiagnostic(detector.providerId, diagnostic),
  );
  for (const candidate of result.artifacts) {
    const normalized = normalizeDetectorArtifact(
      detector.providerId,
      candidate,
      scope,
      detector.harnessAgnostic === true,
    );
    if (normalized) {
      artifacts.push(normalized);
    } else {
      diagnostics.push(malformedDiagnostic(detector.providerId));
    }
  }

  const packages: ObservedPackage[] = [];
  for (const candidate of result.packages ?? []) {
    const normalized = normalizeDetectorPackage(candidate);
    if (normalized) packages.push(normalized);
    else diagnostics.push(malformedDiagnostic(detector.providerId));
  }
  return {
    providerId: detector.providerId,
    artifacts,
    packages,
    ...(result.marketplace ? { marketplace: result.marketplace } : {}),
    diagnostics,
  };
}

function normalizeGitDiagnostics(diagnostics: readonly InventoryDiagnostic[]): InventoryDiagnostic[] {
  return diagnostics.map((diagnostic) => normalizeDetectorDiagnostic("git", diagnostic));
}

function deduplicateDiagnostics(diagnostics: readonly InventoryDiagnostic[]): InventoryDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function scanInventory(
  request: InventoryScanRequest,
  dependencies: InventoryScanDependencies = {},
): Promise<InventorySnapshot> {
  const filesystem = dependencies.filesystem ?? createLocalInventoryPort(request.approvedRoot);
  const detectors = (dependencies.detectors ?? DEFAULT_DETECTORS)
    .slice()
    .sort((left, right) => compareCodeUnits(left.providerId, right.providerId));
  const git = dependencies.git ?? createLocalGitAdapter();
  const observations = await Promise.all(
    detectors.map((detector) => observeDetector(detector, filesystem, request.scope)),
  );
  const detectorArtifacts = observations.flatMap((observation) => observation.artifacts);
  const observedPackages = observations.flatMap((observation) => observation.packages);
  const marketplace = observations.map((observation) => observation.marketplace).find(Boolean);
  const detectorDiagnostics = observations.flatMap((observation) => observation.diagnostics);
  let gitEvidence: { scopes: GitScope[]; diagnostics: InventoryDiagnostic[] } = {
    scopes: [],
    diagnostics: [],
  };
  try {
    const observedGit = await git.collect({
      approvedRoot: request.approvedRoot,
      scopes: request.gitScopes ?? [{ path: request.approvedRoot, relativeRoot: request.displayRoot }],
    });
    const normalizedGit = normalizeGitScopes(observedGit.scopes, { safeRelativeLocation, malformedDiagnostic });
    gitEvidence = {
      scopes: normalizedGit.scopes,
      diagnostics: [...normalizeGitDiagnostics(observedGit.diagnostics), ...normalizedGit.diagnostics],
    };
  } catch {
    gitEvidence.diagnostics.push(
      createInventoryDiagnostic({
        location: safeRelativeLocation(request.displayRoot, "git"),
        code: "git-unavailable",
        severity: "warning",
        message: "Git evidence could not be observed for this explicit scope.",
      }),
    );
  }
  const artifacts = mergePhysicalArtifacts(detectorArtifacts);
  const packages = associateObservedPackages(observedPackages, artifacts);
  const skillOriginObservation =
    request.scope === "project" ? await observeSkillOrigins(filesystem, artifacts) : { origins: [], diagnostics: [] };
  const diagnostics = deduplicateDiagnostics(
    [...detectorDiagnostics, ...gitEvidence.diagnostics, ...skillOriginObservation.diagnostics].sort(diagnosticSort),
  );
  const harnesses = [...new Set(artifacts.flatMap((artifact) => artifact.providerIds))]
    .filter((providerId) => providerId !== "source-layout")
    .sort(compareCodeUnits);

  return createInventorySnapshot({
    rootHandle: safeRootHandle(request.rootHandle),
    displayRoot: safeRelativeLocation(request.displayRoot, request.scope),
    observedAt: request.observedAt ?? (dependencies.now ?? (() => new Date().toISOString()))(),
    harnesses,
    artifacts,
    skillOrigins: skillOriginObservation.origins,
    packages,
    ...(marketplace ? { marketplace } : {}),
    diagnostics,
    gitScopes: gitEvidence.scopes,
  });
}
