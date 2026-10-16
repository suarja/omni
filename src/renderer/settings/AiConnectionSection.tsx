import { useEffect, useState, type ReactElement } from "react";

import type {
  AiConnectionResponse,
  AiConnectionTestResponse,
  AiModelView,
  AiPresetView,
} from "../../shared/ai-gateway-ipc";
import type { DesktopApi } from "../../shared/ipc";
import { Icon } from "../components/Icon";
import { Button } from "../components/ui/Button";
import { Callout } from "../components/ui/Callout";
import { Card, CardFoot, CardHeader } from "../components/ui/Card";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { LoadingItem } from "../components/ui/LoadingItem";
import { useI18n } from "../i18n";
import type { Route } from "../navigation";
import { useFeatures } from "../features";
import { formatModelContext } from "./ai-models";

export type AiConnectionSectionProps = Readonly<{
  api: DesktopApi | null;
  onNavigateToRoute: (route: Route) => void;
}>;

function modelSub(model: AiModelView, language: "en" | "fr", t: ReturnType<typeof useI18n>["t"]): string {
  const context = formatModelContext(model.contextWindow, language);
  if (model.contextWindow === 0 && model.cost.input === 0 && model.cost.output === 0)
    return t("settings.ai.functionPage.noPrice", { context });
  return t("settings.ai.functionPage.contextPrice", {
    context,
    input: model.cost.input,
    output: model.cost.output,
  });
}

function presetSub(preset: AiPresetView, t: ReturnType<typeof useI18n>["t"]): string {
  if (preset.keyRequired) return t("settings.ai.connectionPage.keyRequired");
  if (preset.scope === "local") return t("settings.ai.connectionPage.noKeyLocal");
  return t("settings.ai.connectionPage.optionalUrlKey");
}

function presetIcon(preset: AiPresetView): ReactElement {
  return <Icon name={preset.scope === "local" ? "folder" : "remote"} size={16} />;
}

export function AiConnectionSection({ api, onNavigateToRoute }: AiConnectionSectionProps): ReactElement {
  const { language, t } = useI18n();
  const { features } = useFeatures();
  const [presets, setPresets] = useState<readonly AiPresetView[]>([]);
  const [connection, setConnection] = useState<AiConnectionResponse | null>(null);
  const [models, setModels] = useState<readonly AiModelView[]>([]);
  const [testResult, setTestResult] = useState<AiConnectionTestResponse | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [confirmChange, setConfirmChange] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    if (!api?.listAiPresets || !api.getAiConnection) {
      setLoaded(true);
      return () => {
        active = false;
      };
    }
    void Promise.all([api.listAiPresets(), api.getAiConnection()])
      .then(([presetResponse, connectionResponse]) => {
        if (!active) return;
        setPresets(presetResponse.presets);
        setConnection(connectionResponse);
        setBaseUrl(connectionResponse.connection?.baseUrl ?? "");
      })
      .catch((loadError: unknown) => {
        if (active)
          setError(loadError instanceof Error ? loadError.message : t("settings.ai.connectionPage.unavailable"));
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [api, t]);

  const selectPreset = async (preset: AiPresetView): Promise<void> => {
    if (!api?.setAiConnection || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.setAiConnection({
        preset: preset.id,
        ...(preset.id === "custom" && baseUrl ? { baseUrl } : {}),
      });
      setConnection(next);
      setBaseUrl(next.connection?.baseUrl ?? "");
    } catch (selectionError: unknown) {
      setError(selectionError instanceof Error ? selectionError.message : t("settings.ai.connectionPage.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  const saveBaseUrl = async (): Promise<void> => {
    const current = connection?.connection;
    if (!api?.setAiConnection || !current || current.preset !== "custom" || !baseUrl.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.setAiConnection({ preset: "custom", baseUrl: baseUrl.trim() });
      setConnection(next);
      setBaseUrl(next.connection?.baseUrl ?? "");
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : t("settings.ai.connectionPage.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async (): Promise<void> => {
    if (!api?.setAiKey || !keyInput.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.setAiKey({ key: keyInput.trim() });
      if (result.status === "unavailable") setError(result.reason);
      else {
        setKeyInput("");
        const next = await api.getAiConnection?.();
        if (next) setConnection(next);
      }
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : t("settings.ai.connectionPage.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async (): Promise<void> => {
    if (!api?.removeAiKey || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.removeAiKey();
      if (result.status === "unavailable") setError(result.reason);
      else {
        const next = await api.getAiConnection?.();
        if (next) setConnection(next);
      }
    } catch (removeError: unknown) {
      setError(removeError instanceof Error ? removeError.message : t("settings.ai.connectionPage.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  const changeProvider = async (): Promise<void> => {
    if (!api?.removeAiConnection || busy) return;
    setBusy(true);
    setError(null);
    try {
      setConnection(await api.removeAiConnection());
      setTestResult(null);
      setConfirmChange(false);
    } catch (changeError: unknown) {
      setError(changeError instanceof Error ? changeError.message : t("settings.ai.connectionPage.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  const test = async (): Promise<void> => {
    if (!api?.testAiConnection || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.testAiConnection();
      setTestResult(result);
      if (result.status === "reachable") setModels(result.models);
    } catch (testError: unknown) {
      setError(testError instanceof Error ? testError.message : t("settings.ai.connectionPage.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  const navigateBack = (): void => onNavigateToRoute({ screen: "settings" });

  return (
    <div className="shell-page destination-page settings-ai-page" data-testid="settings-ai-connection-page">
      <Button size="small" tone="ghost" onClick={() => onNavigateToRoute({ screen: "settings" })}>
        {t("canvas.back")}
      </Button>
      <h3>{t("settings.ai.connectionPage.title")}</h3>
      {error ? (
        <Callout title={t("settings.ai.connectionPage.unavailable")} tone="error">
          {error}
        </Callout>
      ) : null}
      {!loaded ? <LoadingItem label={t("settings.ai.loading")} /> : null}
      {loaded && !connection?.connection ? (
        <Card>
          <CardHeader title={t("settings.ai.connectionPage.chooseProvider")} />
          <ItemList variant="nested">
            {(features.aiProviders ? presets : presets.filter((preset) => preset.id === "vercel-ai-gateway")).map(
              (preset) => (
                <ListItem
                  key={preset.id}
                  leading={presetIcon(preset)}
                  name={preset.displayName}
                  onClick={() => void selectPreset(preset)}
                  sub={presetSub(preset, t)}
                />
              ),
            )}
          </ItemList>
        </Card>
      ) : null}
      {loaded && connection?.connection ? (
        <>
          <Card>
            <CardHeader title={t("settings.ai.connectionPage.provider")} />
            <ItemList variant="nested">
              <ListItem
                name={connection.connection.displayName}
                sub={connection.scope === "local" ? "local" : undefined}
              />
            </ItemList>
            {connection.connection.preset === "custom" ? (
              <div className="settings-form-row">
                <label>
                  <span className="settings-label">{t("settings.ai.connectionPage.baseUrl")}</span>
                  <input
                    aria-label={t("settings.ai.connectionPage.baseUrl")}
                    data-testid="settings-ai-base-url"
                    onChange={(event) => setBaseUrl(event.target.value)}
                    type="url"
                    value={baseUrl}
                  />
                </label>
                <Button disabled={busy || !baseUrl.trim()} onClick={() => void saveBaseUrl()} size="small">
                  {t("settings.ai.connectionPage.saveBaseUrl")}
                </Button>
              </div>
            ) : null}
            <CardFoot>
              {!confirmChange ? (
                <Button onClick={() => setConfirmChange(true)} size="small" tone="ghost">
                  {t("settings.ai.connectionPage.changeProvider")}
                </Button>
              ) : (
                <Callout title={t("settings.ai.connectionPage.changeProvider")} tone="warning">
                  <p>{t("settings.ai.connectionPage.confirmChange")}</p>
                  <div className="settings-inline-actions">
                    <Button disabled={busy} onClick={() => void changeProvider()} size="small">
                      {t("settings.ai.connectionPage.confirm")}
                    </Button>
                    <Button onClick={() => setConfirmChange(false)} size="small" tone="ghost">
                      {t("settings.ai.connectionPage.cancel")}
                    </Button>
                  </div>
                </Callout>
              )}
            </CardFoot>
          </Card>
          <Card>
            <CardHeader title={t("settings.ai.connectionPage.key")} />
            {connection.scope === "local" ? (
              <ItemList variant="nested">
                <ListItem name={t("settings.ai.connectionPage.noKeyNeeded")} />
              </ItemList>
            ) : (
              <>
                <ItemList variant="nested">
                  <ListItem
                    name={t(
                      connection.keyState === "set"
                        ? "settings.ai.connectionPage.keySaved"
                        : "settings.ai.connectionPage.noKey",
                    )}
                    sub={t("settings.ai.connectionPage.keyDescription")}
                  />
                </ItemList>
                <div className="settings-form-row">
                  <label>
                    <span className="settings-label">{t("settings.ai.connectionPage.key")}</span>
                    <input
                      aria-label={t("settings.ai.connectionPage.key")}
                      data-testid="settings-ai-key-input"
                      onChange={(event) => setKeyInput(event.target.value)}
                      placeholder={
                        presets.find((preset) => preset.id === connection.connection?.preset)?.keyPlaceholder
                      }
                      type="password"
                      value={keyInput}
                    />
                  </label>
                  {keyInput.trim() ? (
                    <Button disabled={busy} onClick={() => void saveKey()} size="small">
                      {t("settings.ai.connectionPage.saveKey")}
                    </Button>
                  ) : null}
                </div>
                {connection.keyState === "set" ? (
                  <CardFoot>
                    <Button disabled={busy} onClick={() => void removeKey()} size="small" tone="ghost">
                      {t("settings.ai.connectionPage.removeKey")}
                    </Button>
                  </CardFoot>
                ) : null}
              </>
            )}
          </Card>
          <Card>
            <CardHeader
              actions={
                <Button dataTestId="settings-ai-test" disabled={busy} onClick={() => void test()} size="small">
                  {t("settings.ai.connectionPage.test")}
                </Button>
              }
              title={t("settings.ai.connectionPage.models")}
            />
            {testResult?.status === "key-missing" ? (
              <Callout title={t("settings.ai.connectionPage.models")} tone="warning">
                {t("settings.ai.connectionPage.testKeyMissing")}
              </Callout>
            ) : null}
            {testResult?.status === "unreachable" ? (
              <Callout title={t("settings.ai.connectionPage.models")} tone="error">
                {t("settings.ai.connectionPage.testUnavailable", { reason: testResult.reason })}
              </Callout>
            ) : null}
            {testResult?.status === "reachable" ? (
              <ItemList variant="nested">
                {models.length ? (
                  models.map((model) => (
                    <ListItem key={model.id} name={model.name} sub={modelSub(model, language, t)} />
                  ))
                ) : (
                  <ListItem name={t("settings.ai.connectionPage.noModels")} />
                )}
              </ItemList>
            ) : null}
          </Card>
        </>
      ) : null}
    </div>
  );
}
