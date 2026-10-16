import { useState, type ReactElement } from "react";

import type { ActivityPreviewResponse } from "../../shared/activity-ipc";
import type { DesktopApi } from "../../shared/ipc";
import { Button } from "../components/ui/Button";
import { Card, CardHeader } from "../components/ui/Card";
import { FooterBar } from "../components/ui/FooterBar";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { tCount, useI18n, type TranslationKey } from "../i18n";

// One card for every process action a session or process-page head can preview (D5): stop, the
// three signals (kill/pause/resume), renice, and worktree removal. Each kind supplies its own
// copy ("Pause the session and its 4 processes", …) but shares the preview → confirm → apply →
// result flow.
export type ActivityActionKind = "stop" | "kill" | "pause" | "resume" | "renice" | "remove-worktree";
export type ActivityActionState = Readonly<{
  response: ActivityPreviewResponse;
  kind: ActivityActionKind;
}>;

const CONFIRM_LABEL_KEY: Readonly<Record<ActivityActionKind, TranslationKey>> = {
  stop: "activity.stop",
  kill: "activity.kill",
  pause: "activity.pause",
  resume: "activity.resume",
  renice: "activity.renice",
  "remove-worktree": "activity.remove",
};
// Kill/pause/resume/renice state the process count in the title itself ("Pause 4 processes"),
// matching the copy the brief specified ("Pause the session and its 4 processes"); stop and
// worktree removal keep their existing, count-free copy ("as today").
const PREVIEW_COUNT_KEY: Readonly<Partial<Record<ActivityActionKind, string>>> = {
  kill: "activity.killCount",
  pause: "activity.pauseCount",
  resume: "activity.resumeCount",
  renice: "activity.reniceCount",
};
const PREVIEW_TITLE_KEY: Readonly<Partial<Record<ActivityActionKind, TranslationKey>>> = {
  stop: "activity.whatWillBeStopped",
  "remove-worktree": "activity.whatWillBeRemoved",
};
const RESULT_TITLE_KEY: Readonly<Record<ActivityActionKind, TranslationKey>> = {
  stop: "activity.processStopped",
  kill: "activity.processKilled",
  pause: "activity.processPaused",
  resume: "activity.processResumed",
  renice: "activity.processReniced",
  "remove-worktree": "activity.worktreeRemoved",
};

export function ActivityActionCard({
  action,
  api,
  onCancel,
  onDone,
}: Readonly<{
  action: ActivityActionState;
  api: { applyActivity: NonNullable<DesktopApi["applyActivity"]> };
  onCancel: () => void;
  onDone: () => void;
}>): ReactElement {
  const { language, t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"applied" | "failed" | null>(null);
  const dataTestSuffix = action.kind === "remove-worktree" ? "remove" : action.kind;

  if (action.response.status === "blocked") {
    return (
      <Card className="activity-action-card">
        <CardHeader title={t("activity.actionBlocked")} />
        <ItemList variant="nested">
          <ListItem name={action.response.diagnostic} />
        </ItemList>
        <FooterBar
          actions={
            <Button onClick={onCancel} size="small" tone="ghost">
              {t("activity.cancel")}
            </Button>
          }
        />
      </Card>
    );
  }

  const plan = action.response.plan;
  const apply = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await api.applyActivity({ planId: plan.planId });
      setResult(response.status);
      onDone();
    } catch {
      setResult("failed");
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Card className="activity-action-card">
        <CardHeader title={t(result === "applied" ? RESULT_TITLE_KEY[action.kind] : "activity.actionFailed")} />
        <FooterBar
          actions={
            <Button onClick={onCancel} size="small" tone="ghost">
              {t("activity.close")}
            </Button>
          }
        />
      </Card>
    );
  }

  const countKey = PREVIEW_COUNT_KEY[action.kind];
  const previewTitle = countKey
    ? tCount(countKey, plan.actions.length, {}, language)
    : t(PREVIEW_TITLE_KEY[action.kind] ?? "activity.whatWillBeStopped");
  return (
    <Card className="activity-action-card">
      <CardHeader title={previewTitle} />
      <ItemList variant="nested">
        {plan.actions.map((item, index) => (
          <ListItem
            key={`${plan.planId}-${index}`}
            name={"pid" in item ? item.command : item.worktreeId}
            sub={"pid" in item ? `${t("activity.pid")} ${item.pid} · ${item.cpuPercent} %` : undefined}
          />
        ))}
      </ItemList>
      <FooterBar
        actions={
          <>
            <Button
              dataTestId={`activity-confirm-${dataTestSuffix}`}
              disabled={busy}
              onClick={() => void apply()}
              size="small"
            >
              {t(CONFIRM_LABEL_KEY[action.kind])}
            </Button>
            <Button disabled={busy} onClick={onCancel} size="small" tone="ghost">
              {t("activity.cancel")}
            </Button>
          </>
        }
      />
    </Card>
  );
}
