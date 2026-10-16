import type { AiModelView } from "../../shared/ai-gateway-ipc";
import { AI_MODEL_PREFERENCES, AI_TASK_TIERS } from "../../shared/ai-gateway-routing";
import type { AiFunctionId } from "../../shared/ai-gateway-ipc";

function matches(model: AiModelView, preference: string): boolean {
  return model.id.toLowerCase().replace(/[.-]/g, "").includes(preference.toLowerCase().replace(/[.-]/g, ""));
}

function isFree(model: AiModelView): boolean {
  return model.free || model.id.endsWith(":free") || (model.cost.input === 0 && model.cost.output === 0);
}

export function resolveAutoModel(task: AiFunctionId, models: readonly AiModelView[]): AiModelView | undefined {
  const need = task === "compose" ? 32_000 : 8_000;
  const eligible = models.filter((model) => model.tools !== false && model.contextWindow >= need && !isFree(model));
  return (
    AI_MODEL_PREFERENCES[AI_TASK_TIERS[task]]
      .map((preference) => eligible.find((model) => matches(model, preference)))
      .find(Boolean) ?? eligible[0]
  );
}

export function formatModelContext(contextWindow: number, language: "en" | "fr"): string {
  if (contextWindow === 0) return "—";
  return `${(contextWindow / 1_000).toLocaleString(language === "fr" ? "fr-FR" : "en-US")} k`;
}
