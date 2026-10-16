import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import net from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createGatewayClient } from "../../packages/omni-mcp/src/gateway-client";
import { createDesktopWake, withDesktopWake } from "../../packages/omni-mcp/src/desktop-wake";
import { probeDesktopSocket } from "../../packages/omni-mcp/src/desktop-wake-adapter";
const roots: string[] = [];
const clients: ReturnType<typeof createGatewayClient>[] = [];
const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  sockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp("/private/tmp/omni-f2-socket-");
  roots.push(root);
  const omni = join(root, "omni");
  await mkdir(omni);
  const socketPath = join(omni, "agent.sock");
  const client = createGatewayClient({ userDataPath: root, version: "test" });
  clients.push(client);
  const start = async (): Promise<void> => {
    await writeFile(join(omni, "agent-token"), "fixture-token");
    const server = net.createServer((socket) => {
      sockets.push(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const request = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          socket.write(JSON.stringify({ id: request.id, result: { status: "ready", method: request.method } }) + "\n");
          newline = buffer.indexOf("\n");
        }
      });
    });
    servers.push(server);
    server.listen(socketPath);
    await once(server, "listening");
  };
  return { root, socketPath, client, start };
}
it("reconnects an authenticated socket call after one fake background launch", async () => {
  const f = await fixture();
  const launch = vi.fn(f.start);
  const waking = withDesktopWake(
    f.client,
    createDesktopWake({
      profileOverridden: false,
      platform: "darwin",
      findInstalledApp: async () => "/Applications/Omni Desktop.app",
      launch,
      probe: (signal) => probeDesktopSocket(f.socketPath, signal),
    }),
  );
  const result = await waking.request("status", {});
  expect(result).toEqual({ ok: true, result: { status: "ready", method: "status" } });
  expect(launch).toHaveBeenCalledOnce();
});
it("keeps a custom-profile runtime unavailable without waking the installed app", async () => {
  const f = await fixture();
  const launch = vi.fn(f.start);
  const waking = withDesktopWake(
    f.client,
    createDesktopWake({
      profileOverridden: true,
      platform: "darwin",
      findInstalledApp: async () => "/Applications/Omni Desktop.app",
      launch,
      probe: (signal) => probeDesktopSocket(f.socketPath, signal),
    }),
  );
  expect(await waking.request("status", {})).toMatchObject({ ok: false, unavailable: { status: "app-not-running" } });
  expect(launch).not.toHaveBeenCalled();
  await f.start();
  expect(await waking.request("status", {})).toEqual({ ok: true, result: { status: "ready", method: "status" } });
});
