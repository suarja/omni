import type { ReactElement } from "react";

import type { DesktopApi } from "../../shared/ipc";
import type { AcademyKind, AcademyLanguage } from "../../shared/academy-ipc";
import type { Route } from "../navigation";
import { useI18n } from "../i18n";
import { LessonPage } from "./LessonPage";

export type LessonPanelProps = Readonly<{
  api?: DesktopApi | null;
  kind: AcademyKind;
  lang?: AcademyLanguage;
  onClose: () => void;
  onNavigateToRoute?: (route: Route) => void;
  slug: string;
}>;

export function LessonPanel({ api, kind, lang, onClose, onNavigateToRoute, slug }: LessonPanelProps): ReactElement {
  const { t } = useI18n();
  return (
    <aside
      aria-label={t("learn.contextPanel")}
      className="academy-lesson-panel"
      data-testid="lesson-panel"
      role="dialog"
    >
      <div className="academy-lesson-panel__head">
        <span>{t("learn.contextPanel")}</span>
        <button aria-label={t("learn.close")} className="academy-lesson-panel__close" onClick={onClose} type="button">
          {t("learn.close")}
        </button>
      </div>
      <div className="academy-lesson-panel__body">
        <LessonPage api={api} kind={kind} lang={lang} onNavigateToRoute={onNavigateToRoute ?? onClose} slug={slug} />
      </div>
    </aside>
  );
}
