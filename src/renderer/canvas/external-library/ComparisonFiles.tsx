import { useState, type ReactElement } from "react";
import type { ExternalComparison } from "../../../shared/external-library-ipc";
import { createUnifiedDiff } from "../../../domain/unified-diff";
import { useI18n } from "../../i18n";
import { changedFiles } from "./presentation";
import { FileChange } from "../changes/FileChange";

export function ComparisonFiles(
  props: Readonly<{
    busy?: boolean;
    comparison: ExternalComparison;
    choices: Readonly<Record<string, "mine" | "source">>;
    onChoice: (path: string, value: "mine" | "source") => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  return (
    <div className="external-rows">
      {changedFiles(props.comparison).map((file) => {
        const conflict = file.classification === "conflict";
        const local = ["workshop-changed", "added-in-workshop", "removed-in-workshop"].includes(file.classification);
        const diff =
          file.copy?.binary || file.source?.binary
            ? undefined
            : createUnifiedDiff(file.path, file.path, file.copy?.text ?? "", file.source?.text ?? "").text;
        return (
          <div key={file.path}>
            <div className="external-row">
              <div>
                <b>{file.path}</b>
                <small>
                  {t(
                    conflict
                      ? "externalLibrary.both"
                      : local
                        ? "externalLibrary.localOnly"
                        : "externalLibrary.sourceOnly",
                  )}
                </small>
              </div>
              {conflict ? (
                <div className="new-skill-segment" role="group" aria-label={file.path}>
                  {(["mine", "source"] as const).map((choice) => (
                    <button
                      type="button"
                      key={choice}
                      disabled={props.busy}
                      aria-pressed={props.choices[file.path] === choice}
                      onClick={() => props.onChoice(file.path, choice)}
                    >
                      {t(choice === "mine" ? "externalLibrary.mineFile" : "externalLibrary.sourceFile")}
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  className="canvas-secondary-button is-small is-ghost"
                  aria-expanded={expanded.has(file.path)}
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(file.path)) next.delete(file.path);
                      else next.add(file.path);
                      return next;
                    })
                  }
                >
                  {t("externalLibrary.diff")}
                </button>
              )}
            </div>
            {expanded.has(file.path) ? (
              <>
                <div className="external-filters">
                  {(["unified", "split"] as const).map((value) => (
                    <button type="button" key={value} aria-pressed={value === layout} onClick={() => setLayout(value)}>
                      {t(`skillManagement.${value}`)}
                    </button>
                  ))}
                </div>
                <FileChange
                  file={{
                    rootId: props.comparison.useId,
                    relativePath: file.path,
                    change: !file.copy ? "add" : !file.source ? "delete" : "change",
                    beforeHash: file.copy?.hash,
                    afterHash: file.source?.hash,
                    ...(diff ? { diff } : {}),
                  }}
                  layout={layout}
                  rootName={file.path}
                  local
                  commonBaseHash={file.base?.hash}
                  t={t}
                />
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
