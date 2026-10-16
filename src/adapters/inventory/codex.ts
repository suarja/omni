import type { InventoryFilesystemPort } from "../../ports/inventory";
import type { InventoryObservationScope } from "../../domain/inventory";
import {
  fileLocation,
  manifestTreeLocation,
  scanInventoryLocations,
  treeLocation,
  type InventoryDetector,
  type InventoryDetectorResult,
} from "./shared";

const CODEX_LOCATIONS = [
  treeLocation(".agents/skills", "skill"),
  fileLocation("AGENTS.md", "instruction"),
  manifestTreeLocation(".codex-plugin"),
] as const;

export function detectCodex(
  filesystem: InventoryFilesystemPort,
  scope: InventoryObservationScope = "project",
): Promise<InventoryDetectorResult> {
  return scanInventoryLocations("codex", filesystem, CODEX_LOCATIONS, scope);
}

export const codexInventoryDetector: InventoryDetector = {
  providerId: "codex",
  detect: detectCodex,
};
