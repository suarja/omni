import { expect, it, vi } from "vitest";
import { createAgentSkillPreviewReader } from "../../src/renderer/canvas/changes/agent-skill-preview";

it("reads the currently linked intent instead of the route before refresh and apply preflight", async () => {
  let linked = "current";
  const api = {
    listAgentRequests: vi.fn(async () => ({
      requests: [{ requestId: "request", status: "pending", intentId: linked }],
    })),
    refreshSkillOperation: vi.fn(async ({ intentId }) => ({ status: "ready", intentId })),
    refreshAgentRequest: vi.fn(),
  };
  const reader = createAgentSkillPreviewReader(api as never);
  expect(await reader.read("route", "request")).toMatchObject({ preview: { intentId: "current" }, updated: true });
  linked = "relinked-by-another-window";
  expect(await reader.read("current", "request")).toMatchObject({ preview: { intentId: linked }, updated: true });
  expect(api.refreshSkillOperation.mock.calls.map(([input]) => input.intentId)).toEqual(["current", linked]);
  expect(api.refreshAgentRequest).not.toHaveBeenCalled();
});

it("recovers a mismatch once and uses the returned intent for the next refresh", async () => {
  const api = {
    refreshSkillOperation: vi
      .fn()
      .mockRejectedValueOnce(new Error("Agent request does not match this skill operation."))
      .mockResolvedValue({ status: "ready", intentId: "current" }),
    refreshAgentRequest: vi
      .fn()
      .mockResolvedValue({ intentId: "current", skillIntent: { kind: "remove", bindingIds: ["binding"] } }),
  };
  const reader = createAgentSkillPreviewReader(api);
  expect(await reader.read("route", "request")).toMatchObject({ preview: { intentId: "current" }, updated: true });
  expect(await reader.read("current", "request")).toMatchObject({ updated: false });
  expect(api.refreshAgentRequest).toHaveBeenCalledTimes(1);
  expect(api.refreshSkillOperation).toHaveBeenLastCalledWith({ intentId: "current", requestId: "request" });
});

it("does not regenerate a request for an unrelated refresh failure", async () => {
  const api = {
    refreshSkillOperation: vi.fn().mockRejectedValue(new Error("Permission denied")),
    refreshAgentRequest: vi.fn(),
  };
  await expect(createAgentSkillPreviewReader(api).read("intent", "request")).rejects.toThrow("Permission denied");
  expect(api.refreshAgentRequest).not.toHaveBeenCalled();
});
