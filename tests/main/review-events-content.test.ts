import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const observation = vi.hoisted(() => ({ callback: undefined as undefined | ((event: string, name: string) => void) }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  watch: vi.fn((_path, callback) => {
    observation.callback = callback;
    return { on: vi.fn(), close: vi.fn() };
  }),
}));
import { watchReviewChanges } from "../../src/main/review-events";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

it("ignores identical rewrites and permission events but publishes changed content", async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "omni-review-content-"));
  roots.push(root);
  mkdirSync(join(root, "omni"));
  const path = join(root, "omni", "agent-requests.json");
  writeFileSync(path, "{}");
  const publish = vi.fn();
  const close = watchReviewChanges(root, publish);
  writeFileSync(path, "{}");
  observation.callback?.("change", "agent-requests.json");
  await vi.advanceTimersByTimeAsync(25);
  expect(publish).not.toHaveBeenCalled();
  writeFileSync(path, '{"pending":1}');
  observation.callback?.("rename", "agent-requests.json");
  await vi.advanceTimersByTimeAsync(25);
  expect(publish).toHaveBeenCalledTimes(1);
  observation.callback?.("change", "agent-requests.json");
  await vi.advanceTimersByTimeAsync(25);
  expect(publish).toHaveBeenCalledTimes(1);
  close();
});
