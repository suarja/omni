import { compatibilityMatrix } from "./compatibility";
import type { InventoryArtifactKind } from "./inventory";

export type HarnessId = "claude-code" | "codex" | "cursor";
export type TargetKind = Extract<
  InventoryArtifactKind,
  "skill" | "instruction" | "command" | "agent" | "hook" | "mcp-config"
>;
export type HarnessTarget =
  | Readonly<{
      status: "target";
      relativePath: string;
      unit: "folder" | "file";
    }>
  | Readonly<{
      status: "blocked";
      reason: string;
    }>;

type TargetRequest = Readonly<{ kind: TargetKind; id: string; harnessId: HarnessId }>;

function assertId(id: string): void {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..") || /[\u0000-\u001f\u007f-\u009f]/u.test(id)) {
    throw new Error("Target id is unsafe.");
  }
}

function matrixReason(kind: TargetKind, harnessId: HarnessId): string | undefined {
  const compatibility = compatibilityMatrix[kind][harnessId];
  return compatibility.status === "yes" ? undefined : compatibility.reason;
}

function mappedTarget(
  request: TargetRequest,
): Omit<Extract<HarnessTarget, { status: "target" }>, "status"> | undefined {
  if (request.kind === "skill") {
    const root =
      request.harnessId === "claude-code" ? ".claude" : request.harnessId === "codex" ? ".agents" : ".cursor";
    return { relativePath: `${root}/skills/${request.id}`, unit: "folder" };
  }
  if (request.kind === "instruction") {
    if (request.harnessId === "claude-code") return { relativePath: "CLAUDE.md", unit: "file" };
    if (request.harnessId === "codex") return { relativePath: "AGENTS.md", unit: "file" };
    return undefined;
  }
  if (request.kind === "command" && request.harnessId === "claude-code") {
    return { relativePath: `.claude/commands/${request.id}.md`, unit: "file" };
  }
  if (request.kind === "agent" && request.harnessId === "claude-code") {
    return { relativePath: `.claude/agents/${request.id}.md`, unit: "file" };
  }
  return undefined;
}

export function resolveTarget(request: TargetRequest): HarnessTarget {
  assertId(request.id);
  if (request.kind === "hook" || request.kind === "mcp-config") {
    return { status: "blocked", reason: "provider action (M4)" };
  }
  const reason = matrixReason(request.kind, request.harnessId);
  if (reason) return { status: "blocked", reason };
  if (request.kind === "instruction" && request.harnessId === "cursor") {
    return { status: "blocked", reason: "Instructions are not transposable to Cursor." };
  }
  const target = mappedTarget(request);
  return target
    ? { status: "target", ...target }
    : { status: "blocked", reason: "No deterministic target is available." };
}
