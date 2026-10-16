import { resolveObservedPackage } from "../../domain/observed-package-resolution";
import type { SourceSkillRef } from "../../domain/skill-reconciliation/types";
import type { RegistryIpcServices } from "../registry-ipc";
import { observationIssueForLocation, unscopedObservationIssue } from "../skill-reconciliation/location-observation";

type ObservationResponse = Awaited<ReturnType<RegistryIpcServices["observeEntryWithGrant"]>>;
type Inventory = Extract<ObservationResponse, { status: "observed" }>["observation"]["inventory"];
export type SourceObservationBlock = Readonly<{ status: "blocked"; code: string; message: string }>;
export type SourceObservationResult = Readonly<{ status: "ready"; folderPath: string }> | SourceObservationBlock;

export function sourceReferenceRecovery(code: string): "refresh" | "reconnect" {
  return ["package-not-found", "package-ambiguous", "source-skill-unavailable"].includes(code)
    ? "refresh"
    : "reconnect";
}

export function readSourceSkillObservation(
  value: ObservationResponse,
  source: SourceSkillRef,
  findFolder: (inventory: Inventory, source: SourceSkillRef) => string | undefined,
): SourceObservationResult {
  const incomplete: SourceObservationBlock = {
    status: "blocked",
    code: "source-observation-incomplete",
    message: `Source "${source.sourceId}" could not be observed completely.`,
  };
  if (value.status !== "observed") return incomplete;
  const inventory = value.observation.inventory;
  if (unscopedObservationIssue(inventory)) return incomplete;
  const resolution = resolveObservedPackage(inventory.packages ?? [], source.packageId);
  if (resolution.status === "blocked") {
    const possibleRoot = source.packageId.includes("/") ? source.packageId : `packages/${source.packageId}`;
    const possibleFolder = `${possibleRoot}/${source.artifactPath}`;
    if (observationIssueForLocation(inventory, possibleFolder)) return incomplete;
    return { ...resolution, message: `Source "${source.sourceId}": ${resolution.message}` };
  }
  const relativeRoot = resolution.package.relativeRoot;
  const expectedFolder = relativeRoot === "root" ? source.artifactPath : `${relativeRoot}/${source.artifactPath}`;
  if (observationIssueForLocation(inventory, expectedFolder)) return incomplete;
  const folderPath = findFolder(inventory, { ...source, packageId: resolution.package.id });
  return folderPath
    ? { status: "ready", folderPath }
    : {
        status: "blocked",
        code: "source-skill-unavailable",
        message: `Skill "${source.artifactPath}" in source "${source.sourceId}", package "${resolution.package.id}" is missing, unsafe or ambiguous. Refresh the source and choose an observed skill folder.`,
      };
}
