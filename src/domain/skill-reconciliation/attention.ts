import { revisionsEqual } from "./revisions";
import type { SkillCopyLocationRead } from "./types";

export type SkillAttentionReason = "copy-difference" | "local-change" | "unavailable";
export type SkillAttentionState = "quiet" | SkillAttentionReason;
export type SkillAttentionSummary = Readonly<{
  state: SkillAttentionState;
  reasons: readonly SkillAttentionReason[];
}>;

const REASON_ORDER: readonly SkillAttentionReason[] = ["copy-difference", "local-change", "unavailable"];

export function deriveManagedSkillAttention(
  state: "matches-base" | "local-change" | "unavailable" | undefined,
): SkillAttentionSummary {
  if (state === "local-change") return { state, reasons: [state] };
  if (state === "unavailable") return { state, reasons: [state] };
  return { state: "quiet", reasons: [] };
}

export function deriveSkillAttention(locations: readonly SkillCopyLocationRead[]): SkillAttentionSummary {
  if (locations.length === 0 || locations.some(({ read }) => read.status !== "complete")) {
    return { state: "unavailable", reasons: ["unavailable"] };
  }
  if (locations.length < 2) return { state: "quiet", reasons: [] };
  const first = locations[0]!.read;
  if (first.status !== "complete") return { state: "unavailable", reasons: ["unavailable"] };
  const differs = locations.some(
    ({ read }) => read.status !== "complete" || !revisionsEqual(first.revision, read.revision),
  );
  return differs ? { state: "copy-difference", reasons: ["copy-difference"] } : { state: "quiet", reasons: [] };
}

export function aggregateSkillAttention(children: readonly SkillAttentionSummary[]): SkillAttentionSummary {
  const reasons = new Set(children.flatMap((child) => child.reasons));
  const orderedReasons = REASON_ORDER.filter((reason) => reasons.has(reason));
  const state = orderedReasons[0] ?? "quiet";
  return { state, reasons: orderedReasons };
}
