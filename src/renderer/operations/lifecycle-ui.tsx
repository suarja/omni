import type { ReactElement } from "react";

import { Badge } from "../components/ui/Badge";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { useI18n } from "../i18n";
import type { ApplyGitPreview } from "../../shared/apply-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";

export function UnifiedDiff({ text, truncated }: Readonly<{ text: string; truncated: boolean }>): ReactElement {
  return (
    <div className="lifecycle-diff">
      <pre>
        {text.split("\n").map((line, index) => {
          const header = line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++");
          const tone = header ? "faint" : line.startsWith("+") ? "success" : line.startsWith("-") ? "danger" : "normal";
          return (
            <span className={`lifecycle-diff__line lifecycle-diff__line--${tone}`} key={`${index}-${line}`}>
              {line || " "}
              {index < text.split("\n").length - 1 ? "\n" : ""}
            </span>
          );
        })}
      </pre>
      {truncated ? <span className="lifecycle-diff__truncated">diff truncated</span> : null}
    </div>
  );
}

export function GitPreviewRow({ git }: Readonly<{ git: ApplyGitPreview }>): ReactElement {
  const { t } = useI18n();
  const label =
    git.mode === "commit"
      ? t("operations.lifecycle.gitCommit")
      : git.mode === "not-a-repository"
        ? t("operations.lifecycle.gitFilesOnly")
        : git.mode === "disabled"
          ? t("operations.lifecycle.gitDisabled")
          : t("operations.lifecycle.gitUnavailable");
  return (
    <ItemList variant="nested">
      <ListItem
        name={t("operations.lifecycle.git")}
        sub={label}
        side={git.head ? <code>{git.head.slice(0, 7)}</code> : undefined}
      />
    </ItemList>
  );
}

export function CommitBadge({ receipt }: Readonly<{ receipt: OperationReceipt }>): ReactElement {
  return receipt.git.commit ? (
    <Badge variant="count">{receipt.git.commit.slice(0, 7)}</Badge>
  ) : (
    <Badge variant="status" tone="neutral">
      No commit
    </Badge>
  );
}

export function receiptFileCount(receipt: OperationReceipt): number {
  return (
    receipt.files?.length ??
    receipt.actions.filter(
      (action) => action.status === "applied" && (action.kind === "write-file" || action.kind === "delete-file"),
    ).length
  );
}
