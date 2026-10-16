import { useEffect, useState, type ReactElement } from "react";

import type { AuditFinding } from "../audit/audit-report";
import { useI18n } from "../i18n";
import type { Route } from "../navigation";
import { academyContextRoute, contextLinkForFinding } from "../learn/context-links";
import { useFeatures } from "../features";
import { explainFinding, type ExplainFindingApi } from "./explain-finding";

/**
 * A sentence under a finding, rendered only once Explain resolves one (Brief 35a). With the
 * `none` provider this renders nothing — the finding looks exactly as it does today.
 */
export function FindingExplanation({
  api,
  finding,
  onNavigateToRoute,
}: Readonly<{
  api?: ExplainFindingApi | null;
  finding: AuditFinding;
  onNavigateToRoute?: (route: Route) => void;
}>): ReactElement {
  const { language, t } = useI18n();
  const { features } = useFeatures();
  const [explanation, setExplanation] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setExplanation(undefined);
    void explainFinding(finding, api).then((value) => {
      if (active) setExplanation(value);
    });
    return () => {
      active = false;
    };
  }, [api, finding]);

  const contextLink = contextLinkForFinding(finding.kind);
  return (
    <span className="review-finding-explanation">
      {explanation ? <span>{explanation}</span> : null}
      {contextLink && features.learn && onNavigateToRoute ? (
        <button
          className="review-finding-why"
          data-testid={`finding-why-important-${finding.kind}`}
          onClick={(event) => {
            event.stopPropagation();
            onNavigateToRoute(academyContextRoute(contextLink, language));
          }}
          type="button"
        >
          {t("review.whyImportant")}
        </button>
      ) : null}
    </span>
  );
}
