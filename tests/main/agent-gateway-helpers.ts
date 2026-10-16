import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import net from "node:net";

export async function createAgentTestRoot(roots: string[]): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "omni-agent-gateway-"));
  roots.push(path);
  return path;
}

export function connect(path: string): Promise<net.Socket> {
  const socket = net.createConnection(path);
  return once(socket, "connect").then(() => socket);
}

export async function response(socket: net.Socket): Promise<Record<string, unknown>> {
  const [chunk] = (await once(socket, "data")) as [Buffer];
  return JSON.parse(chunk.toString("utf8").split("\n", 1)[0] ?? "{}") as Record<string, unknown>;
}

export function hello(socket: net.Socket, token: string): Promise<Record<string, unknown>> {
  socket.write(
    `${JSON.stringify({ id: "hello", method: "hello", params: { token, client: { name: "test", version: "1" } } })}\n`,
  );
  return response(socket);
}

export function observedPackages(...ids: string[]): import("../../src/shared/registry-ipc").ObservationResponse {
  return {
    status: "observed",
    observation: {
      subject: { kind: "source", id: "personal" },
      observedAt: "2026-10-14T00:00:00Z",
      inventory: {
        rootHandle: "fixture-root",
        displayRoot: "fixture",
        observedAt: "2026-10-14T00:00:00Z",
        harnesses: [],
        artifacts: [],
        diagnostics: [],
        gitScopes: [],
        packages: ids.map((id) => ({
          id,
          relativeRoot: id,
          displayName: id.split("/").at(-1)!,
          format: "omni",
          manifestPaths: [],
          artifactIds: [],
        })),
      },
    },
  };
}
