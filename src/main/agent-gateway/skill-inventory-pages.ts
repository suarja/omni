import { randomUUID } from "node:crypto";
import type { AgentSkillInventoryResponse, SkillInventorySnapshot } from "../../shared/skill-inventory";
import { readSkillInventoryPage } from "../../domain/skill-inventory-limits";
import { fail, id, keys, object, optionalBoolean, text } from "./router-inputs";

type Selection = Readonly<{ projectIds?: readonly string[]; includeMarketplace?: boolean }>;
type Cached = Readonly<{
  snapshot: SkillInventorySnapshot;
  selection: Selection;
  expiresAt: number;
  offsets: Set<number>;
}>;
const LIFETIME_MS = 5 * 60 * 1000;
const MAX_SNAPSHOTS = 8;
function selectionFor(request: Record<string, unknown>): Selection {
  let projectIds: string[] | undefined;
  if (request.projectIds !== undefined) {
    if (!Array.isArray(request.projectIds) || request.projectIds.length > 64)
      throw fail("Inventory projectIds must be an array of at most 64 project ids.");
    projectIds = [...new Set(request.projectIds.map((value) => id(value, "Project id")))].sort();
  }
  const includeMarketplace = optionalBoolean(request.includeMarketplace, "includeMarketplace");
  return { ...(projectIds ? { projectIds } : {}), ...(includeMarketplace === undefined ? {} : { includeMarketplace }) };
}
function validateCursorSelection(selection: Selection, cached: Selection): void {
  if (
    (selection.projectIds !== undefined &&
      JSON.stringify(selection.projectIds) !== JSON.stringify(cached.projectIds)) ||
    (selection.includeMarketplace !== undefined && selection.includeMarketplace !== (cached.includeMarketplace ?? true))
  )
    throw fail("Inventory cursor belongs to a different scope; reuse its original selection or restart the inventory.");
}
export function createSkillInventoryPages(
  readSnapshot: (params: Selection) => Promise<SkillInventorySnapshot>,
  now: () => number = Date.now,
): (params: unknown) => Promise<AgentSkillInventoryResponse> {
  const snapshots = new Map<string, Cached>();
  const page = (key: string, cached: Cached, offset: number): AgentSkillInventoryResponse => {
    const result = readSkillInventoryPage(cached.snapshot, offset, (next) => `${key}:${next}`);
    if (result.nextCursor) cached.offsets.add(Number(result.nextCursor.split(":")[1]));
    return result;
  };
  return async (params) => {
    const request = object(params, "skill_inventory parameters");
    keys(request, ["projectIds", "includeMarketplace", "cursor"], "skill_inventory parameters");
    const selection = selectionFor(request);
    for (const [key, cached] of snapshots) if (cached.expiresAt <= now()) snapshots.delete(key);
    if (request.cursor !== undefined) {
      const cursor = text(request.cursor, "Inventory cursor", 128);
      const match = /^([0-9a-f-]{36}):([0-9]+)$/u.exec(cursor);
      const cached = match ? snapshots.get(match[1]!) : undefined;
      const offset = Number(match?.[2]);
      if (!cached || !cached.offsets.has(offset))
        throw fail("Inventory cursor is invalid or expired; restart the inventory.");
      validateCursorSelection(selection, cached.selection);
      return page(match![1]!, cached, offset);
    }
    const snapshot = await readSnapshot(selection);
    const key = randomUUID();
    const cached: Cached = { snapshot, selection, expiresAt: now() + LIFETIME_MS, offsets: new Set() };
    const result = page(key, cached, 0);
    if (result.nextCursor) {
      while (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
      snapshots.set(key, cached);
    }
    return result;
  };
}
