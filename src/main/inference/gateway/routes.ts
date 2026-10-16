import type { FunctionRoutes } from "../../../shared/ai-gateway-ipc";
import type { TaskId } from "../../../shared/inference-ipc";
import {
  AGENT_MODEL_PREFERENCES,
  AI_MODEL_PREFERENCES,
  AI_TASK_TIERS,
  AUTO_ALLOWS_FREE,
} from "../../../shared/ai-gateway-routing";

import type { Connection } from "../../../shared/ai-gateway-ipc";
import type { GatewayModel } from "./models";

export { AUTO_ALLOWS_FREE };

export type RouteResolution =
  Readonly<{ status: "ready"; model: GatewayModel }> | Readonly<{ status: "unavailable"; reason: string }>;
export type RouteTask = TaskId | "agent";
const AUTO_CONTEXT_NEEDS: Readonly<Record<RouteTask, number>> = {
  "suggest-adapt": 8_000,
  explain: 8_000,
  summarize: 8_000,
  agent: 32_000,
};

function matchingModel(models: readonly GatewayModel[], preference: string): GatewayModel | undefined {
  const wanted = preference.toLowerCase().replace(/[.-]/g, "");
  return models.find((model) => model.id.toLowerCase().replace(/[.-]/g, "").includes(wanted));
}

function isFree(model: GatewayModel): boolean {
  return model.free ?? (model.id.endsWith(":free") || (model.cost.input === 0 && model.cost.output === 0));
}

function autoEligible(model: GatewayModel, need: number): boolean {
  return model.tools !== false && model.contextWindow >= need && (AUTO_ALLOWS_FREE || !isFree(model));
}

function windowLabel(window: number): string {
  return `${Math.round(window / 1_000)} k`;
}

function unavailableForAuto(models: readonly GatewayModel[], need: number): string {
  if (models.length === 0) return "The connection has no models.";
  if (models.every((model) => model.tools === false)) return "no listed model supports tool calls";
  const nonFree = models.filter((model) => AUTO_ALLOWS_FREE || !isFree(model));
  if (nonFree.length === 0) return "no free model is eligible for Auto";
  const toolCapable = nonFree.filter((model) => model.tools !== false);
  const largestWindow = Math.max(...toolCapable.map((model) => model.contextWindow), 0);
  if (largestWindow < need)
    return `the largest window is ${windowLabel(largestWindow)}, the job needs ${windowLabel(need)}`;
  return "no listed model matches the Auto preference";
}

export function resolve(
  task: RouteTask,
  connection: Connection | undefined,
  models: readonly GatewayModel[],
  functions: FunctionRoutes = { "suggest-adapt": "auto", explain: "auto", summarize: "auto", compose: "auto" },
): RouteResolution {
  // Data policy is not decided here: the budget refuses a remote call whose categories the user
  // has not opted in (`data-categories.ts`, one rule, aware of the connection's scope). A
  // second table of task categories in the resolver would drift from the tasks' own.
  if (!connection) return { status: "unavailable", reason: "Add a connection in Settings · AI." };
  if (task === "agent") {
    const chosen = functions.compose;
    if (chosen !== "auto") {
      const model = models.find((candidate) => candidate.id === chosen.modelId);
      return model
        ? { status: "ready", model }
        : { status: "unavailable", reason: `Model ${chosen.modelId} is not listed.` };
    }
    const eligible = models.filter((model) => autoEligible(model, AUTO_CONTEXT_NEEDS.agent));
    const model =
      AGENT_MODEL_PREFERENCES.map((preference) => matchingModel(eligible, preference)).find(Boolean) ?? eligible[0];
    return model
      ? { status: "ready", model }
      : { status: "unavailable", reason: unavailableForAuto(models, AUTO_CONTEXT_NEEDS.agent) };
  }
  const route = functions[task];
  if (route !== "auto") {
    const model = models.find((candidate) => candidate.id === route.modelId);
    return model
      ? { status: "ready", model }
      : { status: "unavailable", reason: `Model ${route.modelId} is not listed.` };
  }
  const need = AUTO_CONTEXT_NEEDS[task];
  const eligible = models.filter((model) => autoEligible(model, need));
  const model =
    AI_MODEL_PREFERENCES[AI_TASK_TIERS[task]].map((preference) => matchingModel(eligible, preference)).find(Boolean) ??
    eligible[0];
  return model ? { status: "ready", model } : { status: "unavailable", reason: unavailableForAuto(models, need) };
}

export { AI_MODEL_PREFERENCES as PREFERRED_MODELS, AI_TASK_TIERS as TASK_TIERS };
