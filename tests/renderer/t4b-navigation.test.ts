import { expect, it } from "vitest";
import { resolveCanvasRoute } from "../../src/renderer/canvas-route";
import { isRouteGated } from "../../src/renderer/features";
import { DEFAULT_FEATURES } from "../../src/shared/settings-ipc";
import { agentRequestRoute } from "../../src/renderer/review/agent-requests";
import { routeTable } from "./t4a-route-table";
import { agentRequests } from "./t4a-agent-requests";

const operations = [
  "assignment",
  "operation-apply",
  "operation-remove",
  "operation-import",
  "operation-compatible",
  "operation-receipt",
  "operation-restore",
  "operation-restore-apply",
  "add-to-project",
  "operation-import-catalogue",
] as const;

it.each(operations)("opens %s in the canvas changes workbench", (screen) => {
  const canvas = resolveCanvasRoute(routeTable[screen]);
  expect(canvas?.screen).toBe("resource-canvas");
  expect(canvas).toHaveProperty("initialOperation", routeTable[screen]);
});

it.each(agentRequests)("opens the $request.kind agent request directly on the canvas", (request) => {
  const route = agentRequestRoute(request);
  expect(route.screen).toBe("resource-canvas");
  expect(route).toHaveProperty("requestId", request.requestId);
  if (request.intentId) expect(route).toHaveProperty("initialSkillIntentId", request.intentId);
  else if (request.request.kind === "write-skill") expect(route).toHaveProperty("initialSkillRequest", request.request);
  else expect(route).toHaveProperty("initialOperation.requestId", request.requestId);
});

it.each(agentRequests.filter((request) => Boolean(request.skillIntent)))(
  "opens $request.kind even when its saved preview link is absent",
  (request) => {
    const route = agentRequestRoute({ ...request, intentId: undefined });
    expect(route).toHaveProperty("requestId", request.requestId);
    expect(route).toHaveProperty("initialSkillIntent", request.skillIntent);
  },
);

it.each(["add-to-project", "operation-import-catalogue"] as const)(
  "keeps %s gated after canvas normalization",
  (screen) => {
    const canvas = resolveCanvasRoute(routeTable[screen])!;
    expect(canvas).not.toBeNull();
    expect(isRouteGated(canvas, DEFAULT_FEATURES)).toBe(true);
    expect(isRouteGated(canvas, { ...DEFAULT_FEATURES, publicCatalogue: true })).toBe(false);
  },
);
