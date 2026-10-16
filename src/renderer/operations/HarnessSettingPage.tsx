import { useEffect, useState, type ReactElement } from "react";

import type { DesktopApi } from "../../shared/ipc";
import type { OperationPlan, PreviewMarketplaceResponse } from "../../shared/operations-ipc";
import { Breadcrumbs } from "../components/ui/Breadcrumbs";
import { Button } from "../components/ui/Button";
import { Card, CardHeader } from "../components/ui/Card";
import { Callout } from "../components/ui/Callout";
import { FooterBar } from "../components/ui/FooterBar";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { useI18n } from "../i18n";
import type { Route } from "../navigation";
import { UnifiedDiff } from "./lifecycle-ui";

type CleanupOption = "off" | "7" | "14" | "30";
type PreviewState =
  Readonly<{ kind: "ready"; plan: OperationPlan }> | Readonly<{ kind: "blocked"; reason: string; diagnostic: string }>;

function valueOf(option: CleanupOption): number | null {
  return option === "off" ? null : Number(option);
}

export type HarnessSettingPageProps = Readonly<{
  api: DesktopApi | null;
  returnTo: Route;
  onNavigateToRoute: (route: Route) => void;
}>;

// D6 — worktree hygiene: Claude Code's own `cleanupPeriodDays` setting, written through a
// previewed operation (register-mcp's grammar: diff toggle, "written only when you confirm").
// Codex has no equivalent setting yet, so its row is informational only.
export function HarnessSettingPage({ api, onNavigateToRoute, returnTo }: HarnessSettingPageProps): ReactElement {
  const { t } = useI18n();
  const [selected, setSelected] = useState<CleanupOption>("off");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [showDiff, setShowDiff] = useState(true);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (applied || !api?.previewOperation) {
      if (!api?.previewOperation) setError(t("operations.unavailable"));
      return;
    }
    setBusy(true);
    setError(null);
    void api
      .previewOperation({
        kind: "write-harness-setting",
        harness: "claude-code",
        key: "cleanupPeriodDays",
        value: valueOf(selected),
      })
      .then((result: PreviewMarketplaceResponse) =>
        setPreview(
          result.status === "ready"
            ? { kind: "ready", plan: result.plan }
            : { kind: "blocked", reason: result.reason, diagnostic: result.diagnostic },
        ),
      )
      .catch((previewError: unknown) =>
        setError(previewError instanceof Error ? previewError.message : t("operations.unavailable")),
      )
      .finally(() => setBusy(false));
  }, [api, applied, selected, t]);

  const apply = async (): Promise<void> => {
    if (!api?.applyOperation || preview?.kind !== "ready" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.applyOperation({ planId: preview.plan.planId });
      setApplied(true);
      setPreview(null);
    } catch (applyError: unknown) {
      setError(applyError instanceof Error ? applyError.message : t("operations.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  const actionPlan = preview?.kind === "ready" ? preview.plan.actions[0] : undefined;

  if (applied)
    return (
      <div className="shell-page destination-page operation-page" data-testid="harness-setting-page">
        <Breadcrumbs
          items={[
            { label: t("activity.worktreesHeading"), onClick: () => onNavigateToRoute(returnTo) },
            { label: t("operations.harnessSetting.heading") },
          ]}
        />
        <div data-testid="harness-setting-result">
          <Card>
            <CardHeader title={t("operations.harnessSetting.result")} />
          </Card>
        </div>
        <FooterBar
          actions={
            <Button onClick={() => onNavigateToRoute(returnTo)} tone="ghost">
              {t("operations.back")}
            </Button>
          }
        />
      </div>
    );

  return (
    <div className="shell-page destination-page operation-page" data-testid="harness-setting-page">
      <Breadcrumbs
        items={[
          { label: t("activity.worktreesHeading"), onClick: () => onNavigateToRoute(returnTo) },
          { label: t("operations.harnessSetting.heading") },
        ]}
      />
      <Card>
        <CardHeader title={t("operations.harnessSetting.claudeCodeHeading")} />
        <ItemList variant="nested">
          <ListItem name={t("operations.harnessSetting.claudeCodeDescription")} />
        </ItemList>
        <div className="compatibility-report__controls">
          <SegmentedControl
            ariaLabel={t("operations.harnessSetting.claudeCodeHeading")}
            onValueChange={(value: CleanupOption) => {
              setApplied(false);
              setSelected(value);
            }}
            options={[
              { label: t("operations.harnessSetting.off"), value: "off" },
              { label: t("operations.harnessSetting.days", { count: 7 }), value: "7" },
              { label: t("operations.harnessSetting.days", { count: 14 }), value: "14" },
              { label: t("operations.harnessSetting.days", { count: 30 }), value: "30" },
            ]}
            value={selected}
          />
        </div>
      </Card>
      <Card>
        <CardHeader title={t("operations.harnessSetting.codexHeading")} />
        <ItemList variant="nested">
          <ListItem dim name={t("operations.harnessSetting.codexUnavailable")} />
        </ItemList>
      </Card>
      {error ? (
        <Callout title={t("operations.harnessSetting.previewUnavailable")} tone="error">
          {error}
        </Callout>
      ) : null}
      {preview?.kind === "blocked" ? (
        <Callout title={t("operations.harnessSetting.previewBlocked")} tone="warning">
          {preview.reason}: {preview.diagnostic}
        </Callout>
      ) : null}
      {preview?.kind === "ready" ? (
        <div data-testid="harness-setting-change-card">
          <Card>
            <CardHeader title={t("operations.harnessSetting.whatWillChange")} />
            {actionPlan ? (
              <>
                <div className="compatibility-report__controls">
                  <Button
                    ariaExpanded={showDiff}
                    dataTestId="harness-setting-diff-toggle"
                    onClick={() => setShowDiff((open) => !open)}
                    size="small"
                    tone="ghost"
                  >
                    {t(showDiff ? "operations.harnessSetting.hideDiff" : "operations.harnessSetting.showDiff")}
                  </Button>
                </div>
                {actionPlan.diff && showDiff ? <UnifiedDiff text={actionPlan.diff} truncated={false} /> : null}
              </>
            ) : (
              <ItemList variant="nested">
                <ListItem dim name={t("operations.harnessSetting.nothingToChange")} />
              </ItemList>
            )}
          </Card>
        </div>
      ) : null}
      <FooterBar
        note={t("operations.harnessSetting.confirmNote")}
        actions={
          <Button dataTestId="harness-setting-apply" disabled={busy || !actionPlan} onClick={() => void apply()}>
            {t("operations.harnessSetting.apply")}
          </Button>
        }
      />
    </div>
  );
}
