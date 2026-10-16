import type { InventoryFilesystemPort } from "../../ports/inventory";
import type { InventoryObservationScope } from "../../domain/inventory";
import {
  fileLocation,
  scanInventoryLocations,
  treeLocation,
  type InventoryDetector,
  type InventoryDetectorResult,
} from "./shared";

const OPENCODE_LOCATIONS = [
  treeLocation(".opencode/skills", "skill"),
  treeLocation(".opencode/plugins", "plugin-manifest"),
  fileLocation("opencode.json", "mcp-config", "json"),
] as const;

export function detectOpenCode(
  filesystem: InventoryFilesystemPort,
  scope: InventoryObservationScope = "project",
): Promise<InventoryDetectorResult> {
  return scanInventoryLocations("opencode", filesystem, OPENCODE_LOCATIONS, scope);
}

export const openCodeInventoryDetector: InventoryDetector = {
  providerId: "opencode",
  detect: detectOpenCode,
};
