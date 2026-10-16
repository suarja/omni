import { createInventoryDiagnostic, type InventoryDiagnostic, type ObservedArtifact } from "../../domain/inventory";
import { parseSkillOriginEvidence } from "../../domain/skill-origins/validation";
import { parseSkillsLock } from "../../domain/skill-origins/skills-lock";
import type { SkillOriginEvidence } from "../../domain/skill-origins/types";
import type { InventoryFilesystemPort } from "../../ports/inventory";
import { hashSkillFolder, type SkillFolderBudget, type SkillFolderFingerprint } from "./skill-folder-hash";

const LOCK_PATH = "skills-lock.json";
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const SKILL_LOCATION = /^\.(?:agents|claude|cursor)\/skills\/([^/]+)\/SKILL\.md$/u;

type SkillLocation = Readonly<{ artifactId: string; relativePath: string; skillKey: string }>;
type OriginObservation = Readonly<{
  origins: readonly SkillOriginEvidence[];
  diagnostics: readonly InventoryDiagnostic[];
}>;

function skillLocations(artifacts: readonly ObservedArtifact[]): SkillLocation[] {
  return artifacts
    .flatMap((artifact) => {
      if (artifact.kind !== "skill") return [];
      return [...artifact.projectionPaths].flatMap((relativePath) => {
        const match = SKILL_LOCATION.exec(relativePath);
        return match?.[1] ? [{ artifactId: artifact.id, relativePath, skillKey: match[1] }] : [];
      });
    })
    .sort(
      (left, right) =>
        left.relativePath.localeCompare(right.relativePath) || left.artifactId.localeCompare(right.artifactId),
    );
}

function diagnostic(path: string, code: InventoryDiagnostic["code"], message: string): InventoryDiagnostic {
  return createInventoryDiagnostic({ location: path, code, severity: "warning", message });
}

function readFailure(error: unknown): Readonly<{ code: InventoryDiagnostic["code"]; message: string }> | undefined {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "not-found") return undefined;
  if (["oversized", "too-deep", "too-many-entries"].includes(code)) {
    return { code: "oversized", message: "The project skills lockfile exceeds the read limit." };
  }
  if (["invalid-path", "unsupported"].includes(code)) {
    return { code: "unsupported", message: "The project skills lockfile cannot be read safely." };
  }
  return { code: "inaccessible", message: "The project skills lockfile could not be read." };
}

function parseLockBytes(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function verificationIssue(location: SkillLocation, result: SkillFolderFingerprint): InventoryDiagnostic | undefined {
  if (result.status === "hashed") return undefined;
  if (result.reason === "budget") {
    return diagnostic(
      location.relativePath,
      "oversized",
      "Skill origin verification exceeded its byte or file budget.",
    );
  }
  if (result.reason === "unsafe-tree") {
    return diagnostic(location.relativePath, "unsupported", "Skill origin verification found an unsafe folder entry.");
  }
  return diagnostic(
    location.relativePath,
    "inaccessible",
    "Skill origin verification could not read the complete folder.",
  );
}

function evidenceFor(
  location: SkillLocation,
  entry: ReturnType<typeof parseSkillsLock>["entries"][number],
  result: SkillFolderFingerprint,
): SkillOriginEvidence {
  const fields = {
    artifactId: location.artifactId,
    relativePath: location.relativePath,
    source: entry.source,
    skillKey: entry.skillKey,
    ...(entry.sourceSkillPath ? { sourceSkillPath: entry.sourceSkillPath } : {}),
    ...(entry.reference ? { reference: entry.reference } : {}),
    lockPath: LOCK_PATH,
    recordedHash: entry.recordedHash,
    ...(result.status === "hashed" ? { copyHash: result.hash } : {}),
    verification:
      result.status === "hashed" ? (result.hash === entry.recordedHash ? "matches-lock" : "modified") : "unverified",
    ...(result.status === "unverified" ? { verificationReason: result.reason } : {}),
  } as const;
  return parseSkillOriginEvidence(fields);
}

export async function observeSkillOrigins(
  filesystem: InventoryFilesystemPort,
  artifacts: readonly ObservedArtifact[],
): Promise<OriginObservation> {
  let lockBytes: Uint8Array;
  try {
    lockBytes = await filesystem.readBytes(LOCK_PATH);
  } catch (error: unknown) {
    const failure = readFailure(error);
    if (!failure) return { origins: [], diagnostics: [] };
    return { origins: [], diagnostics: [diagnostic(LOCK_PATH, failure.code, failure.message)] };
  }

  let parsed: unknown;
  try {
    parsed = parseLockBytes(lockBytes);
  } catch {
    return {
      origins: [],
      diagnostics: [diagnostic(LOCK_PATH, "malformed", "The project skills lockfile is malformed.")],
    };
  }
  const lock = parseSkillsLock(parsed);
  const diagnostics = lock.issues.map((issue) => diagnostic(LOCK_PATH, issue.code, issue.message));
  const entries = new Map(lock.entries.map((entry) => [entry.skillKey, entry]));
  const budget: SkillFolderBudget = { remainingBytes: MAX_SCAN_BYTES };
  const origins: SkillOriginEvidence[] = [];
  for (const location of skillLocations(artifacts)) {
    const entry = entries.get(location.skillKey);
    if (!entry) continue;
    const folder = location.relativePath.slice(0, location.relativePath.lastIndexOf("/"));
    const result = await hashSkillFolder(filesystem, folder, budget);
    origins.push(evidenceFor(location, entry, result));
    const issue = verificationIssue(location, result);
    if (issue) diagnostics.push(issue);
  }
  return { origins, diagnostics };
}
