import { useEffect, useState, type ReactElement } from "react";

import type { AiConnectionResponse, AiModelView } from "../../shared/ai-gateway-ipc";
import type { DesktopApi } from "../../shared/ipc";
import { DEFAULT_AI_SETTINGS } from "../../shared/settings-ipc";
import type { AiFunctionId } from "../../shared/ai-gateway-ipc";
import { Button } from "../components/ui/Button";
import { Callout } from "../components/ui/Callout";
import { Card, CardHeader } from "../components/ui/Card";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { LoadingItem } from "../components/ui/LoadingItem";
import { useI18n } from "../i18n";
import type { Route } from "../navigation";
import { formatModelContext } from "./ai-models";

export type AiFunctionSectionProps = Readonly<{
  api: DesktopApi | null;
  onNavigateToRoute: (route: Route) => void;
  task: AiFunctionId;
}>;

function taskLabel(task: AiFunctionId, t: ReturnType<typeof useI18n>["t"]): string {
  if (task === "suggest-adapt") return t("settings.ai.functions.suggest");
  if (task === "explain") return t("settings.ai.functions.explain");
  if (task === "compose") return t("settings.ai.functions.compose");
  return t("settings.ai.functions.summarize");
}

function modelSub(model: AiModelView, language: "en" | "fr", t: ReturnType<typeof useI18n>["t"]): string {
  const context = formatModelContext(model.contextWindow, language);
  const tools =
    model.tools === "unknown" ? t("settings.ai.functionPage.toolsUnknown") : t("settings.ai.functionPage.tools");
  if (model.free) return t("settings.ai.functionPage.freeModel", { context, tools });
  if (!model.pricingKnown) return t("settings.ai.functionPage.modelContextNoPrice", { context, tools });
  return t("settings.ai.functionPage.modelContextPrice", {
    context,
    input: model.cost.input,
    output: model.cost.output,
    tools,
  });
}

export function AiFunctionSection({ api, onNavigateToRoute, task }: AiFunctionSectionProps): ReactElement {
  const { language, t } = useI18n();
  const [connection, setConnection] = useState<AiConnectionResponse | null>(null);
  const [models, setModels] = useState<readonly AiModelView[]>([]);
  const [selected, setSelected] = useState<"auto" | { modelId: string }>("auto");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!api?.getAiConnection || !api.listAiModels) {
      setLoaded(true);
      return () => {
        active = false;
      };
    }
    void Promise.all([api.getAiConnection(), api.listAiModels(), api.getSettings?.()])
      .then(([nextConnection, modelResponse, settings]) => {
        if (!active) return;
        setConnection(nextConnection);
        setModels(modelResponse.models);
        if (modelResponse.unavailable) setError(modelResponse.unavailable);
        setSelected(settings?.ai.functions[task] ?? DEFAULT_AI_SETTINGS.functions[task]);
      })
      .catch((loadError: unknown) => {
        if (active)
          setError(loadError instanceof Error ? loadError.message : t("settings.ai.functionPage.unavailable"));
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [api, t, task]);

  const choose = async (next: "auto" | { modelId: string }): Promise<void> => {
    if (!api?.setAiFunctions || busy) return;
    setBusy(true);
    setError(null);
    try {
      const settings = await api.getSettings?.();
      const functions = settings?.ai.functions ?? DEFAULT_AI_SETTINGS.functions;
      await api.setAiFunctions({ functions: { ...functions, [task]: next } });
      setSelected(next);
      onNavigateToRoute({ screen: "settings" });
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : t("settings.ai.functionPage.saveUnavailable"));
    } finally {
      setBusy(false);
    }
  };

  const back = (): void => onNavigateToRoute({ screen: "settings" });
  return (
    <div className="shell-page destination-page settings-ai-page" data-testid="settings-ai-function-page">
      <Button size="small" tone="ghost" onClick={() => onNavigateToRoute({ screen: "settings" })}>
        {t("canvas.back")}
      </Button>
      <h3>{taskLabel(task, t)}</h3>
      {!loaded ? <LoadingItem label={t("settings.ai.loading")} /> : null}
      {error ? (
        <Callout title={t("settings.ai.functionPage.saveUnavailable")} tone="error">
          {error}
        </Callout>
      ) : null}
      {loaded && !connection?.connection ? (
        <Callout title={t("settings.ai.functionPage.unavailable")} tone="warning">
          <p>{t("settings.ai.connection.none")}</p>
          <Button
            dataTestId="settings-ai-function-add-connection"
            onClick={() => onNavigateToRoute({ screen: "settings-ai-connection" })}
            size="small"
          >
            {t("settings.ai.functionPage.addConnection")}
          </Button>
        </Callout>
      ) : null}
      {loaded && connection?.connection ? (
        <Card>
          <CardHeader title={t("settings.ai.functions.label")} />
          <ItemList variant="nested">
            <ListItem
              dataTestId="settings-ai-function-auto"
              name={t("settings.ai.functions.autoLabel")}
              onClick={() => void choose("auto")}
              selected={selected === "auto"}
              sub={t("settings.ai.functionPage.autoDescription")}
            />
            {models.map((model) => (
              <ListItem
                dataTestId={`settings-ai-function-model-${model.id}`}
                key={model.id}
                name={model.name}
                onClick={() => void choose({ modelId: model.id })}
                selected={selected !== "auto" && selected.modelId === model.id}
                sub={modelSub(model, language, t)}
              />
            ))}
            {!models.length ? <ListItem name={t("settings.ai.functionPage.unavailable")} /> : null}
          </ItemList>
        </Card>
      ) : null}
    </div>
  );
}
