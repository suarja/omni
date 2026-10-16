import type {
  SkillLocationKey,
  SkillRevision,
  SkillUseEffect,
  SourceSkillRef,
} from "../domain/skill-reconciliation/types";
import { parseSkillUseEffect } from "./skill-adoption-effects";
import {
  parseSkillLocationKey,
  parseSkillRevision,
  parseSourceSkillRef,
} from "../domain/skill-reconciliation/validation";
import type { SkillAdoptionBaseReference } from "./skill-adoption-effects";
import { parseSkillAdoptionBaseReference } from "./skill-adoption-effects";

export type SkillPropagationStepEvidence = Readonly<{
  intentId: string;
  skillId: string;
  source: SourceSkillRef;
  location: SkillLocationKey;
  relationshipRevision: number;
  sourceRootIdentity: string;
  projectRootIdentity: string;
  sourceRevision: SkillRevision;
  localRevision: SkillRevision;
  baseRevision: SkillRevision;
  previousBaseRevisionId: string;
  nextBaseRevisionId: string;
}>;

export type SkillPropagationStepMetadata = Readonly<{
  metadataEffects: readonly SkillUseEffect[];
  baseReferences: readonly SkillAdoptionBaseReference[];
  propagationEvidence: SkillPropagationStepEvidence;
}>;

type RecordValue = Record<string, unknown>;
function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}
function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}
function id(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    /[\\/\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new Error(`${label} is invalid.`);
  return value.trim();
}
function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}
function sameLocation(left: SkillLocationKey, right: SkillLocationKey): boolean {
  return (
    left.projectId === right.projectId && left.harnessId === right.harnessId && left.folderPath === right.folderPath
  );
}

export function parseSkillPropagationStepMetadata(value: unknown): SkillPropagationStepMetadata | undefined {
  const step = record(value, "Skill propagation step");
  if (step.propagationEvidence === undefined) return undefined;
  if (
    !Array.isArray(step.metadataEffects) ||
    step.metadataEffects.length !== 1 ||
    !Array.isArray(step.baseReferences) ||
    step.baseReferences.length !== 1
  )
    throw new Error("Propagation steps require one exact use and base effect.");
  const evidenceValue = record(step.propagationEvidence, "Propagation evidence");
  keys(
    evidenceValue,
    [
      "intentId",
      "skillId",
      "source",
      "location",
      "relationshipRevision",
      "sourceRootIdentity",
      "projectRootIdentity",
      "sourceRevision",
      "localRevision",
      "baseRevision",
      "previousBaseRevisionId",
      "nextBaseRevisionId",
    ],
    "Propagation evidence",
  );
  const evidence: SkillPropagationStepEvidence = {
    intentId: id(evidenceValue.intentId, "Intent id"),
    skillId: id(evidenceValue.skillId, "Skill id"),
    source: parseSourceSkillRef(evidenceValue.source),
    location: parseSkillLocationKey(evidenceValue.location),
    relationshipRevision:
      Number.isSafeInteger(evidenceValue.relationshipRevision) && Number(evidenceValue.relationshipRevision) >= 0
        ? Number(evidenceValue.relationshipRevision)
        : (() => {
            throw new Error("Relationship revision is invalid.");
          })(),
    sourceRootIdentity: hash(evidenceValue.sourceRootIdentity, "Source root identity"),
    projectRootIdentity: hash(evidenceValue.projectRootIdentity, "Project root identity"),
    sourceRevision: parseSkillRevision(evidenceValue.sourceRevision),
    localRevision: parseSkillRevision(evidenceValue.localRevision),
    baseRevision: parseSkillRevision(evidenceValue.baseRevision),
    previousBaseRevisionId: id(evidenceValue.previousBaseRevisionId, "Previous base id"),
    nextBaseRevisionId: id(evidenceValue.nextBaseRevisionId, "Next base id"),
  };
  const metadataEffects = step.metadataEffects.map(parseSkillUseEffect);
  const baseReferences = step.baseReferences.map(parseSkillAdoptionBaseReference);
  const effect = metadataEffects[0]!;
  if (
    metadataEffects.length !== 1 ||
    baseReferences.length !== 1 ||
    !effect.before ||
    !effect.after ||
    effect.skillId !== evidence.skillId ||
    !sameLocation(effect.location, evidence.location) ||
    effect.before.baseRevisionId !== evidence.previousBaseRevisionId ||
    effect.after.baseRevisionId !== evidence.nextBaseRevisionId ||
    baseReferences[0]!.baseRevisionId !== evidence.nextBaseRevisionId ||
    baseReferences[0]!.revision.hash !== evidence.sourceRevision.hash ||
    effect.before.source.sourceId !== evidence.source.sourceId ||
    effect.after.source.sourceId !== evidence.source.sourceId
  )
    throw new Error("Propagation evidence does not match its exact effects.");
  return { metadataEffects, baseReferences, propagationEvidence: evidence };
}
