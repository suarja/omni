import type { ReactElement } from "react";
import { pairDiffLines, type DiffLine } from "./diff-lines";

function Line({ line, side }: Readonly<{ line: DiffLine | undefined; side?: "before" | "after" }>): ReactElement {
  if (!line) {
    return (
      <div className="changes-diff-line is-empty" aria-hidden="true">
        {" "}
      </div>
    );
  }
  if (line.kind === "hunk") return <div className="changes-diff-hunk">{line.text}</div>;
  const number = side === "before" ? line.before : side === "after" ? line.after : (line.after ?? line.before);
  return (
    <div className={`changes-diff-line is-${line.kind}`}>
      <span className="changes-line-number">{number ?? ""}</span>
      <span aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>
      <code>{line.text || " "}</code>
    </div>
  );
}

export function DiffLines(
  props: Readonly<{
    lines: readonly DiffLine[];
    layout: "unified" | "split";
    beforeLabel: string;
    afterLabel: string;
    layoutLabel: string;
  }>,
): ReactElement {
  if (props.layout === "unified") {
    return (
      <div className="changes-diff-lines" aria-label={props.layoutLabel}>
        {props.lines.map((line, index) => (
          <Line key={index} line={line} />
        ))}
      </div>
    );
  }
  return (
    <div className="changes-split" aria-label={props.layoutLabel}>
      <div className="changes-split-head">
        <span>{props.beforeLabel}</span>
        <span>{props.afterLabel}</span>
      </div>
      {pairDiffLines(props.lines).map((line, index) =>
        line.kind === "hunk" ? (
          <div className="changes-diff-hunk" key={index}>
            {line.text}
          </div>
        ) : (
          <div className="changes-split-row" key={index}>
            <Line line={line.before} side="before" />
            <Line line={line.after} side="after" />
          </div>
        ),
      )}
    </div>
  );
}
