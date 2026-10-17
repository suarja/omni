import { LoadingSkeleton } from "../../components/ui/Skeleton";
import { harnessLabel } from "../project-view-model";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import type { SkillLocationKey } from "../../../domain/skill-reconciliation/types";
import type { EntryRef } from "../../../domain/project-source-registry";
import type { DesktopApi } from "../../../shared/ipc";
import type { SkillCopyComparisonResponse } from "../../../shared/skill-copy-comparison-ipc";
import { useI18n } from "../../i18n";
import { SheetFrame } from "../SheetFrame";
import { CopyComparisonContent } from "./CopyComparisonContent";
import { useSkillCopyComparison, type SkillCopyComparisonPair } from "./use-skill-copy-comparison";
import "./changes.css";

type ComparisonApi = Pick<DesktopApi, "compareSkillCopies">;
type ReadyResponse = Extract<SkillCopyComparisonResponse, { status: "ready" }>;
type CopyRead = ReadyResponse["a"]["read"];
type ComparisonTab = "diff" | "targets" | "result";

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify(location);
}

function locationLabel(location: SkillLocationKey): string {
  return `${harnessLabel(location.harnessId)} · ${location.folderPath}`;
}

function readLabel(read: CopyRead, t: ReturnType<typeof useI18n>["t"]): string {
  return read.status === "complete" ? t("skillManagement.copyReadComplete") : t("skillManagement.copyReadUnavailable");
}

function unavailableLabel(
  reason: Extract<SkillCopyComparisonResponse, { status: "unavailable" }>["reason"],
  t: ReturnType<typeof useI18n>["t"],
): string {
  const key = {
    grant: "skillManagement.comparisonUnavailableGrant",
    root: "skillManagement.comparisonUnavailableRoot",
    store: "skillManagement.comparisonUnavailableStore",
    membership: "skillManagement.comparisonUnavailableMembership",
    read: "skillManagement.comparisonUnavailableRead",
  } as const;
  return t(key[reason]);
}

export function SkillCopyComparisonWorkbench(
  props: Readonly<{
    api: ComparisonApi | null;
    projectId: string;
    skillId: string;
    locations: readonly SkillLocationKey[];
    initialLeft: SkillLocationKey;
    initialPair?: SkillCopyComparisonPair;
    onEnsureGrant: (entry: EntryRef) => Promise<string | null>;
    onBack: () => void;
    onClose: () => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<ComparisonTab>("diff");
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const comparison = useSkillCopyComparison({
    api: props.api,
    projectId: props.projectId,
    skillId: props.skillId,
    locations: props.locations,
    initialLeft: props.initialLeft,
    initialPair: props.initialPair,
    onEnsureGrant: props.onEnsureGrant,
  });
  const response = comparison.state.status === "ready" ? comparison.state.response : undefined;
  const unavailableResponse = comparison.state.status === "unavailable" ? comparison.state.response : undefined;
  const targetResponse = response ?? unavailableResponse;
  const pair = comparison.pair;
  useEffect(() => closeRef.current?.focus(), []);

  const handleTabs = (event: KeyboardEvent<HTMLElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]:not(:disabled)")];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[index]?.click();
    buttons[index]?.focus();
  };

  return (
    <SheetFrame
      title={t("skillManagement.compareCopies")}
      kicker={props.skillId}
      className="changes-workbench"
      testId="skill-copy-comparison-workbench"
      modal
      busy={false}
      onClose={props.onClose}
      closeRef={closeRef}
      closeLabel={t("skillManagement.closeComparison")}
      resizeKind="changes"
      headerClassName="changes-header"
      tabs={
        <nav
          aria-label={t("skillManagement.compareCopies")}
          className="changes-tabs"
          onKeyDown={handleTabs}
          role="tablist"
        >
          {(["diff", "targets", "result"] as const).map((name) => (
            <button
              aria-controls={`copy-comparison-panel-${name}`}
              aria-selected={tab === name}
              disabled={name === "result"}
              id={`copy-comparison-tab-${name}`}
              key={name}
              onClick={() => setTab(name)}
              role="tab"
              tabIndex={tab === name ? 0 : -1}
              type="button"
            >
              {t(`skillManagement.${name}`)}
            </button>
          ))}
        </nav>
      }
      footer={
        <div className="changes-actions">
          <span>{t("skillManagement.comparisonReadOnly")}</span>
          <button className="changes-secondary" onClick={comparison.refresh} type="button">
            {t(
              comparison.state.status === "unavailable"
                ? "skillManagement.retryComparison"
                : "skillManagement.refreshComparison",
            )}
          </button>
          <button className="changes-secondary" onClick={props.onBack} type="button">
            {t("skillManagement.backToCopies")}
          </button>
        </div>
      }
    >
      <div className="changes-comparison-pair">
        {(["a", "b"] as const).map((side) => {
          const location = pair?.[side];
          const other = pair?.[side === "a" ? "b" : "a"];
          return (
            <label key={side}>
              <span>{t(side === "a" ? "skillManagement.copyA" : "skillManagement.copyB")}</span>
              <select
                aria-label={t(side === "a" ? "skillManagement.copyA" : "skillManagement.copyB")}
                disabled={!pair}
                value={location ? locationKey(location) : ""}
                onChange={(event) => {
                  const next = props.locations.find((candidate) => locationKey(candidate) === event.target.value);
                  if (next) comparison.selectSide(side, next);
                }}
              >
                {props.locations.map((candidate) => (
                  <option
                    disabled={Boolean(other && locationKey(candidate) === locationKey(other))}
                    key={locationKey(candidate)}
                    value={locationKey(candidate)}
                  >
                    {locationLabel(candidate)}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>

      <div
        aria-labelledby={`copy-comparison-tab-${tab}`}
        className="changes-body"
        data-testid={`copy-comparison-panel-${tab}`}
        id={`copy-comparison-panel-${tab}`}
        role="tabpanel"
        tabIndex={0}
      >
        {comparison.state.status === "loading" ? (
          <LoadingSkeleton label={t("skillManagement.comparisonLoading")} variant="document" />
        ) : null}
        {comparison.state.status === "unavailable" ? (
          <p className="changes-error" role="alert">
            {unavailableLabel(comparison.state.reason, t)}
          </p>
        ) : null}
        {tab === "targets" ? (
          <section aria-label={t("skillManagement.targets")} className="changes-comparison-targets">
            <h3>{t("skillManagement.targets")}</h3>
            {pair ? (
              <>
                <p>
                  <strong>{t("skillManagement.copyA")}</strong> · <code>{locationLabel(pair.a)}</code>
                </p>
                {targetResponse?.a ? <p>{readLabel(targetResponse.a.read, t)}</p> : null}
                <p>
                  <strong>{t("skillManagement.copyB")}</strong> · <code>{locationLabel(pair.b)}</code>
                </p>
                {targetResponse?.b ? <p>{readLabel(targetResponse.b.read, t)}</p> : null}
              </>
            ) : null}
            <p>{t("skillManagement.comparisonSourceUnknown")}</p>
            <p>{t("skillManagement.comparisonBaseUnknown")}</p>
          </section>
        ) : null}
        {tab === "diff" && response ? (
          <CopyComparisonContent
            copyALabel={t("skillManagement.copyA")}
            copyBLabel={t("skillManagement.copyB")}
            layout={layout}
            onLayoutChange={setLayout}
            onSelectFile={comparison.selectFile}
            response={response}
            selectedPath={comparison.state.selectedPath}
          />
        ) : null}
      </div>
    </SheetFrame>
  );
}
