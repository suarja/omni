import { timingSafeEqual } from "node:crypto";
import { lstat, symlink, unlink } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { createAgentTokenManager, type AgentTokenManager } from "./auth";
import { createPlatform, type Platform } from "../platform";

const MAX_FRAME_BYTES = 256 * 1024;
const RATE_LIMIT = 20;
const IDLE_MS = 5 * 60 * 1000;
const IDENTITY_WAIT_MS = 2_000;

export type AgentClient = Readonly<{
  pid?: number;
  name: string;
  version: string;
  harness?: "claude-code" | "codex";
  sessionName?: string;
  cwd?: string;
}>;
export type AgentRouter = Readonly<{
  handle(method: string, params: unknown, client: AgentClient): Promise<unknown>;
}>;
export type AgentGateway = Readonly<{
  socketPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  tokenManager: AgentTokenManager;
}>;
type GatewayOptions = Readonly<{
  userDataPath: string;
  router: AgentRouter;
  tokenManager?: AgentTokenManager;
  platform?: Platform;
  identifyClient?: (client: AgentClient) => Promise<Partial<AgentClient>>;
  onClientIdentified?: (client: AgentClient) => Promise<void> | void;
}>;
type Frame = Readonly<{ id?: unknown; method?: unknown; params?: unknown }>;

// The AF_UNIX path length limit (~104 bytes on darwin) can be shorter than a deeply nested
// user data directory; when that happens the socket is actually bound under `tmpdir()` and
// the platform's canonical path becomes a symlink to it, so every caller — including the
// `omni-mcp` client, which always looks under the user data directory — keeps finding it in
// the same place.
function shortSocketPath(actual: string): string {
  const safe = Buffer.from(actual).toString("base64url").slice(-24);
  return join(tmpdir(), `omni-${safe}.sock`);
}
function frameError(code: string, message: string): Readonly<{ code: string; message: string }> {
  return { code, message };
}
function safeId(value: unknown): string | number | null {
  return typeof value === "string"
    ? validClientText(value, 128)
      ? value
      : null
    : typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : null;
}
function validClientText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f-\u009f\r\n]/u.test(value)
  );
}
function parseFrame(value: string): Frame {
  const frame = JSON.parse(value) as unknown;
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) throw new Error("Frame must be an object.");
  const record = frame as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["id", "method", "params"].includes(key)))
    throw new Error("Frame has an unexpected field.");
  if (record.id !== undefined && safeId(record.id) === null) throw new Error("Frame id is invalid.");
  if (record.method !== undefined && !validClientText(record.method, 80)) throw new Error("Frame method is invalid.");
  return record;
}
async function removePath(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
  });
}
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function createAgentGateway(options: GatewayOptions): AgentGateway {
  const platform = options.platform ?? createPlatform();
  const actual = platform.gateway.endpoint(options.userDataPath);
  const shortened = Buffer.byteLength(actual) > 100 ? shortSocketPath(actual) : actual;
  const tokenManager = options.tokenManager ?? createAgentTokenManager(options.userDataPath);
  const clients = new Set<net.Socket>();
  let server: net.Server | undefined;
  let started = false;

  const write = (socket: net.Socket, id: unknown, result: unknown, error?: { code: string; message: string }): void => {
    if (socket.destroyed) return;
    const response = error ? { id: safeId(id), error } : { id: safeId(id), result };
    socket.write(`${JSON.stringify(response)}\n`);
  };
  const closeConnection = (socket: net.Socket): void => {
    clients.delete(socket);
    socket.destroy();
  };
  const handleConnection = (socket: net.Socket): void => {
    clients.add(socket);
    let buffer = Buffer.alloc(0);
    let authenticated = false;
    let inFlight = false;
    let baseClient: AgentClient | undefined;
    let identityPromise: Promise<AgentClient> | undefined;
    let requests: number[] = [];
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (inFlight) return scheduleIdle();
        closeConnection(socket);
      }, IDLE_MS);
    };
    const touch = scheduleIdle;
    scheduleIdle();
    const dispatch = async (frame: Frame): Promise<void> => {
      const id = frame.id;
      if (inFlight) {
        write(socket, id, undefined, frameError("busy", "Only one request may be in flight per connection."));
        return;
      }
      inFlight = true;
      try {
        if (!authenticated) {
          if (frame.method !== "hello") return closeConnection(socket);
          const params = frame.params;
          if (typeof params !== "object" || params === null || Array.isArray(params)) return closeConnection(socket);
          const hello = params as Record<string, unknown>;
          const client = hello.client;
          if (typeof hello.token !== "string" || typeof client !== "object" || client === null || Array.isArray(client))
            return closeConnection(socket);
          const clientRecord = client as Record<string, unknown>;
          if (
            Object.keys(hello).some((key) => !["token", "client", "pid"].includes(key)) ||
            Object.keys(clientRecord).some((key) => !["name", "version"].includes(key)) ||
            !validClientText(clientRecord.name, 120) ||
            !validClientText(clientRecord.version, 40)
          )
            return closeConnection(socket);
          const expected = Buffer.from(await tokenManager.ensure(), "utf8");
          const received = Buffer.from(hello.token, "utf8");
          if (expected.length !== received.length || !timingSafeEqual(expected, received))
            return closeConnection(socket);
          const base: AgentClient = {
            name: clientRecord.name.slice(0, 120),
            version: clientRecord.version.slice(0, 40),
            ...(typeof hello.pid === "number" && Number.isSafeInteger(hello.pid) && hello.pid > 0
              ? { pid: hello.pid }
              : {}),
          };
          authenticated = true;
          const socketWithClient = socket as net.Socket & { agentClient?: AgentClient };
          baseClient = base;
          socketWithClient.agentClient = base;
          write(socket, id, { status: "ready" });
          const identify = options.identifyClient;
          identityPromise = Promise.resolve()
            .then(() => (identify ? identify(base) : {}))
            .then(async (identified: Partial<AgentClient>) => {
              if (socket.destroyed || !clients.has(socket)) return base;
              const metadata: Partial<AgentClient> = {
                ...(identified.harness === "claude-code" || identified.harness === "codex"
                  ? { harness: identified.harness }
                  : {}),
                ...(validClientText(identified.sessionName, 160) ? { sessionName: identified.sessionName } : {}),
                ...(validClientText(identified.cwd, 4096) ? { cwd: identified.cwd } : {}),
              };
              const current = socketWithClient.agentClient;
              if (!current) return base;
              const finalClient = { ...current, ...metadata };
              socketWithClient.agentClient = finalClient;
              void Promise.resolve(options.onClientIdentified?.(finalClient)).catch(() => undefined);
              return finalClient;
            })
            .catch(() => socketWithClient.agentClient ?? base);
          return;
        }
        const socketWithClient = socket as net.Socket & { agentClient?: AgentClient };
        let client = socketWithClient.agentClient;
        if (identityPromise && baseClient) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<undefined>((resolve) => {
            timeout = setTimeout(() => resolve(undefined), IDENTITY_WAIT_MS);
          });
          client = (await Promise.race([identityPromise, deadline])) ?? baseClient;
          if (timeout) clearTimeout(timeout);
        }
        if (!client || typeof frame.method !== "string") {
          write(socket, id, undefined, frameError("invalid-request", "A method is required."));
          return;
        }
        const now = Date.now();
        requests = requests.filter((timestamp) => now - timestamp < 1000);
        if (requests.length >= RATE_LIMIT) {
          write(socket, id, undefined, frameError("rate-limit", "Too many requests on this connection."));
          return;
        }
        requests.push(now);
        try {
          write(socket, id, await options.router.handle(frame.method, frame.params ?? {}, client));
        } catch (error: unknown) {
          const details = error as { code?: unknown; message?: unknown };
          write(
            socket,
            id,
            undefined,
            frameError(
              typeof details.code === "string" ? details.code : "request-failed",
              typeof details.message === "string" ? details.message : "Agent request failed.",
            ),
          );
        }
      } finally {
        inFlight = false;
        touch();
      }
    };
    socket.on("data", (chunk) => {
      touch();
      buffer = Buffer.concat([buffer, chunk]);
      let newline = buffer.indexOf(10);
      while (newline >= 0) {
        const frameBytes = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (frameBytes.length > MAX_FRAME_BYTES) {
          write(socket, null, undefined, frameError("frame-too-large", "Frame exceeds 256 KB."));
          return closeConnection(socket);
        }
        try {
          void dispatch(parseFrame(frameBytes.toString("utf8"))).catch(() => closeConnection(socket));
        } catch (error: unknown) {
          write(
            socket,
            null,
            undefined,
            frameError("invalid-frame", error instanceof Error ? error.message : "Frame is invalid."),
          );
          return closeConnection(socket);
        }
        newline = buffer.indexOf(10);
      }
      if (buffer.length > MAX_FRAME_BYTES) {
        write(socket, null, undefined, frameError("frame-too-large", "Frame exceeds 256 KB."));
        closeConnection(socket);
      }
    });
    socket.on("close", () => {
      if (idleTimer) clearTimeout(idleTimer);
      clients.delete(socket);
    });
    socket.on("error", () => closeConnection(socket));
  };
  return {
    socketPath: actual,
    tokenManager,
    start: async () => {
      if (started) return;
      started = true;
      try {
        await tokenManager.ensure();
        await removePath(shortened);
        if (shortened !== actual) {
          await removePath(actual);
          await symlink(shortened, actual);
        }
        server = net.createServer(handleConnection);
        await new Promise<void>((resolvePromise, reject) => {
          server!.once("error", reject);
          server!.listen(shortened, () => {
            server!.removeListener("error", reject);
            // Only this user may connect; the token is the second lock.
            void platform.gateway.secure(shortened).then(resolvePromise, reject);
          });
        });
      } catch (error: unknown) {
        started = false;
        server?.close();
        server = undefined;
        await removePath(shortened).catch(() => undefined);
        if (shortened !== actual) await removePath(actual).catch(() => undefined);
        throw error;
      }
    },
    stop: async () => {
      if (!started) return;
      started = false;
      for (const socket of [...clients]) closeConnection(socket);
      await new Promise<void>((resolvePromise) => {
        if (!server) return resolvePromise();
        server.close(() => resolvePromise());
      });
      server = undefined;
      await removePath(shortened);
      if (shortened !== actual && (await pathExists(actual))) await removePath(actual);
    },
  };
}
