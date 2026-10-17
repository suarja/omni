import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGatewayClient, defaultUserDataPath } from "../../packages/omni-mcp/src/gateway-client";
import { createAgentGateway, type AgentRouter } from "../../src/main/agent-gateway/server";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";

const roots: string[] = [];
const gateways: Array<{ stop(): Promise<void> }> = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join("/private/tmp", "omni-mcp-client-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function startedGateway(userDataPath: string, router: AgentRouter, token = "a".repeat(64)) {
  await mkdir(join(userDataPath, "omni"), { recursive: true });
  const gateway = createAgentGateway({
    userDataPath,
    router,
    tokenManager: {
      ensure: async () => token,
      rotate: async () => token,
      tokenCreatedAt: async () => new Date(0).toISOString(),
    },
  });
  gateways.push(gateway);
  await gateway.start();
  return gateway;
}

describe("Omni gateway client", () => {
  it("uses the platform-specific user-data default", () => {
    const original = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      expect(defaultUserDataPath()).toMatch(/AppData[\\/]Roaming[\\/]Omni$/u);
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(defaultUserDataPath()).toMatch(/[\\/]\.config[\\/]Omni$/u);
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      expect(defaultUserDataPath()).toMatch(/Library[\\/]Application Support[\\/]Omni$/u);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  it("queues requests and returns authenticated gateway results", async () => {
    const userDataPath = await root();
    const requestFile = join(userDataPath, "omni", "agent-requests.json");
    const requests = createAgentRequestsStore(requestFile);
    const calls: string[] = [];
    const gateway = await startedGateway(userDataPath, {
      handle: async (method) => {
        calls.push(method);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { method };
      },
    });
    await writeFile(join(userDataPath, "omni", "agent-token"), `${"a".repeat(64)}\n`);
    const client = createGatewayClient({ userDataPath, version: "test" });

    await expect(Promise.all([client.request("status", {}), client.request("list_marketplace", {})])).resolves.toEqual([
      { ok: true, result: { method: "status" } },
      { ok: true, result: { method: "list_marketplace" } },
    ]);
    expect(calls).toEqual(["status", "list_marketplace"]);
    expect(await requests.list()).toEqual([]);
    await client.close();
  });

  it("connects through the short socket target of a profile path longer than sun_path", async () => {
    const userDataPath = join(await root(), "long-profile-".repeat(12));
    expect(userDataPath.length).toBeGreaterThan(104);
    await startedGateway(userDataPath, { handle: async (method) => ({ method }) });
    await writeFile(join(userDataPath, "omni", "agent-token"), `${"a".repeat(64)}\n`);
    const client = createGatewayClient({ userDataPath, version: "test" });
    try {
      await expect(client.request("status", {})).resolves.toEqual({ ok: true, result: { method: "status" } });
    } finally {
      await client.close();
    }
  });

  it("returns app-not-running when the socket is absent", async () => {
    const client = createGatewayClient({ userDataPath: await root(), version: "test" });

    await expect(client.request("status", {})).resolves.toEqual({
      ok: false,
      unavailable: { status: "app-not-running", message: "Open Omni to use the Omni tools." },
    });
    await client.close();
  });

  it("returns a distinct app-not-running message when hello is rejected", async () => {
    const userDataPath = await root();
    await mkdir(join(userDataPath, "omni"), { recursive: true });
    await writeFile(join(userDataPath, "omni", "agent-token"), `${"b".repeat(64)}\n`);
    await startedGateway(userDataPath, { handle: async () => ({ ok: true }) });
    const client = createGatewayClient({ userDataPath, version: "test" });

    const result = await client.request("status", {});
    expect(result.ok).toBe(false);
    if (!result.ok && "unavailable" in result) {
      expect(result.unavailable.status).toBe("app-not-running");
      expect(result.unavailable.message).not.toBe("Open Omni to use the Omni tools.");
    }
    await client.close();
  });
});
