import type { ObservedPackage, InventoryArtifactKind } from "./inventory";

export type CompatibilityHarness = "claude-code" | "codex" | "cursor";
export type CompatibilityStatus = "yes" | "partial" | "no";
export type CompatibilityKind = InventoryArtifactKind | "marketplace";
export type Compatibility = Readonly<{ status: CompatibilityStatus; reason: string }>;
export type CompatibilityMatrix = Readonly<
  Record<CompatibilityKind, Readonly<Record<CompatibilityHarness, Compatibility>>>
>;

const sameSkill = "The same skill folder is discovered by both harnesses.";
const sameInstruction = "The content is portable; only the instruction filename differs.";

export const compatibilityMatrix: CompatibilityMatrix = {
  skill: {
    "claude-code": { status: "yes", reason: sameSkill },
    codex: { status: "yes", reason: sameSkill },
    cursor: { status: "yes", reason: sameSkill },
  },
  instruction: {
    "claude-code": { status: "yes", reason: sameInstruction },
    codex: { status: "yes", reason: sameInstruction },
    cursor: { status: "yes", reason: sameInstruction },
  },
  rule: {
    "claude-code": { status: "yes", reason: "Rule content is portable as an instruction." },
    codex: { status: "yes", reason: "Rule content is portable as an instruction." },
    cursor: { status: "yes", reason: "Rule content is portable as an instruction." },
  },
  command: {
    "claude-code": { status: "yes", reason: "Claude Code discovers command markdown files." },
    codex: { status: "no", reason: "Codex has no command files." },
    cursor: { status: "no", reason: "Cursor has no deterministic command projection." },
  },
  agent: {
    "claude-code": { status: "yes", reason: "Claude Code discovers agent markdown files." },
    codex: { status: "no", reason: "Codex has no agent files." },
    cursor: { status: "no", reason: "Cursor has no deterministic agent projection." },
  },
  hook: {
    "claude-code": { status: "yes", reason: "Claude Code uses hooks.json." },
    codex: { status: "partial", reason: "Codex uses a different hook schema; an adapter is required." },
    cursor: { status: "no", reason: "Cursor has no deterministic hook projection." },
  },
  "mcp-config": {
    "claude-code": { status: "yes", reason: "Claude Code accepts .mcp.json." },
    codex: { status: "yes", reason: "Codex accepts MCP servers through config.toml mapping." },
    cursor: { status: "yes", reason: "Cursor accepts MCP server configuration." },
  },
  "plugin-manifest": {
    "claude-code": { status: "yes", reason: "Claude Code has a deterministic plugin manifest." },
    codex: { status: "yes", reason: "Codex has a deterministic plugin manifest." },
    cursor: { status: "yes", reason: "Cursor has a deterministic plugin manifest." },
  },
  "marketplace-manifest": {
    "claude-code": { status: "yes", reason: "Claude Code marketplace declarations are pure JSON mappings." },
    codex: { status: "yes", reason: "Codex marketplace declarations are pure JSON mappings." },
    cursor: { status: "yes", reason: "Cursor marketplace declarations are pure JSON mappings." },
  },
  unknown: {
    "claude-code": { status: "no", reason: "The artifact kind is not whitelisted for deterministic projection." },
    codex: { status: "no", reason: "The artifact kind is not whitelisted for deterministic projection." },
    cursor: { status: "no", reason: "The artifact kind is not whitelisted for deterministic projection." },
  },
  marketplace: {
    "claude-code": { status: "yes", reason: "Marketplace declarations are pure JSON mappings." },
    codex: { status: "yes", reason: "Marketplace declarations are pure JSON mappings." },
    cursor: { status: "yes", reason: "Marketplace declarations are pure JSON mappings." },
  },
};

function hasManifest(packageInfo: Pick<ObservedPackage, "manifestPaths">, suffix: string): boolean {
  return packageInfo.manifestPaths.some((path) => path === suffix || path.endsWith(`/${suffix}`));
}

export function visibleIn(
  packageInfo: Pick<ObservedPackage, "manifestPaths">,
): readonly ("omni" | "claude-code" | "codex")[] {
  return [
    ...(hasManifest(packageInfo, "omni.plugin.json") ? ["omni" as const] : []),
    ...(hasManifest(packageInfo, ".claude-plugin/plugin.json") ? ["claude-code" as const] : []),
    ...(hasManifest(packageInfo, ".codex-plugin/plugin.json") ? ["codex" as const] : []),
  ];
}
