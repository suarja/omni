import { parseSkillDeclaration, parseSkillLocationKey, parseSkillRevision, parseSourceSkillRef } from "./validation";
import type { SkillDeclaration, SkillLocationKey, SkillRevision, SourceSkillRef } from "./types";

export type SkillVariantOrigin = Readonly<{
  schemaVersion: 1;
  variantId: string;
  forkOf: string;
  capturedAt: string;
  capturedFrom: Readonly<{ location: SkillLocationKey; revision: SkillRevision }>;
  declaredOrigin?: SkillDeclaration;
  approvedSource?: SourceSkillRef;
  license?: string;
}>;

type RecordValue = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function assertKeys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${label} must be a UUID.`);
  return value.toLowerCase();
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || new Date(value).toISOString() !== value) {
    throw new Error("Variant capture time must be an ISO-8601 timestamp.");
  }
  return value;
}

export function parseSkillVariantOrigin(value: unknown): SkillVariantOrigin {
  const input = record(value, "Skill variant origin");
  assertKeys(
    input,
    [
      "schemaVersion",
      "variantId",
      "forkOf",
      "capturedAt",
      "capturedFrom",
      "declaredOrigin",
      "approvedSource",
      "license",
    ],
    "Skill variant origin",
  );
  if (input.schemaVersion !== 1) throw new Error("Skill variant origin schema is unsupported.");
  const capturedFrom = record(input.capturedFrom, "Skill variant capture source");
  assertKeys(capturedFrom, ["location", "revision"], "Skill variant capture source");
  const license = input.license;
  if (
    license !== undefined &&
    (typeof license !== "string" ||
      !license.trim() ||
      license.length > 128 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(license))
  ) {
    throw new Error("Skill variant license is invalid.");
  }
  return {
    schemaVersion: 1,
    variantId: uuid(input.variantId, "Variant id"),
    forkOf: uuid(input.forkOf, "Fork source id"),
    capturedAt: timestamp(input.capturedAt),
    capturedFrom: {
      location: parseSkillLocationKey(capturedFrom.location),
      revision: parseSkillRevision(capturedFrom.revision),
    },
    ...(input.declaredOrigin === undefined ? {} : { declaredOrigin: parseSkillDeclaration(input.declaredOrigin) }),
    ...(input.approvedSource === undefined ? {} : { approvedSource: parseSourceSkillRef(input.approvedSource) }),
    ...(license === undefined ? {} : { license: license.trim() }),
  };
}
