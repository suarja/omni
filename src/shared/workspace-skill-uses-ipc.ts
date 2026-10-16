import { parseManagedSkillUse } from "../domain/skill-reconciliation/validation";
import type { ManagedSkillUse } from "../domain/skill-reconciliation/types";

export const WORKSPACE_SKILL_USES_CHANNEL = "omni:skills:workspace-uses";
export type WorkspaceSkillUsesResponse =
  Readonly<{ status: "ready"; uses: readonly ManagedSkillUse[] }> | Readonly<{ status: "unavailable" }>;
export function parseWorkspaceSkillUsesResponse(value: unknown): WorkspaceSkillUsesResponse {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Workspace skill relationships are invalid. Reopen the workspace.");
  const record = value as Record<string, unknown>;
  if (record.status === "unavailable" && Object.keys(record).length === 1) return { status: "unavailable" };
  if (
    record.status !== "ready" ||
    Object.keys(record).some((key) => key !== "status" && key !== "uses") ||
    !Array.isArray(record.uses) ||
    record.uses.length > 10000
  )
    throw new Error("Workspace skill relationships are invalid. Reopen the workspace.");
  const uses = record.uses.map(parseManagedSkillUse);
  const bindings = new Set<string>();
  const locations = new Set<string>();
  for (const use of uses) {
    const key = JSON.stringify(use.location);
    if (bindings.has(use.bindingId) || locations.has(key))
      throw new Error("Workspace skill relationships overlap. Reopen the workspace.");
    bindings.add(use.bindingId);
    locations.add(key);
  }
  return { status: "ready", uses };
}
