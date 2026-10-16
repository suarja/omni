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

const CURSOR_LOCATIONS = [
  treeLocation(".cursor/skills", "skill"),
  treeLocation(".cursor/rules", "rule"),
  fileLocation(".cursor/mcp.json", "mcp-config", "json"),
  fileLocation(".cursor/mcp.jsonc", "mcp-config"),
  manifestTreeLocation(".cursor-plugin"),
] as const;

export function detectCursor(
  filesystem: InventoryFilesystemPort,
  scope: InventoryObservationScope = "project",
): Promise<InventoryDetectorResult> {
  return scanInventoryLocations("cursor", filesystem, CURSOR_LOCATIONS, scope);
}

export const cursorInventoryDetector: InventoryDetector = {
  providerId: "cursor",
  detect: detectCursor,
};
