import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLastSeenStore } from "../../src/main/agent-gateway/last-seen-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent last-seen store", () => {
  it("persists identified harness timestamps and tolerates malformed state", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-last-seen-"));
    roots.push(root);
    const store = createLastSeenStore(root, () => Date.parse("2026-09-14T00:00:00.000Z"));

    await store.record("claude-code");
    await expect(store.lastSeen()).resolves.toEqual({ "claude-code": "2026-09-14T00:00:00.000Z", codex: undefined });
    expect(JSON.parse(await readFile(join(root, "omni", "agent-last-seen.json"), "utf8"))).toEqual({
      "claude-code": "2026-09-14T00:00:00.000Z",
    });

    await writeFile(join(root, "omni", "agent-last-seen.json"), "not json");
    await expect(createLastSeenStore(root).lastSeen()).resolves.toEqual({ "claude-code": undefined, codex: undefined });
  });
});
