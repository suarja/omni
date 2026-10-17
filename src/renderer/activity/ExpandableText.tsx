import { useState, type ReactElement } from "react";
import type { TranslationFunction } from "../i18n";

export function ExpandableText({ text, t }: Readonly<{ text: string; t: TranslationFunction }>): ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <span>
      <span
        style={
          expanded
            ? undefined
            : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 3, overflow: "hidden" }
        }
      >
        {text}
      </span>{" "}
      <button
        aria-expanded={expanded}
        className="activity-inline-link"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        {expanded ? t("activity.taskShowLess") : t("activity.taskShowMore")}
      </button>
    </span>
  );
}
