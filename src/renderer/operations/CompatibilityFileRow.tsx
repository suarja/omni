import type { ReactElement } from "react";
import type { OperationAction } from "../../shared/operations-ipc";
import type { TranslationFunction } from "../i18n";
import { DiffLines } from "../canvas/changes/DiffLines";
import { parseDiffLines } from "../canvas/changes/diff-lines";
import { formatByteSize } from "./operations-import-plan";

type FileRowProps = Readonly<{
  action: OperationAction;
  choiceIndex: number;
  takeMarketplace: boolean;
  expanded: boolean;
  marketplaceName: string;
  t: TranslationFunction;
  onKeepUpdate: (choice: boolean) => void;
  onToggleDiff: () => void;
}>;

function FileControls(props: FileRowProps): ReactElement {
  const { t } = props;
  return (
    <div className="changes-diff-toolbar compatibility-file-controls">
      <div role="group" aria-label={props.action.relativePath}>
        <button
          type="button"
          aria-pressed={!props.takeMarketplace}
          data-testid={`compatibility-update-local-${props.choiceIndex}`}
          onClick={() => props.onKeepUpdate(false)}
        >
          {t("operations.compatible.keepLocal")}
        </button>
        <button
          type="button"
          aria-pressed={props.takeMarketplace}
          data-testid={`compatibility-update-keep-${props.choiceIndex}`}
          onClick={() => props.onKeepUpdate(true)}
        >
          {t("operations.compatible.takeMarketplace", { marketplace: props.marketplaceName })}
        </button>
      </div>
      <button
        className="compatibility-diff-toggle"
        type="button"
        aria-expanded={props.expanded}
        aria-controls={`compatibility-diff-panel-${props.choiceIndex}`}
        data-testid={`compatibility-diff-${props.choiceIndex}`}
        onClick={props.onToggleDiff}
      >
        {t("operations.compatible.showDiff")}
      </button>
    </div>
  );
}

function FileDiff(props: FileRowProps): ReactElement {
  const excerpt = parseDiffLines(props.action.diff!);
  const { t } = props;
  return (
    <div id={`compatibility-diff-panel-${props.choiceIndex}`}>
      <DiffLines
        lines={excerpt.lines}
        layout="unified"
        beforeLabel={t("operations.compatible.keepLocal")}
        afterLabel={props.marketplaceName}
        layoutLabel={t("skillManagement.unified")}
      />
      {excerpt.summary ? <p className="changes-note">{excerpt.summary}</p> : null}
      {excerpt.truncated ? <p className="changes-note">{t("skillManagement.diffTruncated")}</p> : null}
    </div>
  );
}

export function CompatibilityFileRow(props: FileRowProps): ReactElement {
  const update = props.action.diff !== undefined;
  return (
    <article className="compatibility-file">
      <header>
        <code>{props.action.relativePath}</code>
        <small>{props.t(update ? "operations.compatible.update" : "operations.compatible.add")}</small>
        {props.action.byteLength === undefined ? null : <small>{formatByteSize(props.action.byteLength)}</small>}
      </header>
      {update ? <FileControls {...props} /> : null}
      {update && props.expanded ? <FileDiff {...props} /> : null}
    </article>
  );
}
