import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { parseAgentMutationResponse } from "../../src/shared/agents-ipc";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const NOW = Date.parse("2026-09-14T12:00:00.000Z");
let root: string;
let path: string;
let fixture: { schemaVersion: number; requests: Record<string, unknown>[] };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omni-request-quarantine-"));
  path = join(root, "agent-requests.json");
  fixture = JSON.parse(
    await readFile(join(import.meta.dirname, "../fixtures/persisted-state/rc9/agent-requests.json"), "utf8"),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("unreadable agent requests", () => {
  it.each([
    ["unknown plan field", { plan: { unexpected: true } }],
    ["non-object entry", null],
    ["unsupported status", { status: "unknown" }],
  ])("quarantines a %s without losing the other requests or original bytes", async (_label, invalid) => {
    const unreadable = invalid === null ? null : { ...fixture.requests[0], ...invalid };
    const original = ` { "schemaVersion": 1, "requests": ${JSON.stringify([fixture.requests[0], unreadable, ...fixture.requests.slice(1)])} }\n`;
    await writeFile(path, original);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createAgentRequestsStore(path, () => NOW);
    const [first, concurrent] = await Promise.all([store.all(), store.all()]);
    expect(first).toHaveLength(fixture.requests.length);
    expect(concurrent).toEqual(first);
    expect(first.map((item) => item.requestId)).toEqual(fixture.requests.map((item) => item.requestId));
    const quarantines = (await readdir(root)).filter((name) => name.includes(".quarantine."));
    expect(quarantines).toHaveLength(1);
    const quarantinePath = join(root, quarantines[0]!);
    expect(await readFile(quarantinePath, "utf8")).toBe(original);
    expect((await stat(quarantinePath)).mode & 0o777).toBe(0o600);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(" ")).toContain(path);
    expect(warn.mock.calls[0]?.join(" ")).toContain("index 1");
    expect(warn.mock.calls[0]?.join(" ")).toContain(quarantinePath);
    expect(warn.mock.calls[0]?.join(" ")).toMatch(/invalid|unexpected|must be an object/);
    await store.decline(first[0]!.requestId);
    expect(await createAgentRequestsStore(path, () => NOW).all()).toEqual(await store.all());
    expect(await readFile(quarantinePath, "utf8")).toBe(original);
    expect((await readdir(root)).filter((name) => name.includes(".quarantine."))).toEqual(quarantines);
  });

  it("keeps the live file and rejects loading if quarantine cannot be saved", async () => {
    const original = JSON.stringify({ ...fixture, requests: [...fixture.requests, null] });
    await writeFile(path, original);
    vi.mocked(writeFile).mockRejectedValueOnce(
      Object.assign(new Error("Quarantine disk unavailable."), { code: "ENOENT" }),
    );
    const store = createAgentRequestsStore(path, () => NOW);
    await expect(store.all()).rejects.toThrow("Quarantine disk unavailable.");
    expect(await readFile(path, "utf8")).toBe(original);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await store.all()).toHaveLength(fixture.requests.length);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("starts with an empty store when its only request is unreadable inside a valid envelope", async () => {
    const original = JSON.stringify({ schemaVersion: 1, requests: [null] });
    await writeFile(path, original);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await createAgentRequestsStore(path, () => NOW).all()).toEqual([]);
    const quarantines = (await readdir(root)).filter((name) => name.includes(".quarantine."));
    expect(quarantines).toHaveLength(1);
    expect(await readFile(join(root, quarantines[0]!), "utf8")).toBe(original);
    expect(await createAgentRequestsStore(path, () => NOW).all()).toEqual([]);
  });

  it("validates and retains the package id with the existing safe relative-path parser", () => {
    const request = fixture.requests[0]!;
    const plan = request.plan as Record<string, unknown>;
    expect(
      parseAgentMutationResponse({ ...request, plan: { ...plan, packageId: "packages\\tools" } }).plan,
    ).toMatchObject({ packageId: "packages/tools" });
    for (const packageId of [
      "",
      ".",
      "..",
      "../tools",
      "/tools",
      "C:\\tools",
      "a//b",
      "a/./b",
      "a/../b",
      "a\u0000b",
      "a\nb",
      42,
      null,
    ]) {
      expect(() => parseAgentMutationResponse({ ...request, plan: { ...plan, packageId } })).toThrow(/Package id/);
    }
    expect(() => parseAgentMutationResponse({ ...request, plan: { ...plan, unexpected: true } })).toThrow(/unexpected/);
    expect(parseAgentMutationResponse(request).plan).not.toHaveProperty("packageId");
  });

  it.each([
    "{ broken",
    JSON.stringify({ schemaVersion: 2, requests: [] }),
    JSON.stringify({ schemaVersion: 1, requests: "broken" }),
    JSON.stringify({ schemaVersion: 1, requests: [], unexpected: true }),
  ])("preserves whole-store corruption and refuses to overwrite it: %s", async (original) => {
    await writeFile(path, original);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createAgentRequestsStore(path, () => NOW);
    await expect(store.all()).rejects.toThrow();
    await expect(
      store.create({ request: fixture.requests[0]!.request as never, plan: fixture.requests[0]!.plan as never }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readdir(root)).toEqual(["agent-requests.json"]);
    expect(warn).not.toHaveBeenCalled();
  });
});
