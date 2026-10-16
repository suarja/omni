import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { watchReviewChanges } from "../../src/main/review-events";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";

const cleanups: (() => void)[] = [];
const roots: string[] = [];
afterEach(async () => {
  cleanups.splice(0).forEach((close) => close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("notifies an open renderer when an agent persists a request", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-live-review-"));
  roots.push(root);
  await mkdir(join(root, "omni"));
  let publish!: () => void;
  const changed = new Promise<void>((resolve) => {
    publish = resolve;
  });
  cleanups.push(watchReviewChanges(root, publish));
  const requests = createAgentRequestsStore(join(root, "omni", "agent-requests.json"));
  await requests.create({
    request: { kind: "make-compatible", sourceId: "source", harness: "codex" },
    plan: {
      kind: "make-compatible",
      planId: "plan",
      displayTarget: "plugin",
      actions: [],
      git: { mode: "disabled", warnings: [] },
    },
  });
  await changed;
}, 1500);

it.each(["operations.json", "bindings.json", "project-source-registry.json"])(
  "notifies after atomic replacement of %s",
  async (filename) => {
    const root = await mkdtemp(join(tmpdir(), "omni-live-review-"));
    roots.push(root);
    await mkdir(join(root, "omni"));
    let publish!: () => void;
    const changed = new Promise<void>((resolve) => {
      publish = resolve;
    });
    cleanups.push(watchReviewChanges(root, publish));
    const temporary = join(root, "omni", ".temporary.json");
    await writeFile(temporary, "{}");
    await rename(temporary, join(root, "omni", filename));
    await changed;
  },
  1500,
);
