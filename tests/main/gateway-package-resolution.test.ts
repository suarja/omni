import { describe, expect, it } from "vitest";
import { resolveGatewayRequest } from "../../src/main/agent-gateway/package-resolution";
import type { RegistryIpcServices } from "../../src/main/registry-ipc";
import { observedPackages } from "./agent-gateway-helpers";

const observed = observedPackages("packages/tools");
if (observed.status !== "observed") throw new Error("Invalid fixture.");
const registry = {
  observeRegisteredEntry: async () => ({
    ...observed,
    observation: {
      ...observed.observation,
      inventory: {
        ...observed.observation.inventory,
        diagnostics: [{ location: ".", code: "inaccessible", severity: "error", message: "Unreadable sibling." }],
      },
    },
  }),
} as unknown as RegistryIpcServices;

function request(packageId: string) {
  return {
    kind: "write-skill" as const,
    sourceId: "personal",
    packageId,
    mode: "create" as const,
    folderName: "demo",
    files: [{ path: "SKILL.md", content: "# Demo" }],
  };
}

describe("gateway resolution with root diagnostics", () => {
  it("allows an exact observed id despite an unrelated root diagnostic", async () => {
    expect(await resolveGatewayRequest(registry, request("packages/tools"))).toMatchObject({
      status: "resolved",
      request: { packageId: "packages/tools" },
    });
  });
  it("blocks a short name when incomplete observation may hide another match", async () => {
    expect(await resolveGatewayRequest(registry, request("tools"))).toMatchObject({
      status: "blocked",
      details: [{ code: "source-observation-incomplete", recoveryAction: "reconnect" }],
    });
  });
});
