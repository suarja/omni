import type { SkillEffectStep, SkillFileSummary, SkillResult } from "../../../../shared/skill-management-ipc";
import type { SkillLocationKey } from "../../../../domain/skill-reconciliation/types";
import type {
  SkillPropagationIntent,
  SkillPropagationSummary,
  SkillPropagationTarget,
} from "../../../../shared/skill-propagation-ipc";

export type PropagationOutcome =
  "applied" | "restored" | "retained-local" | "unavailable" | "failed" | "unknown" | "pending" | "no-op" | "unselected";
export type PropagationTone = "success" | "review" | "unknown" | "conflict" | "neutral";
export type PropagationViewLocation = Readonly<{
  key: string;
  target: SkillPropagationTarget;
  group: "safe" | "retained" | "unavailable";
  selectable: boolean;
  selected: boolean;
  files: readonly SkillFileSummary[];
  outcome: PropagationOutcome;
  tone: PropagationTone;
  retryable: boolean;
}>;

export function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function resultFor(target: SkillPropagationTarget, result?: SkillResult): PropagationOutcome {
  const actual = result?.propagation?.targets.find(
    (item) => locationKey(item.location) === locationKey(target.location),
  )?.result;
  if (actual ?? target.result) return (actual ?? target.result)!;
  if (target.state === "current" || target.state === "already-current") return "no-op";
  if (target.state === "retained-local") return "retained-local";
  if (target.state === "unavailable" || target.state === "withheld") return "unavailable";
  return "pending";
}

export function canRetryPropagationTarget(target: SkillPropagationTarget, result?: SkillResult): boolean {
  if (!result || result.recoveryAvailable || result.status === "recovery-required" || result.status === "applying")
    return false;
  const actual = result.propagation?.targets.find(
    (item) => locationKey(item.location) === locationKey(target.location),
  );
  if (!actual) return false;
  return (
    actual.result === "failed" ||
    ((actual.state === "unavailable" || actual.state === "withheld") && actual.result === "unavailable")
  );
}

function toneFor(outcome: PropagationOutcome): PropagationTone {
  if (outcome === "applied" || outcome === "restored") return "success";
  if (outcome === "retained-local") return "review";
  if (outcome === "unknown" || outcome === "unavailable" || outcome === "pending") return "unknown";
  if (outcome === "failed") return "conflict";
  return "neutral";
}

function hasEvidence(target: SkillPropagationTarget, steps: readonly SkillEffectStep[]): boolean {
  return steps.some(
    (step) =>
      step.propagationEvidence && locationKey(step.propagationEvidence.location) === locationKey(target.location),
  );
}

function retainedFileMetadata(target: SkillPropagationTarget): readonly SkillFileSummary[] {
  if (!target.baseRevision || !target.localRevision) return [];
  const baseFiles = new Map(target.baseRevision.files.map((file) => [file.path, file]));
  const localFiles = new Map(target.localRevision.files.map((file) => [file.path, file]));
  const paths = new Set([...baseFiles.keys(), ...localFiles.keys()]);
  return [...paths].flatMap((path): SkillFileSummary[] => {
    const before = baseFiles.get(path);
    const after = localFiles.get(path);
    if (before?.hash === after?.hash) return [];
    return [
      {
        rootId: target.location.projectId,
        relativePath: path,
        change: before ? (after ? "change" : "delete") : "add",
        ...(after ? { byteLength: after.byteLength } : {}),
        ...(before ? { beforeHash: before.hash } : {}),
        ...(after ? { afterHash: after.hash } : {}),
      },
    ];
  });
}

export function buildPropagationView(
  summary: SkillPropagationSummary,
  steps: readonly SkillEffectStep[],
  selectedKeys?: readonly string[],
  result?: SkillResult,
): Readonly<{
  locations: readonly PropagationViewLocation[];
  projectCount: number;
  copyCount: number;
  selectedProjectCount: number;
  selectedCopyCount: number;
  sourceUpdate: boolean;
  canApply: boolean;
}> {
  const supplied = selectedKeys === undefined ? undefined : new Set(selectedKeys);
  const locations = summary.targets.map((target): PropagationViewLocation => {
    const key = locationKey(target.location);
    const evidence = hasEvidence(target, steps);
    const actionable = (target.state === "eligible" || target.state === "already-current") && evidence;
    const group =
      target.state === "retained-local"
        ? "retained"
        : actionable || target.state === "current"
          ? "safe"
          : "unavailable";
    const selectable = group === "safe" && actionable;
    const selected = selectable && (supplied ? supplied.has(key) : true);
    const outcome = resultFor(target, result);
    const step = steps.find(
      (candidate) => candidate.propagationEvidence && locationKey(candidate.propagationEvidence.location) === key,
    );
    const files = group === "retained" ? retainedFileMetadata(target) : actionable ? (step?.files ?? []) : [];
    const retryable = canRetryPropagationTarget(target, result);
    const actual = result?.propagation?.targets.find((item) => locationKey(item.location) === key);
    const displayOutcome =
      !selected && selectable && (outcome === "pending" || (!actual?.result && !target.result))
        ? "unselected"
        : outcome;
    return {
      key,
      target: actual ?? target,
      group,
      selectable,
      selected,
      files,
      outcome: displayOutcome,
      tone: toneFor(displayOutcome),
      retryable,
    };
  });
  const selected = locations.filter(({ selected }) => selected);
  const projects = new Set(summary.targets.map(({ location }) => location.projectId));
  const selectedProjects = new Set(selected.map(({ target }) => target.location.projectId));
  const sourceUpdate = summary.mode === "update-and-maintain";
  return {
    locations,
    projectCount: projects.size,
    copyCount: summary.targets.length,
    selectedProjectCount: selectedProjects.size,
    selectedCopyCount: selected.length,
    sourceUpdate,
    canApply: sourceUpdate || selected.length > 0,
  };
}

export function selectPropagationIntent(
  intent: SkillPropagationIntent,
  locations: readonly SkillLocationKey[],
):
  | SkillPropagationIntent
  | Readonly<{ kind: "write"; request: Extract<SkillPropagationIntent, { kind: "update-and-maintain" }>["request"] }>
  | undefined {
  if (locations.length > 0) return { ...intent, locations };
  if (intent.kind === "update-and-maintain") return { kind: "write", request: intent.request };
  return undefined;
}
