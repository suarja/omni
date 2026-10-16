import type { GitScope } from "../../domain/inventory";
import { useI18n } from "../i18n";

export function ProjectGitInfo({ scopes }: { scopes: readonly GitScope[] }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div data-project-git>
      {scopes.length
        ? scopes.map((scope) => (
            <div key={scope.id}>
              <span>
                {scope.branch ?? t("projectView.notObserved")} ·{" "}
                {t(
                  scope.dirty === true
                    ? "projectView.dirty"
                    : scope.dirty === false
                      ? "projectView.clean"
                      : "projectView.notObserved",
                )}
              </span>
              {scope.head ? (
                <details>
                  <summary>{t("projectView.gitDetails")}</summary>
                  <span>
                    {scope.relativeRoot} · {scope.head.slice(0, 7)}
                  </span>
                </details>
              ) : null}
            </div>
          ))
        : t("projectView.notObserved")}
    </div>
  );
}
