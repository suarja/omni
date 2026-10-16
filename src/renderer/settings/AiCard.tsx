import { useEffect, useMemo, useState, type ReactElement } from "react";

import type { AiConnectionResponse, AiModelView, AiPresetView, AiUsageResponse } from "../../shared/ai-gateway-ipc";
import type { DesktopApi } from "../../shared/ipc";
import type { AiSettings } from "../../shared/settings-ipc";
import type { AiFunctionId } from "../../shared/ai-gateway-ipc";
import { Card, CardHeader } from "../components/ui/Card";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { LoadingItem } from "../components/ui/LoadingItem";
import { useI18n } from "../i18n";
import type { Route } from "../navigation";
import { useFeatures } from "../features";
import { formatModelContext, resolveAutoModel } from "./ai-models";

export type AiCardProps = Readonly<{
  api?: DesktopApi | null;
  intelligence: AiSettings;
  onIntelligenceChange: (next: AiSettings) => void;
  onNavigateToRoute?: (route: Route) => void;
}>;

const TASKS: readonly { id: AiFunctionId; label: "suggest" | "explain" | "summarize" | "compose" }[] = [
  { id: "suggest-adapt", label: "suggest" },
  { id: "explain", label: "explain" },
  { id: "summarize", label: "summarize" },
  { id: "compose", label: "compose" },
];

function numberValue(value: number, language: "en" | "fr", digits = 0): string {
  return value.toLocaleString(language === "fr" ? "fr-FR" : "en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function connectionSub(
  response: AiConnectionResponse | null,
  presets: readonly AiPresetView[],
  t: ReturnType<typeof useI18n>["t"],
): string {
  const connection = response?.connection;
  if (!connection) return t("settings.ai.connection.none");
  const preset = presets.find((candidate) => candidate.id === connection.preset);
  if (response?.scope === "local")
    return t("settings.ai.connection.local", {
      provider: connection.displayName,
      url: connection.baseUrl ?? preset?.defaultBaseUrl ?? "",
    });
  return response?.keyState === "set"
    ? t("settings.ai.connection.keySaved", { provider: connection.displayName })
    : t("settings.ai.connection.noKey", { provider: connection.displayName });
}

function functionSub(
  task: AiFunctionId,
  intelligence: AiSettings,
  response: AiConnectionResponse | null,
  presets: readonly AiPresetView[],
  models: readonly AiModelView[],
  modelsError: string | null,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (!response?.connection)
    return t("settings.ai.functions.unavailable", { reason: t("settings.ai.connection.none") });
  const preset = presets.find((candidate) => candidate.id === response.connection?.preset);
  const keyRequired = preset?.keyRequired ?? (response.connection.preset !== "custom" && response.scope === "remote");
  if (keyRequired && response.keyState === "none")
    return t("settings.ai.functions.unavailable", { reason: t("settings.ai.functions.missingKey") });
  const route = intelligence.functions[task];
  if (route !== "auto") return t("settings.ai.functions.chosen", { model: route.modelId });
  const model = resolveAutoModel(task, models);
  if (!model)
    return t("settings.ai.functions.unavailable", {
      reason: modelsError ?? t("settings.ai.functionPage.unavailable"),
    });
  return t("settings.ai.functions.auto", { model: model.name });
}

export function AiCard({
  api = null,
  intelligence,
  onIntelligenceChange,
  onNavigateToRoute,
}: AiCardProps): ReactElement {
  const { language, t } = useI18n();
  const { features } = useFeatures();
  const [connection, setConnection] = useState<AiConnectionResponse | null>(null);
  const [presets, setPresets] = useState<readonly AiPresetView[]>([]);
  const [models, setModels] = useState<readonly AiModelView[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [usage, setUsage] = useState<AiUsageResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    if (!api?.getAiConnection || !api.getAiUsage) {
      setLoaded(true);
      return () => {
        active = false;
      };
    }
    void Promise.all([
      api.getAiConnection(),
      api.getAiUsage(),
      api.listAiPresets?.() ?? Promise.resolve({ presets: [] }),
    ])
      .then(async ([nextConnection, nextUsage, nextPresets]) => {
        if (!active) return;
        setConnection(nextConnection);
        setUsage(nextUsage);
        setPresets(nextPresets.presets);
        if (nextConnection.connection && api.listAiModels) {
          try {
            const listed = await api.listAiModels();
            setModels(listed.models);
            setModelsError(listed.unavailable ?? null);
          } catch (error: unknown) {
            setModels([]);
            setModelsError(error instanceof Error ? error.message : t("settings.ai.functionPage.unavailable"));
          }
        }
        setLoaded(true);
      })
      .catch(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [api, t]);

  const taskRows = useMemo(
    () =>
      TASKS.filter((task) => task.id !== "compose" || features.compose).map(({ id, label }) => ({
        id,
        label: t(`settings.ai.functions.${label}`),
        sub: functionSub(id, intelligence, connection, presets, models, modelsError, t),
      })),
    [connection, features.compose, intelligence, models, modelsError, presets, t],
  );
  const toggleCategory = (key: keyof AiSettings["dataCategories"], value: boolean): void => {
    onIntelligenceChange({ ...intelligence, dataCategories: { ...intelligence.dataCategories, [key]: value } });
  };
  const usageSub = usage
    ? t("settings.ai.usage.format", {
        calls: numberValue(usage.calls, language),
        cost: numberValue(usage.costUsd, language, 2),
        tokens: numberValue(usage.inputTokens + usage.outputTokens, language),
      })
    : t("settings.ai.loading");

  return (
    <Card className="settings-group" data-testid="settings-ai">
      <CardHeader title={t("settings.groups.ai")} />
      <ItemList variant="nested">
        {!loaded ? <LoadingItem label={t("settings.ai.loading")} /> : null}
        {loaded ? (
          <ListItem
            className="settings-row"
            dataTestId="settings-ai-connection"
            name={t("settings.ai.connection.label")}
            onClick={() => onNavigateToRoute?.({ screen: "settings-ai-connection" })}
            sub={connectionSub(connection, presets, t)}
          />
        ) : null}
        {loaded ? <ListItem className="settings-row" name={t("settings.ai.functions.label")} /> : null}
        {loaded
          ? taskRows.map((row) => (
              <ListItem
                className="settings-row"
                dataTestId={`settings-ai-function-${row.id}`}
                key={row.id}
                name={row.label}
                onClick={() => onNavigateToRoute?.({ screen: "settings-ai-function", task: row.id })}
                sub={row.sub}
              />
            ))
          : null}
        <ListItem
          className="settings-row"
          name={
            <span className="settings-copy">
              <span className="settings-label">{t("settings.ai.categories.label")}</span>
              <span className="settings-description">{t("settings.ai.categories.hint")}</span>
            </span>
          }
        />
        {(
          [
            ["marketplaceContent", "settings.ai.categories.marketplaceContent"],
            ["stackFiles", "settings.ai.categories.stackFiles"],
            ["transcripts", "settings.ai.categories.transcripts"],
            ["processCommands", "settings.ai.categories.processCommands"],
          ] as const
        ).map(([key, labelKey]) => (
          <ListItem
            className="settings-row settings-row--indented"
            key={key}
            name={
              <span className="settings-copy">
                <span className="settings-label">{t(labelKey)}</span>
                {key === "transcripts" || key === "processCommands" ? (
                  <span className="settings-description">{t("settings.ai.categories.disabledByDefault")}</span>
                ) : null}
              </span>
            }
            side={
              <label className="settings-checkbox">
                <input
                  aria-label={t(labelKey)}
                  checked={intelligence.dataCategories[key]}
                  data-testid={`settings-ai-category-${key}`}
                  onChange={(event) => toggleCategory(key, event.target.checked)}
                  type="checkbox"
                />
              </label>
            }
          />
        ))}
        <ListItem className="settings-row" name={t("settings.ai.usage.label")} sub={usageSub} />
      </ItemList>
    </Card>
  );
}
