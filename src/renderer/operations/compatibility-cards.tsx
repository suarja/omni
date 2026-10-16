import type { ReactElement } from "react";

import type { OperationAction, OperationPlan, OperationReceipt } from "../../shared/operations-ipc";
import { Button } from "../components/ui/Button";
import { WorkflowFooter } from "../canvas/changes/WorkflowFooter";
import { tCount, type TranslationFunction } from "../i18n";
import type { Route } from "../navigation";
import { CompatibilityFileRow } from "./CompatibilityFileRow";

type Harness = "claude-code" | "codex";
type ReportPackage = NonNullable<OperationPlan["report"]>["packages"][number];

function harnessLabel(harness: Harness, t: TranslationFunction): string {
  return t(harness === "claude-code" ? "operations.harness.claudeCode" : "operations.harness.codex");
}

function otherHarness(harness: Harness, t: TranslationFunction): string {
  return harnessLabel(harness === "codex" ? "claude-code" : "codex", t);
}

function isOmniManifest(action: OperationAction): boolean {
  const name = action.relativePath.split("/").at(-1) ?? "";
  return action.kind === "write-file" && name.startsWith("omni.") && name.endsWith(".json");
}

function gitLabel(plan: OperationPlan, marketplaceName: string, t: TranslationFunction): string {
  if (plan.git.mode === "commit") return t("operations.preview.gitCommit", { target: marketplaceName });
  if (plan.git.mode === "not-a-repository") return t("operations.compatible.gitNotRepository");
  if (plan.git.mode === "disabled") return t("operations.compatible.gitDisabled");
  return plan.git.warnings[0] ?? t("operations.preview.gitNoCommit");
}

function reportSummary(
  packageInfo: ReportPackage,
  harness: Harness,
  language: "en" | "fr",
  t: TranslationFunction,
): string {
  if (packageInfo.verdict === "ready" && packageInfo.alreadyCompatible) {
    return t("operations.compatible.alreadyCompatible");
  }
  if (packageInfo.verdict === "ready") {
    return tCount("operations.compatible.ready", packageInfo.artifacts.length, {}, language);
  }
  if (packageInfo.verdict === "partial") {
    // The badge already says "partial": the line says what stays behind.
    const excluded = packageInfo.artifacts.filter((artifact) => artifact.status !== "transposable").length;
    return tCount("operations.compatible.partial", excluded, { harness: otherHarness(harness, t) }, language);
  }
  if (packageInfo.verdict === "remote") {
    return packageInfo.reason?.toLowerCase().includes("hand")
      ? t("operations.compatible.remoteHand")
      : t("operations.compatible.remoteCopied");
  }
  return packageInfo.reason ?? t("operations.compatible.blocked");
}

export function ReportCard({
  harness,
  language,
  plan,
  t,
}: Readonly<{
  harness: Harness;
  language: "en" | "fr";
  plan: OperationPlan;
  t: TranslationFunction;
}>): ReactElement {
  const packages = plan.report?.packages ?? [];
  const compatible = packages.filter((item) => item.verdict === "ready" && item.alreadyCompatible);
  const remote = packages.filter((item) => item.verdict === "remote" && !item.reason?.toLowerCase().includes("hand"));
  const listed = packages.filter((item) => !compatible.includes(item) && !remote.includes(item));
  const groups = [
    { key: "remote", items: remote, label: "operations.compatible.remoteCopiedCount" },
    { key: "compatible", items: compatible, label: "operations.compatible.alreadyCompatibleCount" },
  ].filter((group) => group.items.length);
  return (
    <section className="compatibility-effects" data-testid="compatibility-report">
      <h3>{t("operations.compatible.report")}</h3>
      {listed.map((item) => (
        <div className="compatibility-effect" key={item.packageId}>
          <strong>{item.name}</strong>
          {item.verdict === "partial" || item.verdict === "blocked" ? (
            <span className="changes-note">
              {t(item.verdict === "blocked" ? "operations.compatible.blocked" : "operations.compatible.partialLabel")}
            </span>
          ) : null}
          <p className="changes-note">{reportSummary(item, harness, language, t)}</p>
          {item.verdict === "partial" ? (
            <details className="propagation-details" data-testid={`compatibility-report-details-${item.packageId}`}>
              <summary>{t("operations.compatible.details")}</summary>
              <div data-testid="compatibility-report-exclusions">
                {item.artifacts
                  .filter((artifact) => artifact.status !== "transposable")
                  .map((artifact) => (
                    <p key={artifact.path}>
                      <code>{artifact.path}</code> · {artifact.reason ?? t("operations.compatible.noReason")}
                    </p>
                  ))}
              </div>
            </details>
          ) : null}
        </div>
      ))}
      {groups.map((group) => (
        <details
          className="propagation-details"
          key={group.key}
          data-testid={`compatibility-report-details-${group.key}`}
        >
          <summary>
            {tCount(group.label, group.items.length, {}, language)} · {t("operations.compatible.details")}
          </summary>
          <div data-testid={`compatibility-report-${group.key}`}>
            {group.items.map((item) => (
              <p key={item.packageId}>{item.name}</p>
            ))}
          </div>
        </details>
      ))}
    </section>
  );
}

export function WriteCard({
  keepUpdates,
  onKeepUpdate,
  onToggleDiff,
  expandedDiffs,
  language,
  marketplaceName,
  plan,
  t,
}: Readonly<{
  keepUpdates: readonly string[];
  onKeepUpdate: (path: string, checked: boolean) => void;
  onToggleDiff: (path: string) => void;
  expandedDiffs: Readonly<Record<string, boolean>>;
  language: "en" | "fr";
  marketplaceName: string;
  plan: OperationPlan;
  t: TranslationFunction;
}>): ReactElement {
  const omni = plan.actions.filter(isOmniManifest);
  // Directories are implied by the file rows; Omni records stay in closed Details.
  const files = plan.actions.filter((action) => !isOmniManifest(action) && action.kind !== "create-directory");
  let updateIndex = 0;
  return (
    <section data-testid="compatibility-writes" className="compatibility-files">
      <h3>{t("operations.compatible.whatWillBeWritten")}</h3>
      <div className="changes-file-list">
        {files.map((action, index) => {
          const update = action.diff !== undefined;
          return (
            <CompatibilityFileRow
              action={action}
              key={`${action.relativePath}-${index}`}
              choiceIndex={update ? updateIndex++ : -1}
              takeMarketplace={keepUpdates.includes(action.relativePath)}
              expanded={Boolean(expandedDiffs[action.relativePath])}
              marketplaceName={marketplaceName}
              t={t}
              onKeepUpdate={(choice) => onKeepUpdate(action.relativePath, choice)}
              onToggleDiff={() => onToggleDiff(action.relativePath)}
            />
          );
        })}
      </div>
      {omni.length ? (
        <details className="propagation-details" data-testid="compatibility-omni-details">
          <summary>
            {tCount("operations.compatible.omniManifests", omni.length, {}, language)} ·{" "}
            {t("operations.compatible.details")}
          </summary>
          <div className="compatibility-manifests" data-testid="compatibility-omni-list">
            {omni.map((action) => (
              <code key={action.relativePath}>{action.relativePath}</code>
            ))}
          </div>
        </details>
      ) : null}
      <details className="propagation-details">
        <summary>{t("operations.compatible.details")}</summary>
        <p className="changes-note">
          {t("operations.compatible.git")} · {gitLabel(plan, marketplaceName, t)}
        </p>
      </details>
    </section>
  );
}

function resultSummary(
  receipt: OperationReceipt,
  updateActions: readonly OperationAction[],
  keepUpdates: readonly string[],
  language: "en" | "fr",
  t: TranslationFunction,
): string {
  const written = receipt.actions.filter(
    (action) => action.status === "applied" && action.kind === "write-file",
  ).length;
  const kept = updateActions.filter((action) => !keepUpdates.includes(action.relativePath)).length;
  return [
    tCount("operations.compatible.filesWritten", written, {}, language),
    tCount("operations.compatible.kept", kept, {}, language),
    t("operations.compatible.backupsSaved"),
  ].join(" · ");
}

export function ResultCard({
  keepUpdates,
  onNavigateToRoute,
  plan,
  receipt,
  returnTo,
  language,
  t,
}: Readonly<{
  keepUpdates: readonly string[];
  onNavigateToRoute: (route: Route) => void;
  plan: OperationPlan;
  receipt: OperationReceipt;
  returnTo: Route;
  language: "en" | "fr";
  t: TranslationFunction;
}>): ReactElement {
  const applied = receipt.status === "applied";
  const updateActions = plan.actions.filter((action) => action.diff !== undefined);
  return (
    <>
      <section className={`changes-result${applied ? "" : " is-failed"}`} data-testid="compatibility-result">
        <header>
          <strong>
            {applied
              ? resultSummary(receipt, updateActions, keepUpdates, language, t)
              : t("operations.compatible.failed")}
          </strong>
          <small>{t(applied ? "operations.applied" : "operations.failed")}</small>
        </header>
        {applied ? (
          <details className="propagation-details">
            <summary>{t("operations.compatible.details")}</summary>
            <p>
              {t("operations.commit")} · <code>{receipt.git.commit?.slice(0, 7) ?? t("operations.noCommit")}</code>
            </p>
          </details>
        ) : (
          <p className="changes-issue">
            {t("operations.compatible.diagnostic")} · {receipt.diagnostic ?? t("operations.failed")}
          </p>
        )}
      </section>
      <WorkflowFooter
        actions={
          <Button
            dataTestId="compatibility-result-open"
            onClick={() => onNavigateToRoute(returnTo)}
            tone={applied ? "primary" : "ghost"}
          >
            {applied ? t("operations.compatible.openMarketplace") : t("operations.back")}
          </Button>
        }
      />
    </>
  );
}
