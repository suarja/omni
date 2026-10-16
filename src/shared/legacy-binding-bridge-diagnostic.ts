import type { SkillLocationKey } from "../domain/skill-reconciliation/types";

export type LegacyBridgeIssue = Readonly<{ code: string; message: string }>;
export type LegacyBridgeSkippedLocation = LegacyBridgeIssue &
  Readonly<{
    location?: SkillLocationKey;
    bindingIds: readonly string[];
  }>;

/** Last bridge scan only; reading this diagnostic never retries or modifies assignments. */
export type LegacyBindingBridgeDiagnostic = Readonly<{
  completedAt: string;
  linkedCopies: number;
  alreadyManagedLocations: number;
  duplicateBindings: number;
  skippedLocations: readonly LegacyBridgeSkippedLocation[];
  issues: readonly LegacyBridgeIssue[];
}>;
