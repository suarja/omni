import type { AgentRequest, AgentWriteRequest } from "../../src/shared/agents-ipc";

const write: Extract<AgentWriteRequest, { kind: "write-skill" }> = {
  kind: "write-skill",
  sourceId: "source-one",
  packageId: "pstack",
  mode: "create",
  folderName: "review",
  files: [{ path: "SKILL.md", content: "# Review" }],
};
const source = { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" };
const requests = [
  { kind: "make-compatible", sourceId: "source-one", harness: "codex" },
  {
    kind: "assign",
    sourceId: "source-one",
    packageId: "pstack",
    artifactPath: "skills/review",
    projectIds: ["project-one"],
  },
  write,
  { kind: "import-artifact", projectId: "project-one", relativePath: "skills/review", target: { packageId: "pstack" } },
  { kind: "remove-skill", bindingIds: ["binding"] },
  { kind: "restore-skill", operationId: "receipt" },
  { kind: "maintain-current", source },
  { kind: "update-and-maintain", source, request: write },
] satisfies AgentWriteRequest[];

export const agentRequests: readonly AgentRequest[] = requests.map((request) => ({
  requestId: request.kind,
  createdAt: "2026-10-11T18:00:00Z",
  expiresAt: "2026-10-11T18:10:00Z",
  approval: "omni",
  status: "pending",
  request,
  plan: { kind: "assign", plans: [] },
  ...(request.kind === "remove-skill"
    ? { intentId: "remove-intent", skillIntent: { kind: "remove" as const, bindingIds: request.bindingIds } }
    : {}),
  ...(request.kind === "restore-skill"
    ? { intentId: "restore-intent", skillIntent: { kind: "restore" as const, operationId: request.operationId } }
    : {}),
  ...(request.kind === "maintain-current" || request.kind === "update-and-maintain"
    ? { intentId: "propagate-intent", skillIntent: request }
    : {}),
}));
