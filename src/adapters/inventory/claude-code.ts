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

const CLAUDE_CODE_LOCATIONS = [
  treeLocation(".claude/skills", "skill"),
  treeLocation(".claude/agents", "agent"),
  treeLocation(".claude/commands", "command"),
  treeLocation(".claude/hooks", "hook"),
  manifestTreeLocation(".claude-plugin"),
  fileLocation("CLAUDE.md", "instruction"),
] as const;

export function detectClaudeCode(
  filesystem: InventoryFilesystemPort,
  scope: InventoryObservationScope = "project",
): Promise<InventoryDetectorResult> {
  return scanInventoryLocations("claude-code", filesystem, CLAUDE_CODE_LOCATIONS, scope);
}

export const claudeCodeInventoryDetector: InventoryDetector = {
  providerId: "claude-code",
  detect: detectClaudeCode,
};
