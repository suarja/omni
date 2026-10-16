import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { watchAgentRequestAttention } from "../../src/main/agent-gateway/request-attention";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(focused = false) {
  const root = await mkdtemp(join(tmpdir(), "omni-attention-"));
  roots.push(root);
  const requests = createAgentRequestsStore(join(root, "requests.json"));
  const setBadgeCount = vi.fn();
  const show = vi.fn();
  const close = vi.fn();
  const openRequest = vi.fn();
  let click: (() => void) | undefined;
  const createNotification = vi.fn(() => ({
    show,
    close,
    on: (_event: "click", listener: () => void) => {
      click = listener;
    },
  }));
  const stop = await watchAgentRequestAttention({
    requests,
    app: { setBadgeCount },
    createNotification,
    isFocused: () => focused,
    openRequest,
  });
  const create = (approval: "omni" | "conversation" = "omni") =>
    requests.create({
      request: { kind: "make-compatible", sourceId: "personal", harness: "codex", packageId: "pstack" },
      plan: {
        kind: "make-compatible",
        planId: "plan-one",
        displayTarget: "pstack",
        actions: [],
        git: { mode: "unavailable", warnings: [] },
      },
      approval,
      approvalReason: { code: "deletes-files", count: 2 },
      harness: "claude-code",
      sessionName: "session-one",
    });
  return {
    requests,
    create,
    setBadgeCount,
    createNotification,
    show,
    close,
    openRequest,
    click: () => click?.(),
    stop,
  };
}

it("counts only pending Omni requests and clears the dock badge after decline", async () => {
  const f = await setup();
  expect(f.setBadgeCount).toHaveBeenLastCalledWith(0);
  await f.create("conversation");
  const one = await f.create();
  const two = await f.create();
  expect(f.setBadgeCount).toHaveBeenLastCalledWith(2);
  await f.requests.decline(one.requestId);
  expect(f.setBadgeCount).toHaveBeenLastCalledWith(1);
  await f.requests.decline(two.requestId);
  expect(f.setBadgeCount).toHaveBeenLastCalledWith(0);
  f.stop();
});

it("notifies once for a new request, with attribution, action and reason, and opens it on click", async () => {
  const f = await setup();
  const request = await f.create();
  expect(f.createNotification).toHaveBeenCalledWith({
    title: "Approval needed in Omni",
    body: "Claude Code · session-one: Make pstack compatible with Codex — Deletes 2 files",
  });
  expect(f.show).toHaveBeenCalledTimes(1);
  await f.requests.refresh(request.requestId, { plan: request.plan });
  expect(f.show).toHaveBeenCalledTimes(1);
  f.click();
  expect(f.openRequest).toHaveBeenCalledWith(request.requestId);
  f.stop();
});

it("suppresses notifications when an Omni window is focused", async () => {
  const f = await setup(true);
  await f.create();
  expect(f.createNotification).not.toHaveBeenCalled();
  expect(f.setBadgeCount).toHaveBeenLastCalledWith(1);
  f.stop();
});

it("restores the badge without re-notifying historical pending requests", async () => {
  const f = await setup();
  f.stop();
  await f.create();
  const notification = vi.fn();
  const stop = await watchAgentRequestAttention({
    requests: f.requests,
    app: { setBadgeCount: f.setBadgeCount },
    createNotification: notification,
    isFocused: () => false,
    openRequest: f.openRequest,
  });
  expect(f.setBadgeCount).toHaveBeenLastCalledWith(1);
  expect(notification).not.toHaveBeenCalled();
  stop();
});
