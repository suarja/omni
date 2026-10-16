import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createIsolatedDirectoryReader,
  type IsolatedDirectoryReaderOptions,
} from "../../src/main/isolated-directory-reader";

const roots: string[] = [];
const readers: Array<{ dispose(): Promise<void> }> = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-directory-reader-"));
  roots.push(root);
  return root;
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCount = 0;

  constructor(onLine: (line: string, child: FakeChild) => void) {
    super();
    const child = this;
    this.stdin = new Writable({
      write(chunk, _encoding, callback) {
        for (const line of String(chunk).split("\n").filter(Boolean)) onLine(line, child);
        callback();
      },
    });
    queueMicrotask(() => this.emit("spawn"));
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): boolean {
    this.killCount += 1;
    this.signalCode = signal;
    queueMicrotask(() => {
      this.exitCode = null;
      this.emit("close", null, signal);
    });
    return true;
  }

  respond(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

function makeFakeReader(
  onLine: (line: string, child: FakeChild) => void,
  extras: Partial<IsolatedDirectoryReaderOptions> = {},
) {
  const children: FakeChild[] = [];
  const spawnEnvironments: Array<NodeJS.ProcessEnv | undefined> = [];
  const spawnProcess = vi.fn((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    spawnEnvironments.push(options.env);
    const child = new FakeChild(onLine);
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const reader = createIsolatedDirectoryReader({
    executablePath: "/usr/bin/node",
    spawnProcess: spawnProcess as unknown as IsolatedDirectoryReaderOptions["spawnProcess"],
    ...extras,
  });
  readers.push(reader);
  return { reader, children, spawnProcess, spawnEnvironments };
}

afterEach(async () => {
  await Promise.all(readers.splice(0).map((reader) => reader.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.useRealTimers();
});

describe("isolated directory reader", () => {
  it("launches the child with only the runtime flag and excludes inherited secrets and preload options", async () => {
    const originalSecret = process.env.OMNI_RUNTIME_SENTINEL_SECRET;
    const originalNodeOptions = process.env.NODE_OPTIONS;
    process.env.OMNI_RUNTIME_SENTINEL_SECRET = "do-not-pass-to-child";
    process.env.NODE_OPTIONS = "--require=/tmp/omni-sentinel-preload.cjs";
    try {
      const { reader, spawnEnvironments } = makeFakeReader((line, child) => {
        const request = JSON.parse(line) as { id: string };
        child.respond({ id: request.id, ok: true, entries: [] });
      });

      await expect(reader.readDirectory("/fixture/env")).resolves.toEqual([]);

      expect(Object.keys(spawnEnvironments[0] ?? {}).sort()).toEqual(["ELECTRON_RUN_AS_NODE"]);
      expect(spawnEnvironments[0]?.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(spawnEnvironments[0]).not.toHaveProperty("OMNI_RUNTIME_SENTINEL_SECRET");
      expect(spawnEnvironments[0]).not.toHaveProperty("NODE_OPTIONS");
    } finally {
      if (originalSecret === undefined) delete process.env.OMNI_RUNTIME_SENTINEL_SECRET;
      else process.env.OMNI_RUNTIME_SENTINEL_SECRET = originalSecret;
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalNodeOptions;
    }
  });

  it("enumerates a disposable directory through the shipped child process", async () => {
    const parent = await tempRoot();
    const target = join(parent, "target");
    await mkdir(join(target, "nested"), { recursive: true });
    await writeFile(join(target, "file.txt"), "fixture\n", "utf8");
    const reader = createIsolatedDirectoryReader({
      executablePath: process.execPath,
    });
    readers.push(reader);

    const entries = await reader.readDirectory(target);

    expect(entries).toEqual([
      { name: "file.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
      { name: "nested", isFile: false, isDirectory: true, isSymbolicLink: false },
    ]);
  });

  it("coalesces identical in-flight paths and runs at most two enumerations", async () => {
    const gates = new Map<string, () => void>();
    const requests: Array<{ id: string; path: string }> = [];
    const { reader, children } = makeFakeReader((line, child) => {
      const request = JSON.parse(line) as { id: string; path: string };
      requests.push(request);
      gates.set(request.id, () => child.respond({ id: request.id, ok: true, entries: [] }));
    });

    const sameA = reader.readDirectory("/fixture/same");
    const sameB = reader.readDirectory("/fixture/same");
    const second = reader.readDirectory("/fixture/second");
    const queued = reader.readDirectory("/fixture/queued");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(sameA).toBe(sameB);
    expect(requests.map((request) => request.path)).toEqual(["/fixture/same", "/fixture/second"]);
    expect(children).toHaveLength(1);

    gates.get(requests[0]!.id)?.();
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    gates.get(requests[1]!.id)?.();
    gates.get(requests[2]!.id)?.();
    await expect(Promise.all([sameA, second, queued])).resolves.toHaveLength(3);
  });

  it("rejects work while the bounded queue is full", async () => {
    const requests: Array<{ id: string }> = [];
    const gates = new Map<string, () => void>();
    const { reader } = makeFakeReader((line, child) => {
      const request = JSON.parse(line) as { id: string };
      requests.push(request);
      gates.set(request.id, () => {
        gates.delete(request.id);
        child.respond({ id: request.id, ok: true, entries: [] });
      });
    });
    const active = [reader.readDirectory("/fixture/active-a"), reader.readDirectory("/fixture/active-b")];
    const waiting = Array.from({ length: 64 }, (_, index) => reader.readDirectory(`/fixture/wait-${index}`));
    const settled = Promise.allSettled([...active, ...waiting]);
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    await expect(reader.readDirectory("/fixture/overflow")).rejects.toMatchObject({ code: "directory-reader-busy" });
    expect(requests).toHaveLength(2);
    while (gates.size) {
      const dispatchedBefore = requests.length;
      for (const respond of [...gates.values()]) respond();
      if (requests.length < 66) await vi.waitFor(() => expect(requests.length).toBeGreaterThan(dispatchedBefore));
    }
    await expect(settled).resolves.toHaveLength(66);
  });

  it("kills and reaps a timed-out child before allowing a later replacement", async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    let requestId = "";
    const spawnProcess = vi.fn(() => {
      const child = new FakeChild((line) => {
        requestId = (JSON.parse(line) as { id: string }).id;
      });
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const reader = createIsolatedDirectoryReader({
      executablePath: "/usr/bin/node",
      spawnProcess: spawnProcess as unknown as IsolatedDirectoryReaderOptions["spawnProcess"],
    });
    readers.push(reader);
    const pending = reader.readDirectory("/fixture/blocked");
    const pendingRejection = expect(pending).rejects.toMatchObject({ code: "directory-reader-timeout" });

    await vi.advanceTimersByTimeAsync(3_001);
    await pendingRejection;
    expect(children[0]?.killCount).toBe(1);
    await expect(reader.readDirectory("/fixture/cooldown")).rejects.toMatchObject({
      code: "directory-reader-cooldown",
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_001);
    const replacement = reader.readDirectory("/fixture/replacement");
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    children[1]?.respond({ id: requestId, ok: true, entries: [] });
    await expect(replacement).resolves.toEqual([]);
  });

  it("rejects malformed or unsafe responses and terminates the child", async () => {
    let child: FakeChild | undefined;
    const { reader } = makeFakeReader((line, current) => {
      child = current;
      const request = JSON.parse(line) as { id: string };
      current.respond({
        id: request.id,
        ok: true,
        entries: [{ name: "../outside", isFile: true, isDirectory: false, isSymbolicLink: false }],
      });
    });

    await expect(reader.readDirectory("/fixture/safe")).rejects.toMatchObject({ code: "directory-reader-protocol" });
    await vi.waitFor(() => expect(child?.killCount).toBe(1));
  });

  it("rejects an oversized serialized response before exposing entries", async () => {
    const { reader } = makeFakeReader((line, child) => {
      const request = JSON.parse(line) as { id: string };
      child.respond({
        id: request.id,
        ok: true,
        entries: [{ name: "x".repeat(4 * 1024 * 1024), isFile: true, isDirectory: false, isSymbolicLink: false }],
      });
    });

    await expect(reader.readDirectory("/fixture/oversized-response")).rejects.toMatchObject({
      code: "directory-reader-response-limit",
    });
  });

  it("kills and reaps the child before disposal resolves", async () => {
    let child: FakeChild | undefined;
    const { reader } = makeFakeReader((_line, current) => {
      child = current;
    });
    const pending = reader.readDirectory("/fixture/dispose");
    const rejected = expect(pending).rejects.toMatchObject({ code: "directory-reader-disposed" });
    await vi.waitFor(() => expect(child).toBeDefined());

    await reader.dispose();

    await rejected;
    expect(child?.killCount).toBe(1);
    await expect(reader.readDirectory("/fixture/after-dispose")).rejects.toMatchObject({
      code: "directory-reader-disposed",
    });
  });

  it("preserves native missing-directory errors", async () => {
    const { reader } = makeFakeReader((line, child) => {
      const request = JSON.parse(line) as { id: string };
      child.respond({ id: request.id, ok: false, error: { code: "ENOENT" } });
    });

    await expect(reader.readDirectory("/fixture/missing")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails an oversized directory response without returning a partial listing", async () => {
    const parent = await tempRoot();
    const target = join(parent, "large");
    await mkdir(target);
    await Promise.all(
      Array.from({ length: 10_001 }, (_, index) => writeFile(join(target, `entry-${index}.txt`), "", "utf8")),
    );
    const reader = createIsolatedDirectoryReader({ executablePath: process.execPath });
    readers.push(reader);

    await expect(reader.readDirectory(target)).rejects.toMatchObject({ code: "directory-entry-limit" });
  });
});
