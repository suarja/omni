import type { SkillLocationKey, SkillRevision, SkillTreeRead } from "../domain/skill-reconciliation/types";
import type { SkillObservationGrant } from "./skill-reconciliation";

export type SkillCopyCaptureRead =
  | Readonly<{ status: "complete"; revision: SkillRevision; files: ReadonlyMap<string, Uint8Array> }>
  | Extract<SkillTreeRead, { status: "unavailable" }>;

export interface SkillCopyComparisonReader {
  readPair(
    grant: SkillObservationGrant,
    a: SkillLocationKey,
    b: SkillLocationKey,
  ): Promise<Readonly<{ a: SkillCopyCaptureRead; b: SkillCopyCaptureRead }>>;
}
