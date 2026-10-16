import type { ObservedArtifact } from "../inventory";
import type { SkillOriginEvidence } from "./types";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const HASH = /^[0-9a-f]{64}$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const EVIDENCE_KEYS = new Set([
  "artifactId",
  "relativePath",
  "source",
  "skillKey",
  "sourceSkillPath",
  "reference",
  "lockPath",
  "recordedHash",
  "copyHash",
  "verification",
  "verificationReason",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown, label: string, maximum = 240): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const text = value.trim();
  if (!text || text.length > maximum || CONTROL_CHARACTERS.test(text)) {
    throw new Error(`${label} is not safe.`);
  }
  return text;
}

function readSafePath(value: unknown, label: string): string {
  const text = readText(value, label).replaceAll("\\", "/");
  const segments = text.split("/");
  if (
    text.startsWith("/") ||
    /^[A-Za-z]:\//u.test(text) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return text;
}

function readSafeIdentifier(value: unknown): string {
  const text = readText(value, "Skill artifact id");
  if (text.includes("/") || text.includes("\\") || text === "." || text === "..") {
    throw new Error("Skill artifact id must be an opaque identifier.");
  }
  return text;
}

function readGithubLocator(value: unknown): string {
  const locator = readText(value, "Skill origin locator", 201);
  const segments = locator.split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment === "." || segment === "..")
  ) {
    throw new Error("Skill origin locator must be a safe GitHub owner/repository.");
  }
  return segments.map((segment) => segment.toLocaleLowerCase("en-US")).join("/");
}

function parseSource(value: unknown): SkillOriginEvidence["source"] {
  if (!isRecord(value)) throw new Error("Skill origin source must be a record.");
  for (const key of Object.keys(value)) {
    if (key !== "kind" && key !== "locator") throw new Error("Skill origin source has an unexpected field.");
  }
  if (value.kind !== "github") throw new Error("Skill origin source type is unsupported.");
  return { kind: "github", locator: readGithubLocator(value.locator) };
}

export function parseSkillOriginEvidence(value: unknown): SkillOriginEvidence {
  if (!isRecord(value)) throw new Error("Skill origin evidence must be a record.");
  for (const key of Object.keys(value)) {
    if (!EVIDENCE_KEYS.has(key)) throw new Error("Skill origin evidence has an unexpected field.");
  }

  const verification = value.verification;
  if (verification !== "matches-lock" && verification !== "modified" && verification !== "unverified") {
    throw new Error("Skill origin verification state is unsupported.");
  }
  const reason = value.verificationReason;
  if (verification === "unverified") {
    if (reason !== "budget" && reason !== "unsafe-tree" && reason !== "unavailable") {
      throw new Error("Unverified skill origins require a reason.");
    }
  } else if (reason !== undefined) {
    throw new Error("Verified skill origins cannot have an unverified reason.");
  }
  if (value.lockPath !== "skills-lock.json") throw new Error("Skill origin lock path is unsupported.");
  const hash = readText(value.recordedHash, "Recorded skill hash", 64);
  if (!HASH.test(hash)) throw new Error("Recorded skill hash must be SHA-256.");
  const copyHash = value.copyHash === undefined ? undefined : readText(value.copyHash, "Observed skill hash", 64);
  if (copyHash && (!HASH.test(copyHash) || verification === "unverified"))
    throw new Error("Observed skill hash requires a verified SHA-256 folder fingerprint.");
  if (copyHash && (copyHash.toLowerCase() === hash.toLowerCase()) !== (verification === "matches-lock"))
    throw new Error("Observed skill hash must agree with the lock verification state.");

  const sourceSkillPath =
    value.sourceSkillPath === undefined ? undefined : readSafePath(value.sourceSkillPath, "Upstream skill path");
  const skillKey = value.skillKey === undefined ? undefined : readText(value.skillKey, "Skill key", 100);
  if (skillKey && !SAFE_SEGMENT.test(skillKey) && skillKey !== "__proto__") {
    throw new Error("Skill key is not safe.");
  }
  const reference = value.reference === undefined ? undefined : readText(value.reference, "Skill reference");
  if (reference && (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(reference) || reference.includes("@"))) {
    throw new Error("Skill reference must not contain a URL or credentials.");
  }

  return {
    artifactId: readSafeIdentifier(value.artifactId),
    relativePath: readSafePath(value.relativePath, "Skill location"),
    source: parseSource(value.source),
    ...(skillKey ? { skillKey } : {}),
    ...(sourceSkillPath ? { sourceSkillPath } : {}),
    ...(reference ? { reference } : {}),
    lockPath: "skills-lock.json",
    recordedHash: hash.toLocaleLowerCase("en-US"),
    ...(copyHash ? { copyHash: copyHash.toLocaleLowerCase("en-US") } : {}),
    verification,
    ...(reason ? { verificationReason: reason } : {}),
  };
}

export function validateSkillOriginLocations(
  origins: readonly SkillOriginEvidence[],
  artifacts: readonly Pick<ObservedArtifact, "id" | "kind" | "projectionPaths">[],
): void {
  const seen = new Set<string>();
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  for (const origin of origins) {
    const key = JSON.stringify([origin.artifactId, origin.relativePath]);
    if (seen.has(key)) throw new Error("Skill origin locations must be unique.");
    seen.add(key);

    const artifact = artifactById.get(origin.artifactId);
    if (!artifact || artifact.kind !== "skill" || !artifact.projectionPaths.includes(origin.relativePath)) {
      throw new Error("Skill origin evidence must point to an observed skill location.");
    }
  }
}
