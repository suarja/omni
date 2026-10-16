import { RUNTIME_VERSION } from "./version.js";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";

export type AppUnavailable = Readonly<{
  status: "app-not-running";
  message: string;
}>;
export type GatewayError = Readonly<{ code: string; message: string }>;
export type GatewayResult =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; error: GatewayError }>
  | Readonly<{ ok: false; unavailable: AppUnavailable }>;
export type GatewayClientLike = Readonly<{
  request(method: string, params: unknown): Promise<GatewayResult>;
  close(): Promise<void>;
}>;
export type GatewayClientOptions = Readonly<{
  userDataPath?: string;
  version?: string;
}>;

const DEFAULT_UNAVAILABLE = "Open Omni Desktop to use the Omni tools.";
const AUTH_UNAVAILABLE = "Omni Desktop rejected the agent token. Open Omni Desktop to refresh access.";
const REQUEST_TIMEOUT_MS = 30_000;
const APPLY_TIMEOUT_MS = 10 * 60 * 1000;

class UnavailableError extends Error {
  constructor(
    readonly unavailable: AppUnavailable,
    readonly retryable: boolean,
  ) {
    super(unavailable.message);
  }
}

class RequestTimeoutError extends Error {
  readonly code = "timeout";
}

function userDataPath(): string {
  return process.env.OMNI_USER_DATA ?? defaultUserDataPath();
}

export function defaultUserDataPath(): string {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "omni-desktop");
  if (process.platform === "win32") return join(home, "AppData", "Roaming", "omni-desktop");
  return join(home, ".config", "omni-desktop");
}

function frameId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export class GatewayClient implements GatewayClientLike {
  private socket: net.Socket | undefined;
  private connectPromise: Promise<void> | undefined;
  private nextId = 1;
  private queue = Promise.resolve();
  private closed = false;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly options: Required<GatewayClientOptions>) {}

  async request(method: string, params: unknown): Promise<GatewayResult> {
    const run = this.queue.then(
      () => this.requestQueued(method, params),
      () => this.requestQueued(method, params),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectPending(new Error("Gateway client closed."));
    this.socket?.destroy();
    this.socket = undefined;
    this.connectPromise = undefined;
  }

  private async requestQueued(method: string, params: unknown): Promise<GatewayResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.requestOnce(method, params);
        return "error" in response
          ? { ok: false, error: response.error as GatewayError }
          : { ok: true, result: response.result };
      } catch (error: unknown) {
        this.disconnect();
        if (error instanceof RequestTimeoutError)
          return { ok: false, error: { code: error.code, message: "The Omni Desktop request timed out." } };
        if (!(error instanceof UnavailableError) || !error.retryable || attempt === 1)
          return {
            ok: false,
            unavailable:
              error instanceof UnavailableError
                ? error.unavailable
                : { status: "app-not-running", message: DEFAULT_UNAVAILABLE },
          };
      }
    }
    return { ok: false, unavailable: { status: "app-not-running", message: DEFAULT_UNAVAILABLE } };
  }

  private async requestOnce(method: string, params: unknown): Promise<{ result?: unknown; error?: GatewayError }> {
    await this.connect();
    return this.send(method, params, method === "apply" ? APPLY_TIMEOUT_MS : REQUEST_TIMEOUT_MS) as Promise<{
      result?: unknown;
      error?: GatewayError;
    }>;
  }

  private async connect(): Promise<void> {
    if (this.closed) throw new Error("Gateway client is closed.");
    if (this.socket && !this.socket.destroyed) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openConnection().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async openConnection(): Promise<void> {
    const token = await this.readToken();
    const socket = net.createConnection(await realpath(this.socketPath()));
    this.socket = socket;
    let connected = false;
    const connectedPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      const fail = (error: unknown): void => {
        socket.destroy();
        rejectPromise(error);
      };
      socket.on("data", (chunk) => this.consume(chunk));
      socket.on("error", (error) => {
        if (!connected) fail(new UnavailableError({ status: "app-not-running", message: DEFAULT_UNAVAILABLE }, false));
      });
      socket.once("close", () => {
        this.socket = undefined;
        this.rejectPending(
          new UnavailableError(
            { status: "app-not-running", message: connected ? DEFAULT_UNAVAILABLE : AUTH_UNAVAILABLE },
            connected,
          ),
        );
        if (!connected)
          rejectPromise(new UnavailableError({ status: "app-not-running", message: AUTH_UNAVAILABLE }, false));
      });
      socket.once("connect", () => {
        connected = true;
        void this.send(
          "hello",
          { token, client: { name: "omni-mcp", version: this.options.version }, pid: process.ppid },
          REQUEST_TIMEOUT_MS,
        ).then(
          (response) => {
            if (response.error || (response.result as { status?: unknown } | undefined)?.status !== "ready") {
              fail(new UnavailableError({ status: "app-not-running", message: AUTH_UNAVAILABLE }, false));
              return;
            }
            resolvePromise();
          },
          () => fail(new UnavailableError({ status: "app-not-running", message: AUTH_UNAVAILABLE }, false)),
        );
      });
    });
    return connectedPromise;
  }

  private async readToken(): Promise<string> {
    try {
      const token = (await readFile(join(this.omniPath(), "agent-token"), "utf8")).trim();
      if (!token) throw new Error("Token is empty.");
      return token;
    } catch {
      throw new UnavailableError({ status: "app-not-running", message: DEFAULT_UNAVAILABLE }, false);
    }
  }

  private send(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<{ result?: unknown; error?: GatewayError }> {
    const socket = this.socket;
    if (!socket || socket.destroyed)
      throw new UnavailableError({ status: "app-not-running", message: DEFAULT_UNAVAILABLE }, true);
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new RequestTimeoutError());
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          rejectPromise(new UnavailableError({ status: "app-not-running", message: DEFAULT_UNAVAILABLE }, true));
        }
      });
    });
  }

  private consume(chunk: Buffer): void {
    const socket = this.socket as net.Socket & { omniBuffer?: string };
    socket.omniBuffer = `${socket.omniBuffer ?? ""}${chunk.toString("utf8")}`;
    let newline = socket.omniBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = socket.omniBuffer.slice(0, newline);
      socket.omniBuffer = socket.omniBuffer.slice(newline + 1);
      try {
        const response = JSON.parse(line) as { id?: unknown; result?: unknown; error?: GatewayError };
        const id = frameId(response.id);
        const pending = id === undefined ? undefined : this.pending.get(id);
        if (id !== undefined && pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.resolve(response);
        }
      } catch {
        this.disconnect();
      }
      newline = socket.omniBuffer.indexOf("\n");
    }
  }

  private rejectPending(error: unknown): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private disconnect(): void {
    this.rejectPending(new UnavailableError({ status: "app-not-running", message: DEFAULT_UNAVAILABLE }, true));
    this.socket?.destroy();
    this.socket = undefined;
  }

  private omniPath(): string {
    return join(resolve(this.options.userDataPath), "omni");
  }

  private socketPath(): string {
    return join(this.omniPath(), "agent.sock");
  }
}

export function createGatewayClient(options: GatewayClientOptions = {}): GatewayClient {
  return new GatewayClient({
    userDataPath: options.userDataPath ?? userDataPath(),
    version: options.version ?? RUNTIME_VERSION,
  });
}

export function defaultUnavailableMessage(): string {
  return DEFAULT_UNAVAILABLE;
}
